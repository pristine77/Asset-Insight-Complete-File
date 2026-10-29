import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import UploadContinuationPanel from '../UploadContinuationPanel';
import durableContinuationService from '../../services/durableContinuationService';
import OfflineCaptureStore from '../../services/offlineCaptureStore';
import { getAuthOperationEpoch } from '../../services/authSessionOperation';
import { auctioneerErrorMessage, auctioneerReopenErrorMessage, auctioneerReopenReason } from '../../services/auctioneerErrors';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { useAppTheme, type AppThemeColors } from '../../context/ThemeContext';
import auctioneerService, {
  type AuctioneerIncomingItem,
  type AuctioneerReportType,
  type AuctioneerWorkItemSetup,
  isEditableAuctioneerSetup,
} from '../../services/auctioneerService';
import AssetFormSheet from '../forms/AssetFormSheet';
import LotListingFormSheet from '../forms/LotListingFormSheet';
import AuctioneerReopenAction from './AuctioneerReopenAction';

interface Props {
  refreshVersion?: number;
  onOpenReport: (reportId: string, reportType: AuctioneerReportType) => void;
}

export function retainAuctioneerAccessRevision(
  item: AuctioneerIncomingItem,
  receiptRevision?: string | number
): AuctioneerIncomingItem {
  return { ...item, accessRevision: item.accessRevision ?? receiptRevision };
}

/** Matches the web queue: sent work is Completed; every other state stays Outstanding. */
export default function AuctioneerIncoming({ refreshVersion = 0, onOpenReport }: Props) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [items, setItems] = useState<AuctioneerIncomingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [queueTab, setQueueTab] = useState<'outstanding' | 'completed'>('outstanding');
  const [unavailableMessage, setUnavailableMessage] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [permissionRevision, setPermissionRevision] = useState(0);
  const [opening, setOpening] = useState<string | null>(null);
  const [setup, setSetup] = useState<AuctioneerWorkItemSetup | null>(null);
  const [draftId, setDraftId] = useState<string>();
  const readRevision = useRef(0);
  const mounted = useRef(true);
  const claimLock = useRef(false);
  const uncertainReopens = useRef(new Set<string>());
  const receivedRevisions = useRef(new Map<string, string | number>());
  const queueOwner = useRef(OfflineCaptureStore.getOwnerId());

  const load = useCallback(async (refresh = false) => {
    const revision = ++readRevision.current;
    const owner = OfflineCaptureStore.getOwnerId();
    const authEpoch = getAuthOperationEpoch();
    if (owner !== queueOwner.current) {
      queueOwner.current = owner;
      receivedRevisions.current.clear();
      uncertainReopens.current.clear();
      setItems([]);
      setNotice('');
    }
    const isCurrent = () =>
      mounted.current &&
      revision === readRevision.current &&
      owner === OfflineCaptureStore.getOwnerId() &&
      authEpoch === getAuthOperationEpoch();
    setError('');
    setPermissionRevision((value) => value + 1);
    if (refresh) setRefreshing(true);
    else setLoading(true);
    try {
      const status = await auctioneerService.getStatus();
      if (!isCurrent()) return false;
      const available = status.enabled && status.configured;
      setEnabled(available);
      setUnavailableMessage(
        !status.enabled
          ? 'Incoming is currently disabled for your account. Contact your administrator.'
          : !status.configured
            ? 'Incoming needs an Auctioneer connection. Contact your administrator to configure it.'
            : ''
      );
      if (!available) {
        setItems([]);
        return false;
      }
      const next = await auctioneerService.getIncoming(refresh);
      if (!isCurrent()) return false;
      setItems(next.map((item) => retainAuctioneerAccessRevision(
        item,
        receivedRevisions.current.get(item.contractId)
      )));
      uncertainReopens.current.clear();
      setPermissionRevision((value) => value + 1);
      return true;
    } catch (cause) {
      if (isCurrent()) {
        setError(
          auctioneerErrorMessage(
            cause,
            'Could not load assigned contracts. Check your connection and retry.'
          )
        );
      }
      return false;
    } finally {
      if (isCurrent()) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load(refreshVersion > 0);
    return () => {
      mounted.current = false;
      readRevision.current += 1;
    };
  }, [load, refreshVersion]);

  const open = useCallback(
    async (item: AuctioneerIncomingItem, reportType: AuctioneerReportType) => {
      if (claimLock.current || uncertainReopens.current.has(item.contractId) || (item.status !== 'available' && !item.claimedByMe)) return;
      claimLock.current = true;
      const owner = OfflineCaptureStore.getOwnerId();
      const authEpoch = getAuthOperationEpoch();
      const isCurrent = () =>
        mounted.current &&
        OfflineCaptureStore.getOwnerId() === owner &&
        getAuthOperationEpoch() === authEpoch;
      setOpening(item.cycleKey);
      setError('');
      try {
        const next = item.workItemId
          ? await auctioneerService.getSetup(item.workItemId)
          : await auctioneerService.claim(item.cycleKey, reportType);
        if (!isCurrent()) return;
        if (next.reportId) onOpenReport(next.reportId, next.reportType);
        else {
          if (!isEditableAuctioneerSetup(next, reportType)) {
            throw new Error(
              'This work is no longer available for a new capture. Refresh Incoming to check its report.'
            );
          }
          const savedDraft = owner
            ? await durableContinuationService.successorDraft(next.workItemId)
            : undefined;
          if (!isCurrent()) return;
          setDraftId(savedDraft);
          setSetup(next); // The boundary rechecks claimed/unused state.
        }
      } catch (cause) {
        if (isCurrent())
          setError(
            auctioneerErrorMessage(
              cause,
              'Could not open this contract. Refresh Incoming and try again.'
            )
          );
      } finally {
        claimLock.current = false;
        if (isCurrent()) setOpening(null);
      }
    },
    [onOpenReport]
  );

  const reopen = useCallback(async (item: AuctioneerIncomingItem, confirmationRecovery: boolean) => {
    if (claimLock.current || (uncertainReopens.current.has(item.contractId) && !confirmationRecovery)) return;
    claimLock.current = true;
    const owner = OfflineCaptureStore.getOwnerId();
    const epoch = getAuthOperationEpoch();
    const isCurrent = () => mounted.current && owner === OfflineCaptureStore.getOwnerId() && epoch === getAuthOperationEpoch();
    setOpening(item.cycleKey);
    setNotice('');
    setError('');
    let mutationStarted = false;
    try {
      const permission = await auctioneerService.getCapturePermission(item.contractId);
      if (!isCurrent()) return;
      if (confirmationRecovery ? permission.confirmationPending !== true : permission.reopen.allowed !== true) {
        setError(permission.confirmationPending
          ? 'The previous Re-Open needs confirmation. Use Check Re-Open to check its outcome.'
          : auctioneerReopenReason(permission.reopen.reason) || 'This contract is no longer available for Re-Open. Refresh Incoming to check its status.');
        return;
      }
      // Re-check immediately before the mutation; visibility alone never grants capture access.
      uncertainReopens.current.add(item.contractId);
      mutationStarted = true;
      const receipt = await auctioneerService.reopenContract(item.contractId);
      if (!isCurrent()) return;
      receivedRevisions.current.set(item.contractId, receipt.accessRevision);
      setItems((current) => current.map((row) => row.contractId === item.contractId ? { ...row, accessRevision: receipt.accessRevision } : row));
      const refreshed = await load(true);
      if (!isCurrent()) return;
      if (refreshed) {
        setQueueTab('outstanding');
        setNotice(receipt.alreadyOpen
          ? 'This contract is already open. Choose Asset or Lot Listing in Outstanding to add more lots.'
          : 'Contract re-opened. Choose Asset or Lot Listing in Outstanding to add more lots.');
      } else setNotice('Re-Open is confirmed. Refresh Incoming to load the available work.');
    } catch (cause) {
      if (!isCurrent()) return;
      if (mutationStarted) uncertainReopens.current.add(item.contractId);
      setError(auctioneerReopenErrorMessage(cause));
    } finally {
      claimLock.current = false;
      if (isCurrent()) {
        setOpening(null);
        setPermissionRevision((value) => value + 1);
      }
    }
  }, [load]);

  const close = useCallback(() => {
    setSetup(null);
    setDraftId(undefined);
    void load(true);
  }, [load]);
  const nextForm = useCallback(
    (next: AuctioneerWorkItemSetup) => {
      setSetup(next);
      void load(true);
    },
    [load]
  );

  const renderItem = useCallback(
    ({ item }: { item: AuctioneerIncomingItem }) => {
      const busy = opening !== null;
      const claimedElsewhere = item.status !== 'available' && !item.claimedByMe;
      const unavailable = claimedElsewhere || item.status === 'abandoned';
      return (
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.title}>Contract {item.contractNo}</Text>
            {opening === item.cycleKey && (
              <ActivityIndicator accessibilityLabel="Opening contract" color={colors.accent} />
            )}
          </View>
          {!!item.customerName && <Text style={styles.meta}>{item.customerName}</Text>}
          {!!item.consignorName && <Text style={styles.meta}>Consignor: {item.consignorName}</Text>}
          {!!item.salespersonName && (
            <Text style={styles.meta}>Salesperson: {item.salespersonName}</Text>
          )}
          {!!item.description && <Text style={styles.meta}>Description: {item.description}</Text>}
          {!!item.eventTitle && <Text style={styles.meta}>{item.eventTitle}</Text>}
          {!!item.location && <Text style={styles.meta}>{item.location}</Text>}
          <Text style={styles.meta}>
            {item.kind === 'scheduleA'
              ? `${item.lotCount} imported lots`
              : item.proposalList
                ? // owner 2026-10-28: lotCount is this user's listed items still to capture.
                  `Proposal list · ${item.lotCount} listed ${item.lotCount === 1 ? 'item' : 'items'} to capture`
                : 'New lot capture'}
          </Text>
          <Text style={styles.status}>
            {item.status === 'sent'
              ? 'Sent to Auctioneer'
              : item.status === 'available'
                ? 'Available'
                : item.status === 'claimed'
                  ? 'Capture in progress'
                  : item.status === 'abandoned'
                    ? 'Claim released'
                    : 'Report created'}
          </Text>
          {unavailable ? (
            <Text style={styles.meta}>This work is not available to open.</Text>
          ) : (
            <View style={styles.actions}>
              {item.status === 'available' ? (
                (['asset', 'lotListing'] as const).map((type) => (
                  <TouchableOpacity
                    key={type}
                    accessibilityRole="button"
                    accessibilityLabel={`Open contract ${item.contractNo} as ${type === 'asset' ? 'Asset' : 'Lot Listing'}`}
                    accessibilityState={{ disabled: busy }}
                    disabled={busy}
                    style={[styles.button, busy && styles.disabled]}
                    onPress={() => void open(item, type)}>
                    <Text style={styles.buttonText}>
                      {type === 'asset' ? 'Asset Listing' : 'Lot Listing'}
                    </Text>
                  </TouchableOpacity>
                ))
              ) : (
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={`Open contract ${item.contractNo}`}
                  accessibilityState={{ disabled: busy }}
                  disabled={busy}
                  style={[styles.button, busy && styles.disabled]}
                  onPress={() => void open(item, item.selectedReportType || 'asset')}>
                  <Text style={styles.buttonText}>
                    {item.status === 'claimed' ? 'Continue capture' : 'View report'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          )}
          <AuctioneerReopenAction
            key={`${item.contractId}:${permissionRevision}`}
            contractId={item.contractId}
            contractNo={item.contractNo}
            busy={busy}
            blocked={uncertainReopens.current.has(item.contractId)}
            onReopen={(recovery) => void reopen(item, recovery)}
          />
        </View>
      );
    },
    [colors.accent, open, opening, permissionRevision, reopen, styles]
  );

  const completedItems = items.filter((item) => item.status === 'sent');
  const outstandingItems = items.filter((item) => item.status !== 'sent');
  const visibleItems = queueTab === 'completed' ? completedItems : outstandingItems;

  return (
    <View style={styles.container}>
      <FlatList
        data={enabled ? visibleItems : []}
        keyExtractor={(item) => item.workItemId || item.cycleKey}
        renderItem={renderItem}
        contentContainerStyle={styles.content}
        initialNumToRender={8}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load(true)}
            tintColor={colors.accent}
          />
        }
        ListHeaderComponent={
          <View style={styles.intro}>
            <Text style={styles.heading}>Assigned contract queue</Text>
            <Text style={styles.meta}>
              Open an Asset or Lot Listing. Create Lot & Continue keeps this contract for your next
              report.
            </Text>
            <View style={styles.tabs} accessibilityRole="tablist">
              {(['outstanding', 'completed'] as const).map((tab) => (
                <TouchableOpacity
                  key={tab}
                  accessibilityRole="tab"
                  accessibilityLabel={`${tab === 'outstanding' ? 'Outstanding' : 'Completed'} contracts`}
                  accessibilityState={{ selected: queueTab === tab }}
                  onPress={() => setQueueTab(tab)}
                  style={[styles.tab, queueTab === tab && styles.selectedTab]}>
                  <Text style={[styles.tabText, queueTab === tab && styles.selectedTabText]}>
                    {tab === 'outstanding' ? 'Outstanding' : 'Completed'} (
                    {tab === 'outstanding' ? outstandingItems.length : completedItems.length})
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            {!!notice && <Text accessibilityLiveRegion="polite" style={styles.meta}>{notice}</Text>}
            {!!error && (
              <View accessibilityLiveRegion="polite" style={styles.error}>
                <Text style={styles.errorText}>{error}</Text>
                {items.length > 0 && (
                  <Text style={styles.meta}>
                    Showing the last loaded contracts. Retry to check for updates.
                  </Text>
                )}
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel="Retry assigned contracts"
                  style={styles.retry}
                  onPress={() => void load(true)}>
                  <Text style={styles.buttonText}>Retry</Text>
                </TouchableOpacity>
              </View>
            )}
            <UploadContinuationPanel
              onOpen={(id, _type, next) => {
                setDraftId(id);
                setSetup(next);
              }}
            />
          </View>
        }
        ListEmptyComponent={
          loading ? (
            <ActivityIndicator
              accessibilityLabel="Loading assigned contracts"
              color={colors.accent}
            />
          ) : !error ? (
            <Text style={styles.meta}>
              {enabled
                ? queueTab === 'completed'
                  ? 'No reports have been sent to Auctioneer yet. Completed shows sent work, not contract closure.'
                  : 'No outstanding contracts are waiting. Pull down to refresh.'
                : unavailableMessage}
            </Text>
          ) : null
        }
      />
      {setup?.reportType === 'asset' && (
        <AssetFormSheet
          visible
          onClose={close}
          onSuccess={close}
          auctioneer={setup}
          draftIdToLoad={draftId}
          onAuctioneerSetupChange={nextForm}
        />
      )}
      {setup?.reportType === 'lotListing' && (
        <LotListingFormSheet
          visible
          onClose={close}
          onSuccess={close}
          auctioneer={setup}
          draftIdToLoad={draftId}
          onAuctioneerSetupChange={nextForm}
        />
      )}
    </View>
  );
}

const createStyles = (colors: AppThemeColors) =>
  StyleSheet.create({
    container: { flex: 1 },
    content: { padding: 16, paddingBottom: 32, width: '100%', maxWidth: 920, alignSelf: 'center' },
    intro: { gap: 8, marginBottom: 16 },
    heading: { fontSize: 17, fontWeight: '700', color: colors.text },
    tabs: { flexDirection: 'row', gap: 8, marginVertical: 8 },
    tab: {
      flex: 1,
      minHeight: 44,
      padding: 10,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 8,
      backgroundColor: colors.surface,
    },
    selectedTab: { borderColor: colors.accent, backgroundColor: colors.accent },
    tabText: { fontSize: 13, fontWeight: '700', color: colors.textSecondary, textAlign: 'center' },
    selectedTabText: { color: colors.accentText },
    status: { fontSize: 12, fontWeight: '700', color: colors.textSecondary },
    card: {
      padding: 14,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      backgroundColor: colors.surface,
      marginBottom: 12,
      gap: 6,
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    title: { flex: 1, fontSize: 16, fontWeight: '700', color: colors.text },
    meta: { fontSize: 13, lineHeight: 20, color: colors.textSecondary },
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
    button: {
      flexGrow: 1,
      minWidth: 116,
      minHeight: 44,
      justifyContent: 'center',
      alignItems: 'center',
      paddingVertical: 12,
      paddingHorizontal: 14,
      borderRadius: 8,
      backgroundColor: colors.accent,
    },
    buttonText: { fontSize: 13, fontWeight: '700', color: colors.accentText, textAlign: 'center' },
    disabled: { opacity: 0.55 },
    error: { padding: 12, backgroundColor: colors.dangerSoft, borderRadius: 8, gap: 10 },
    errorText: { color: colors.danger, fontSize: 13, lineHeight: 20 },
    retry: {
      alignSelf: 'flex-start',
      minHeight: 44,
      justifyContent: 'center',
      padding: 12,
      borderRadius: 8,
      backgroundColor: colors.accent,
    },
  });
