import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import auctioneerService, { isEditableAuctioneerSetup, validateAuctioneerSuccessor, type AuctioneerReportType, type AuctioneerWorkItemSetup } from '../../services/auctioneerService';
import autoSaveService from '../../services/autoSaveService';
import { acceptedAuctioneerReportId, hasValidAuctioneerLotStructure } from './auctioneerFormPolicy';
import { useAppTheme } from '../../context/ThemeContext';
import NetInfo from '@react-native-community/netinfo';
import OfflineCaptureStore from '../../services/offlineCaptureStore';
import { captureContinuationDetails, type ContinuationDetails } from './continuationDetails';
import { actionableErrorMessage } from '../../services/connectivityService';
import durableContinuationService from '../../services/durableContinuationService';

export interface AuctioneerFormControl {
  setup: AuctioneerWorkItemSetup;
  accepted: boolean;
  restoreDraft: boolean;
  continuationDetails?: ContinuationDetails;
  draftIdToLoad?: string;
  continueQueued: (parentDraftId: string) => Promise<void>;
  acceptAndContinue: (response: unknown, draftId?: string, details?: ContinuationDetails, acceptanceSaved?: Promise<unknown>) => Promise<void>;
}

interface Props {
  visible: boolean;
  type: AuctioneerReportType;
  setup?: AuctioneerWorkItemSetup;
  draftIdToLoad?: string | null;
  onClose: () => void;
  onSetupChange?: (setup: AuctioneerWorkItemSetup) => void;
  children: (control?: AuctioneerFormControl) => React.ReactNode;
}

// The accepted-report gate lives outside the keyed form. Acceptance unmounts
// that form, so autosave cannot revive it and retries only open the next form.
export default function AuctioneerFormBoundary(props: Props) {
  const { colors } = useAppTheme();
  const { visible, type, setup, draftIdToLoad, onClose } = props;
  const setupWorkItemId = setup?.workItemId;
  const inputKey = `${setupWorkItemId || ''}:${draftIdToLoad || ''}`;
  const needsResolution = Boolean(setupWorkItemId || draftIdToLoad);
  const [resolved, setResolved] = useState<{ inputKey: string; setup?: AuctioneerWorkItemSetup; resumeUpload?: boolean }>();
  const [error, setError] = useState('');
  const [accepted, setAccepted] = useState<{ reportId?: string } | null>(null);
  const [usedSuccessor, setUsedSuccessor] = useState<AuctioneerWorkItemSetup | null>(null);
  const acceptedRef = useRef<{ reportId?: string } | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [restoreDraft, setRestoreDraft] = useState(true);
  const acceptedDraftRef = useRef<string | undefined>(undefined);
  const acceptedDetailsRef = useRef<ContinuationDetails | undefined>(undefined);
  const acceptanceSavedRef = useRef<Promise<unknown> | undefined>(undefined);
  const [continuationDetails, setContinuationDetails] = useState<ContinuationDetails>();
  const [continuationDraftId, setContinuationDraftId] = useState<string>();
  const [formEpoch, setFormEpoch] = useState(0);
  const [queuedContinuation, setQueuedContinuation] = useState<{ id: string; parentDraftId: string } | null>(null);
  const successorRef = useRef<{ setup: AuctioneerWorkItemSetup; owner: string } | null>(null);
  const resolutionOwnerRef = useRef<string | null>(null);
  const epochRef = useRef(0);

  useEffect(() => {
    const epoch = ++epochRef.current;
    const owner = OfflineCaptureStore.getOwnerId();
    resolutionOwnerRef.current = owner;
    // Incoming acknowledges onSetupChange by replacing its setup prop. That is
    // the same handoff, not a request to restore the already accepted draft.
    if (visible && owner && successorRef.current?.owner === owner && setupWorkItemId === successorRef.current.setup.workItemId) {
      setResolved({ inputKey, setup: successorRef.current.setup });
      return () => { epochRef.current += 1; };
    }
    successorRef.current = null;
    acceptedRef.current = null;
    acceptedDraftRef.current = undefined;
    acceptedDetailsRef.current = undefined;
    acceptanceSavedRef.current = undefined;
    setContinuationDetails(undefined);
    setContinuationDraftId(undefined);
    setQueuedContinuation(null);
    busyRef.current = false;
    setBusy(false);
    setAccepted(null);
    setUsedSuccessor(null);
    setError('');
    setResolved(undefined);
    setRestoreDraft(true);
    if (!visible || !needsResolution) return;
    const isCurrent = () => epoch === epochRef.current && Boolean(owner) && owner === OfflineCaptureStore.getOwnerId();
    void (async () => {
      try {
        const draft = draftIdToLoad ? await autoSaveService.getDraft(draftIdToLoad) : null;
        if (!isCurrent()) return;
        if (draftIdToLoad && !draft) throw new Error('The requested saved draft is unavailable. Reopen Drafts to select an existing draft; no empty report has been started.');
        const workItemId = setupWorkItemId || draft?.formData.auctioneerWorkItemId;
        if (setupWorkItemId && draft?.formData.auctioneerWorkItemId && draft.formData.auctioneerWorkItemId !== setupWorkItemId) {
          throw new Error('This draft belongs to a different Auctioneer work item.');
        }
        const network = await NetInfo.fetch();
        if (!isCurrent()) return;
        const offline = network.isConnected === false || network.isInternetReachable === false;
        const cached = draft?.formData.auctioneerSnapshot as AuctioneerWorkItemSetup | undefined;
        if (workItemId && offline && !cached) throw new Error('Connect once to download this Incoming assignment before using it offline. Your local draft has not been changed.');
        const current = workItemId ? offline ? cached : await auctioneerService.getSetup(workItemId) : undefined;
        if (current && (current.workItemId !== workItemId || current.reportType !== type)) throw new Error('The Auctioneer work item or report type does not match this form.');
        if (current && draft && (!hasValidAuctioneerLotStructure(current, draft.lots.map((lot) => ({
          id: lot.id, mode: lot.mode, files: [], extraFiles: [], coverIndex: 0,
        }))) || draft.type !== type || draft.formData.auctioneerWorkItemId !== current.workItemId ||
          draft.formData.contractNo !== current.contract.contractNo || draft.formData.clientSubmissionId !== current.clientSubmissionId)) {
          throw new Error('This draft no longer matches the claimed Auctioneer work item. Reopen Incoming to review it.');
        }
        if (!isCurrent()) return;
        setResolved({ inputKey, setup: current, resumeUpload: Boolean(current && draft && current.status === 'report_created' && current.canResumeUpload === true) });
      } catch (reason) {
        if (isCurrent()) setError(actionableErrorMessage(reason) || 'Unable to confirm this Incoming assignment. Check your connection and account access, then retry validation. Your draft has not been changed.');
      }
    })();
    return () => { epochRef.current += 1; };
  }, [visible, inputKey, needsResolution, reload, type, setupWorkItemId, draftIdToLoad]);

  const current = resolved?.inputKey === inputKey ? resolved.setup : undefined;
  const loading = needsResolution && resolved?.inputKey !== inputKey;
  const unavailable = current && !isEditableAuctioneerSetup(current, type) && !resolved?.resumeUpload;
  const renderedEpoch = epochRef.current;

  const continueQueued = async (parentDraftId: string) => {
    if (!current || busyRef.current || renderedEpoch !== epochRef.current) return;
    const owner = OfflineCaptureStore.getOwnerId(), epoch = epochRef.current;
    if (!owner || owner !== resolutionOwnerRef.current) return;
    const isCurrent = () => epoch === epochRef.current && owner === OfflineCaptureStore.getOwnerId();
    busyRef.current = true; setBusy(true); setError('');
    try {
      const intent = await durableContinuationService.forParent(parentDraftId);
      if (!isCurrent()) return;
      if (!intent) throw new Error('The saved Continue request is unavailable. Reopen the original draft; no next lot has been opened.');
      const pending = { id: intent.id, parentDraftId };
      setQueuedContinuation(pending);
      const result = await durableContinuationService.complete(intent.id);
      if (!isCurrent()) return;
      if ('parentNotStaged' in result) {
        // A verified missing native row is not a queued upload. Return to the
        // exact saved parent; the person must explicitly submit it again.
        setContinuationDraftId(result.draftId); setRestoreDraft(true);
        setFormEpoch(value => value + 1);
        setQueuedContinuation(null);
        setResolved({ inputKey, setup: result.setup });
        return;
      }
      successorRef.current = { setup: result.setup, owner };
      setContinuationDraftId(result.draftId); setContinuationDetails(undefined); setRestoreDraft(true);
      setQueuedContinuation(null);
      setResolved({ inputKey, setup: result.setup });
      busyRef.current = false; setBusy(false);
      props.onSetupChange?.(result.setup);
    } catch (reason) {
      if (isCurrent()) setError(actionableErrorMessage(reason) || 'The next lot could not be confirmed. Retry this Continue request; its parent upload will not be submitted again.');
    } finally { if (isCurrent()) { busyRef.current = false; setBusy(false); } }
  };

  const continueAccepted = async (response?: unknown, draftId?: string, details?: ContinuationDetails, acceptanceSaved?: Promise<unknown>) => {
    if (!current || busyRef.current || renderedEpoch !== epochRef.current) return;
    const owner = OfflineCaptureStore.getOwnerId();
    if (!owner || owner !== resolutionOwnerRef.current) return;
    if (!acceptedRef.current) {
      acceptedDraftRef.current = draftId || draftIdToLoad || undefined;
      acceptedDetailsRef.current = captureContinuationDetails(details);
      acceptanceSavedRef.current = acceptanceSaved;
      acceptedRef.current = { reportId: acceptedAuctioneerReportId(response) || current.reportId || undefined };
      setAccepted(acceptedRef.current);
    }
    busyRef.current = true;
    setBusy(true);
    setError('');
    const epoch = epochRef.current;
    const isCurrent = () => epoch === epochRef.current && owner === OfflineCaptureStore.getOwnerId();
    try {
      let reportId = acceptedRef.current?.reportId;
      if (!reportId) {
        const observed = await auctioneerService.getSetup(current.workItemId);
        if (!isCurrent()) return;
        if (observed.workItemId !== current.workItemId || observed.reportType !== current.reportType ||
            observed.contract.id !== current.contract.id || observed.contract.contractNo !== current.contract.contractNo ||
            (Boolean(current.contract.eventId) && observed.contract.eventId !== current.contract.eventId)) throw new Error('The server returned a different assignment. Keep this draft and reopen Incoming to review the accepted report.');
        if (observed.canResumeUpload === true) throw new Error('The server has not confirmed upload acceptance yet. Keep the original draft; retry this check before starting a new lot.');
        reportId = observed.reportId || undefined;
        if (!reportId) throw new Error('The upload was accepted, but its report ID is not available yet. Retry this handoff; do not upload again.');
        acceptedRef.current = { reportId };
        if (epoch === epochRef.current) setAccepted(acceptedRef.current);
      }
      if (!isCurrent()) return;
      const next = await auctioneerService.continueWorkItem(current.workItemId, reportId);
      if (!isCurrent()) return;
      if (next.workItemId !== current.workItemId && next.reportType === current.reportType &&
          next.contract.id === current.contract.id && next.contract.contractNo === current.contract.contractNo &&
          (next.reportId || ['report_created', 'sent', 'abandoned'].includes(next.status || ''))) {
        setUsedSuccessor(next);
        setError(next.reportId ? `The next work item already has report ${next.reportId}. Close this view and reopen Incoming or Reports to review it. Your accepted report has not been uploaded again.` : 'The next work item is no longer available. Close this view and reopen Incoming to review its status. Your accepted report is safe.');
        return;
      }
      validateAuctioneerSuccessor(current, next);
      if (!isCurrent()) return;
      const oldDraftId = acceptedDraftRef.current;
      const saved = acceptanceSavedRef.current;
      successorRef.current = { setup: next, owner };
      setContinuationDetails(acceptedDetailsRef.current);
      acceptedRef.current = null;
      setAccepted(null);
      setRestoreDraft(false);
      setResolved({ inputKey, setup: next });
      busyRef.current = false;
      setBusy(false);
      props.onSetupChange?.(next);
      // Neither local receipt storage nor old metadata cleanup blocks new
      // capture. Failed persistence keeps the original inventory recoverable.
      if (oldDraftId && saved) void saved.then(() => {
        if (OfflineCaptureStore.getOwnerId() === owner) return autoSaveService.removeDraftRecordOnly(oldDraftId);
      }).catch(() => undefined);
    } catch (reason) {
      if (isCurrent()) setError(actionableErrorMessage(reason) || 'Could not confirm the next form. Check your connection and account access, then retry opening it. Your accepted report is safe and will not be uploaded again.');
    } finally {
      if (epoch === epochRef.current) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  if (!visible) return null;
  const showForm = !loading && !unavailable && !accepted && !queuedContinuation;
  const showGate = loading || Boolean(unavailable) || Boolean(accepted) || Boolean(queuedContinuation);
  const resumeOriginalDraft = Boolean(unavailable && current?.canResumeUpload === true);
  const buttonStyle = [styles.button, { borderColor: colors.borderStrong, backgroundColor: colors.surface }];
  return <>
    {showForm ? <React.Fragment key={`${current?.workItemId || 'ordinary'}:${formEpoch}`}>{props.children(current ? {
      setup: current, accepted: Boolean(accepted), restoreDraft, continuationDetails, draftIdToLoad: continuationDraftId,
      continueQueued, acceptAndContinue: continueAccepted,
    } : undefined)}</React.Fragment> : null}
    {showGate ? <Modal visible onRequestClose={() => { if (!busy) onClose(); }}>
      <SafeAreaView style={[styles.page, { backgroundColor: colors.background }]}>
        <ScrollView testID="auctioneer-handoff-scroll" contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          <View style={styles.card}>
            <Text style={[styles.title, { color: colors.text }]}>{queuedContinuation ? 'Opening the next lot' : usedSuccessor ? 'Next work item already used' : resumeOriginalDraft ? 'Resume the original draft' : accepted ? 'Report accepted' : current?.reportId ? 'Report already created' : 'Auctioneer contract'}</Text>
            <Text accessibilityLiveRegion="polite" style={[styles.message, { color: colors.textSecondary }]}>{error || (queuedContinuation ? 'Checking the saved parent upload and reserving its independent next lot. Upload progress remains in the upload bar; this is not an acceptance receipt.' : resumeOriginalDraft ? 'This upload has not been accepted yet. Close this view and reopen its original saved draft to resume the same photos and submission. A blank form cannot replace it.' : accepted ? 'Starting a fresh lot for the same contract. Your report continues processing.' : unavailable ? 'This work item is no longer an editable claim. Reopen Incoming to review its report or assignment.' : 'Validating the current claim and saved draft…')}</Text>
            {busy || (loading && !error) ? <ActivityIndicator color={colors.accent} accessibilityLabel="Checking Auctioneer work item" /> : null}
            {error && loading ? <TouchableOpacity accessibilityRole="button" onPress={() => setReload((value) => value + 1)} style={buttonStyle}><Text style={{ color: colors.text }}>Retry validation</Text></TouchableOpacity> : null}
            {accepted && !busy && !usedSuccessor ? <TouchableOpacity accessibilityRole="button" onPress={() => void continueAccepted()} style={buttonStyle}><Text style={{ color: colors.text }}>Retry new lot</Text></TouchableOpacity> : null}
            {queuedContinuation && !busy ? <TouchableOpacity accessibilityRole="button" onPress={() => void continueQueued(queuedContinuation.parentDraftId)} style={buttonStyle}><Text style={{ color: colors.text }}>Retry next lot</Text></TouchableOpacity> : null}
            {!accepted && !resumeOriginalDraft && current?.reportId && current.status !== 'abandoned' ? <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={() => void continueAccepted()} style={buttonStyle}><Text style={{ color: colors.text }}>Continue with new lot</Text></TouchableOpacity> : null}
            <TouchableOpacity accessibilityRole="button" disabled={busy} onPress={onClose} style={buttonStyle}><Text style={{ color: colors.text }}>Close</Text></TouchableOpacity>
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal> : null}
  </>;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  scrollContent: { flexGrow: 1, justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 560, alignSelf: 'center', gap: 16 },
  title: { fontSize: 24, fontWeight: '700' },
  message: { fontSize: 16, lineHeight: 24 },
  button: { minHeight: 48, padding: 12, borderWidth: 1, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
});
