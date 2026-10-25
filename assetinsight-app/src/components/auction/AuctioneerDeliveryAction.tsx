import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import KeyboardSafeViewport from '../KeyboardSafeViewport';
import { useAuth } from '../../context/AuthContext';
import { useAppTheme } from '../../context/ThemeContext';
import { getAuthOperationEpoch } from '../../services/authSessionOperation';
import auctioneerDeliveryService, {
  auctioneerDeliveryErrorMessage,
  sameDeliveryIdentity,
  type AuctioneerDeliverySummary,
  type AuctioneerSendDeliveryInput,
} from '../../services/auctioneerDeliveryService';

interface Props {
  delivery: AuctioneerDeliverySummary;
  onUpdated: (delivery: AuctioneerDeliverySummary) => void;
}

function sameManifest(a: AuctioneerDeliverySummary, b: AuctioneerDeliverySummary) {
  return (
    a.destination === b.destination &&
    (a.opTaskDescription || '') === (b.opTaskDescription || '') &&
    a.completeContract === b.completeContract
  );
}

function canSend(delivery: AuctioneerDeliverySummary) {
  return delivery.canSend === true && (delivery.state === 'ready' || delivery.state === 'failed');
}

function statusText(delivery: AuctioneerDeliverySummary) {
  switch (delivery.state) {
    case 'not_ready':
      return delivery.reportModel === 'LotListing'
        ? 'Generate the final listing before sending it to Auctioneer.'
        : 'Approval and release are required before sending this report to Auctioneer.';
    case 'ready':
      return delivery.canSend === true
        ? 'Ready to send to Auctioneer.'
        : 'Sending is not available. Refresh Reports to check your assignment.';
    case 'queued':
      return 'Auctioneer delivery queued. You can continue working.';
    case 'sending':
      return 'Sending to Auctioneer. You can continue working.';
    case 'failed':
      return delivery.canSend === true
        ? 'Delivery did not finish. Retry continues the same delivery.'
        : 'Delivery needs attention. Refresh Reports to check readiness and your assignment.';
    case 'needs_reconciliation':
      return 'Auctioneer has not confirmed whether this lot was created. Open this report on the website to check and reconcile the existing delivery before sending again.';
    case 'sent':
      if (delivery.contractCloseUserStatus === 'revoked')
        return 'Sent to Auctioneer. Your contract assignment was revoked.';
      if (delivery.contractTaskCompleted) return 'Sent to Auctioneer. The contract is complete.';
      if (delivery.contractClosedAt && delivery.contractCompletionScope === 'user')
        return 'Sent to Auctioneer. Your part of this contract is closed.';
      return 'Sent to Auctioneer.';
  }
}

/** A report card can prepare a delivery, but only explicit confirmation can send it. */
export default function AuctioneerDeliveryAction({ delivery, onUpdated }: Props) {
  const { user } = useAuth();
  const ownerId = user ? String(user._id || (user as { id?: string }).id || '') : '';
  const { colors } = useAppTheme();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [destination, setDestination] =
    useState<AuctioneerSendDeliveryInput['destination']>('LottingBoard');
  const [note, setNote] = useState('');
  const [completeContract, setCompleteContract] = useState(false);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const revision = useRef(0);
  const owner = useRef(ownerId);
  const currentDelivery = useRef(delivery);
  const updated = useRef(onUpdated);
  const openedOwner = useRef('');
  const openedEpoch = useRef(-1);
  const openedConfiguration = useRef('');
  owner.current = ownerId;
  currentDelivery.current = delivery;
  updated.current = onUpdated;

  const identity = JSON.stringify([
    delivery.workItemId,
    delivery.reportId,
    delivery.reportModel,
    delivery.reportType,
    delivery.contractId,
    delivery.accessRevision,
  ]);
  const configuration = JSON.stringify([
    delivery.state,
    delivery.canSend,
    delivery.destination,
    delivery.opTaskDescription,
    delivery.completeContract,
    delivery.canCompleteContract,
    delivery.contractCompletionScope,
  ]);
  const currentConfiguration = useRef(configuration);
  currentConfiguration.current = configuration;
  useEffect(() => {
    revision.current += 1;
    busyRef.current = false;
    setBusy(false);
    setOpen(false);
    setError('');
  }, [identity, ownerId]);
  useEffect(() => {
    // A refreshed retry manifest or capability must never silently replace the choices confirmed here.
    if (openedConfiguration.current !== configuration) setOpen(false);
  }, [configuration]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      revision.current += 1;
    };
  }, []);

  const retrying = delivery.state === 'failed';
  const eligible = !!ownerId && canSend(delivery);
  const visible =
    open &&
    openedOwner.current === ownerId &&
    openedEpoch.current === getAuthOperationEpoch() &&
    openedConfiguration.current === configuration;

  const openConfirmation = () => {
    if (!eligible || busyRef.current || ownerId !== owner.current) return;
    openedOwner.current = ownerId;
    openedEpoch.current = getAuthOperationEpoch();
    openedConfiguration.current = configuration;
    setDestination(delivery.destination || 'LottingBoard');
    setNote(delivery.opTaskDescription || '');
    // Closing is always opt-in for a new delivery. A retry must retain its saved manifest.
    setCompleteContract(retrying ? delivery.completeContract === true : false);
    setError('');
    setOpen(true);
  };

  const close = () => {
    if (!busyRef.current) setOpen(false);
  };

  const confirm = async () => {
    if (busyRef.current || !visible || !eligible) return;
    if (
      openedOwner.current !== owner.current ||
      openedEpoch.current !== getAuthOperationEpoch() ||
      openedConfiguration.current !== currentConfiguration.current
    ) {
      setOpen(false);
      return;
    }
    const snapshot = delivery;
    const savedRetry = snapshot.state === 'failed';
    const sendDestination = savedRetry ? snapshot.destination : destination;
    const sendNote = savedRetry ? snapshot.opTaskDescription || '' : note.trim();
    const requestsClose = savedRetry ? snapshot.completeContract === true : completeContract;
    if (sendDestination !== 'LottingBoard' && sendDestination !== 'OpToDoBoard') {
      setError(
        'The saved delivery destination is missing. Open this report on the website to check it before retrying.'
      );
      return;
    }
    if (savedRetry && typeof snapshot.completeContract !== 'boolean') {
      setError(
        'The saved delivery close choice is missing. Open this report on the website to check it before retrying.'
      );
      return;
    }
    if (sendDestination === 'OpToDoBoard' && !sendNote.trim()) {
      setError('Add an Operations To-Do note before sending.');
      return;
    }
    if (sendNote.length > 2000) {
      setError('Keep the Operations To-Do note within 2,000 characters.');
      return;
    }
    const epoch = getAuthOperationEpoch();
    const expectedOwner = ownerId;
    const token = ++revision.current;
    const hasScope = () =>
      mounted.current &&
      token === revision.current &&
      expectedOwner === owner.current &&
      epoch === getAuthOperationEpoch() &&
      sameDeliveryIdentity(snapshot, currentDelivery.current);
    const isCurrent = () => hasScope() && configuration === currentConfiguration.current;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      // A confirmation never borrows readiness or an access revision from another report.
      const fresh = await auctioneerDeliveryService.getDelivery(snapshot.workItemId, snapshot);
      if (!isCurrent()) return;
      if (
        !sameDeliveryIdentity(snapshot, fresh) ||
        !canSend(fresh) ||
        fresh.state !== snapshot.state ||
        currentDelivery.current.state !== snapshot.state ||
        (savedRetry && !sameManifest(snapshot, fresh)) ||
        (requestsClose &&
          (fresh.canCompleteContract !== true ||
            fresh.contractCompletionScope !== snapshot.contractCompletionScope))
      ) {
        if (sameDeliveryIdentity(snapshot, fresh)) updated.current(fresh);
        setError(
          'This delivery has changed. Close this window and refresh Reports before continuing. Nothing new was sent.'
        );
        return;
      }
      const result = await auctioneerDeliveryService.sendDelivery(fresh, {
        destination: sendDestination,
        ...(sendDestination === 'OpToDoBoard' ? { opTaskDescription: sendNote } : {}),
        completeContract: savedRetry
          ? snapshot.completeContract === true
          : fresh.canCompleteContract === true && completeContract,
      });
      if (!isCurrent()) return;
      updated.current(result);
      setOpen(false);
    } catch (cause) {
      if (isCurrent()) setError(auctioneerDeliveryErrorMessage(cause));
    } finally {
      if (hasScope()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  return (
    <View style={[styles.card, { borderColor: colors.border }]}>
      <Text accessibilityLiveRegion="polite" style={[styles.copy, { color: colors.textSecondary }]}>
        {statusText(delivery)}
      </Text>
      {(delivery.state === 'failed' || delivery.state === 'needs_reconciliation') &&
      delivery.error ? (
        <Text style={[styles.copy, { color: colors.danger }]}>
          {auctioneerDeliveryErrorMessage({ response: { data: { message: delivery.error } } })}
        </Text>
      ) : null}
      {delivery.state === 'ready' ||
      delivery.state === 'failed' ||
      delivery.state === 'not_ready' ? (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={retrying ? 'Retry Auctioneer delivery' : 'Send to Auctioneer'}
          accessibilityState={{ disabled: !eligible || busy }}
          disabled={!eligible || busy}
          onPress={openConfirmation}
          style={[
            styles.button,
            { backgroundColor: colors.accent, opacity: !eligible || busy ? 0.5 : 1 },
          ]}>
          <Text style={[styles.buttonText, { color: colors.accentText }]}>
            {retrying ? 'Retry delivery' : 'Send to Auctioneer'}
          </Text>
        </TouchableOpacity>
      ) : null}
      <Modal
        visible={visible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={close}>
        <KeyboardSafeViewport style={{ backgroundColor: colors.background }}>
          <SafeAreaView style={styles.modal}>
            <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
              <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>
                {retrying ? 'Retry Auctioneer delivery' : 'Send to Auctioneer'}
              </Text>
              <Text style={[styles.copy, { color: colors.textSecondary }]}>
                Contract {delivery.contractNo || 'report'} sends final listing data and photos.
                Generated files remain in Asset Insight.
              </Text>
              {retrying ? (
                <Text style={[styles.copy, { color: colors.textSecondary }]}>
                  A retry keeps the original destination, note and contract-close choice. It
                  continues the same delivery.
                </Text>
              ) : null}
              {(['LottingBoard', 'OpToDoBoard'] as const).map((choice) => (
                <TouchableOpacity
                  key={choice}
                  accessibilityRole="radio"
                  accessibilityLabel={
                    choice === 'LottingBoard' ? 'Posting Board / Lien Tracker' : 'Operations To-Do'
                  }
                  accessibilityState={{
                    checked: destination === choice,
                    disabled: retrying || busy,
                  }}
                  disabled={retrying || busy}
                  onPress={() => setDestination(choice)}
                  style={[
                    styles.option,
                    {
                      borderColor: destination === choice ? colors.accent : colors.border,
                      backgroundColor: destination === choice ? colors.accentSoft : colors.surface,
                    },
                  ]}>
                  <Text style={[styles.optionText, { color: colors.text }]}>
                    {destination === choice ? '● ' : '○ '}
                    {choice === 'LottingBoard'
                      ? 'Posting Board / Lien Tracker'
                      : 'Operations To-Do'}
                  </Text>
                </TouchableOpacity>
              ))}
              {destination === 'OpToDoBoard' ? (
                <View style={styles.noteGroup}>
                  <Text style={[styles.copy, { color: colors.text }]}>
                    Operations To-Do note (required)
                  </Text>
                  <TextInput
                    accessibilityLabel="Operations To-Do note"
                    value={note}
                    onChangeText={setNote}
                    editable={!retrying && !busy}
                    maxLength={2000}
                    multiline
                    style={[
                      styles.note,
                      {
                        color: colors.text,
                        backgroundColor: colors.surface,
                        borderColor: colors.border,
                      },
                    ]}
                  />
                  <Text style={[styles.copy, { color: colors.textMuted }]}>
                    {note.length}/2,000 characters
                  </Text>
                </View>
              ) : null}
              {delivery.canCompleteContract === true || (retrying && delivery.completeContract) ? (
                <TouchableOpacity
                  accessibilityRole="checkbox"
                  accessibilityLabel={
                    delivery.contractCompletionScope === 'user'
                      ? 'Close my part after sending'
                      : 'Complete the contract after sending'
                  }
                  accessibilityState={{ checked: completeContract, disabled: busy || retrying }}
                  disabled={busy || retrying}
                  onPress={() => setCompleteContract((value) => !value)}
                  style={[
                    styles.option,
                    { borderColor: colors.border, backgroundColor: colors.surface },
                  ]}>
                  <Text style={[styles.optionText, { color: colors.text }]}>
                    {completeContract ? '☑ ' : '☐ '}
                    {delivery.contractCompletionScope === 'user'
                      ? 'Close my part after sending'
                      : 'Complete the contract after sending'}
                  </Text>
                  <Text style={[styles.copy, { color: colors.textSecondary }]}>
                    {delivery.contractCompletionScope === 'user'
                      ? 'Only your assigned part closes. Other people can continue their work.'
                      : 'This closes the contract task after delivery succeeds.'}
                  </Text>
                </TouchableOpacity>
              ) : null}
              {!!error ? (
                <Text accessibilityRole="alert" style={[styles.copy, { color: colors.danger }]}>
                  {error}
                </Text>
              ) : null}
              {busy ? (
                <ActivityIndicator
                  accessibilityLabel="Checking and queuing Auctioneer delivery"
                  color={colors.accent}
                />
              ) : null}
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Confirm send to Auctioneer"
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={() => void confirm()}
                style={[
                  styles.button,
                  { backgroundColor: colors.accent, opacity: busy ? 0.5 : 1 },
                ]}>
                <Text style={[styles.buttonText, { color: colors.accentText }]}>
                  {busy ? 'Checking delivery…' : retrying ? 'Confirm retry' : 'Confirm send'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityLabel="Cancel Auctioneer delivery"
                accessibilityState={{ disabled: busy }}
                disabled={busy}
                onPress={close}
                style={[
                  styles.button,
                  { backgroundColor: colors.surfaceMuted, opacity: busy ? 0.5 : 1 },
                ]}>
                <Text style={[styles.buttonText, { color: colors.text }]}>Cancel</Text>
              </TouchableOpacity>
            </ScrollView>
          </SafeAreaView>
        </KeyboardSafeViewport>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: 8, paddingTop: 12, borderTopWidth: 1 },
  copy: { fontSize: 13, lineHeight: 20, flexShrink: 1 },
  button: {
    minHeight: 44,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { fontSize: 14, lineHeight: 20, fontWeight: '700', textAlign: 'center' },
  modal: { flex: 1 },
  body: { padding: 20, gap: 16, width: '100%', maxWidth: 640, alignSelf: 'center' },
  title: { fontSize: 23, lineHeight: 30, fontWeight: '700' },
  option: { minHeight: 48, borderWidth: 1, borderRadius: 8, padding: 12, gap: 8 },
  optionText: { fontSize: 14, lineHeight: 22, fontWeight: '600', flexShrink: 1 },
  noteGroup: { gap: 8 },
  note: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    minHeight: 112,
    fontSize: 15,
    lineHeight: 22,
    textAlignVertical: 'top',
  },
});
