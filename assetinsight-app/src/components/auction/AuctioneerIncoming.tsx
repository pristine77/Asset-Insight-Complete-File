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
import { Feather } from '@expo/vector-icons';
import { useAppTheme, type AppThemeColors } from '../../context/ThemeContext';
import auctioneerService, {
  type ArrivalPhotoRequest,
  type CompletedArrivalPhotoRequest,
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
  const { colors, isDark } = useAppTheme();
  const styles = useMemo(() => createStyles(colors, isDark), [colors, isDark]);
  const [items, setItems] = useState<AuctioneerIncomingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [enabled, setEnabled] = useState(false);
  // Arrival Photos is the third tab (owner, 2026-11-03): lots the office asked
  // this user to photograph on arrival. Read with the contracts, never fatal.
  const [queueTab, setQueueTab] = useState<'outstanding' | 'completed' | 'arrival'>('outstanding');
  const [arrivalRequests, setArrivalRequests] = useState<ArrivalPhotoRequest[]>([]);
  const [arrivalRequest, setArrivalRequest] = useState<ArrivalPhotoRequest | null>(null);
  // Waiting / Completed inside the Arrival Photos tab (owner, 2026-11-04, as on
  // the website): the requests still to photograph, and the ones already sent.
  const [arrivalView, setArrivalView] = useState<'waiting' | 'completed'>('waiting');
  const [completedArrival, setCompletedArrival] = useState<CompletedArrivalPhotoRequest[]>([]);
  const [arrivalErrors, setArrivalErrors] = useState({ waiting: '', completed: '' });
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
  const queueAuthEpoch = useRef(getAuthOperationEpoch());

  const load = useCallback(async (refresh = false) => {
    const revision = ++readRevision.current;
    const owner = OfflineCaptureStore.getOwnerId();
    const authEpoch = getAuthOperationEpoch();
    if (owner !== queueOwner.current || authEpoch !== queueAuthEpoch.current) {
      queueOwner.current = owner;
      queueAuthEpoch.current = authEpoch;
      receivedRevisions.current.clear();
      uncertainReopens.current.clear();
      setItems([]);
      setArrivalRequests([]);
      setCompletedArrival([]);
      setArrivalErrors({ waiting: '', completed: '' });
      setArrivalRequest(null);
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
        setArrivalRequests([]);
        setCompletedArrival([]);
        setArrivalErrors({ waiting: '', completed: '' });
        setArrivalRequest(null);
        return false;
      }
      const [next, arrival, sent] = await Promise.all([
        auctioneerService.getIncoming(refresh),
        // An unreadable arrival list keeps the last one; contracts still load.
        auctioneerService.getArrivalPhotoRequests().then(rows => ({ rows, error: '' }), cause => ({ rows: null, error: auctioneerErrorMessage(cause, 'Could not load waiting arrival photos. Retry to check for updates.') })),
        auctioneerService.getCompletedArrivalPhotoRequests().then(rows => ({ rows, error: '' }), cause => ({ rows: null, error: auctioneerErrorMessage(cause, 'Could not load completed arrival photos. Retry to check for updates.') })),
      ]);
      if (!isCurrent()) return false;
      if (arrival.rows) setArrivalRequests(arrival.rows);
      if (sent.rows) setCompletedArrival(sent.rows);
      setArrivalErrors({ waiting: arrival.error, completed: sent.error });
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
  const closeArrival = useCallback(() => {
    setArrivalRequest(null);
    void load(true);
  }, [load]);

  const renderArrivalRequest = useCallback(
    ({ item }: { item: ArrivalPhotoRequest }) => {
      const what = item.description || [item.year, item.make, item.model].filter(Boolean).join(' ');
      return (
        <View style={styles.card} testID="arrival-photo-request">
          <View style={styles.row}>
            <Text style={styles.lotTag}>Lot {item.lotNumber || '—'}</Text>
          </View>
          {!!what && <Text style={styles.meta}>{what}</Text>}
          {!!item.serialNumber && <Text style={styles.meta}>S/N {item.serialNumber}</Text>}
          {!!item.contractNumber && <Text style={styles.meta}>Contract {item.contractNumber}</Text>}
          {!!item.consignorName && <Text style={styles.meta}>Consignor: {item.consignorName}</Text>}
          {!!item.location && <Text style={styles.meta}>{item.location}</Text>}
          <View style={styles.row}>
            <Feather name="clock" size={13} color={colors.warning} />
            <Text style={styles.waiting}>
              Requested by {item.requestedBy || 'the office'}
              {item.requestedAt ? ` · ${new Date(item.requestedAt).toLocaleString()}` : ''}
            </Text>
          </View>
          {item.officeOnlyPhotoCount > 0 ? (
            <Text style={styles.meta}>{item.officeOnlyPhotoCount} Office Only photos already</Text>
          ) : null}
          <View style={styles.actions}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={`Take arrival photos for lot ${item.lotNumber || ''}`}
              style={styles.button}
              onPress={() => setArrivalRequest(item)}>
              <Text style={styles.buttonText}>Take photos</Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    },
    [colors.warning, styles]
  );
  // A sent request (owner, 2026-11-04): when, and how many photos, in green.
  const renderCompletedArrival = useCallback(
    ({ item }: { item: CompletedArrivalPhotoRequest }) => {
      const what = item.description || [item.year, item.make, item.model].filter(Boolean).join(' ');
      return (
        <View style={styles.card} testID="completed-arrival-photo-request">
          <View style={styles.row}>
            <Text style={styles.lotTag}>Lot {item.lotNumber || '—'}</Text>
            <View style={styles.photoPill} accessibilityLabel={`${item.photoCount} photo${item.photoCount === 1 ? '' : 's'}`}>
              <Feather name="camera" size={12} color={colors.success} />
              <Text style={styles.photoPillText}>{item.photoCount}</Text>
            </View>
          </View>
          {!!what && <Text style={styles.meta}>{what}</Text>}
          {!!item.contractNumber && <Text style={styles.meta}>Contract {item.contractNumber}</Text>}
          {!!item.consignorName && <Text style={styles.meta}>Consignor: {item.consignorName}</Text>}
          <Text style={styles.meta}>Requested by {item.requestedBy || 'the office'}</Text>
          <View style={styles.row}>
            <Feather name="check-circle" size={14} color={colors.success} />
            <Text style={styles.sent}>
              Sent {item.receivedAt ? new Date(item.receivedAt).toLocaleString() : ''}
            </Text>
          </View>
        </View>
      );
    },
    [colors.success, styles]
  );
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
  const showingArrival = queueTab === 'arrival';
  const showingSent = showingArrival && arrivalView === 'completed';

  return (
    <View style={styles.container}>
      <FlatList<AuctioneerIncomingItem | ArrivalPhotoRequest | CompletedArrivalPhotoRequest>
        data={enabled ? (showingSent ? completedArrival : showingArrival ? arrivalRequests : visibleItems) : []}
        keyExtractor={(item) =>
          'receivedAt' in item
            ? `sent-${item.requestId}`
            : 'requestId' in item
              ? `arrival-${item.requestId}`
              : item.workItemId || item.cycleKey
        }
        renderItem={({ item }) =>
          'receivedAt' in item
            ? renderCompletedArrival({ item })
            : 'requestId' in item
              ? renderArrivalRequest({ item })
              : renderItem({ item })
        }
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
              {(['outstanding', 'completed', 'arrival'] as const).map((tab) => (
                <TouchableOpacity
                  key={tab}
                  accessibilityRole="tab"
                  accessibilityLabel={
                    tab === 'arrival'
                      ? 'Arrival photo requests'
                      : `${tab === 'outstanding' ? 'Outstanding' : 'Completed'} contracts`
                  }
                  accessibilityState={{ selected: queueTab === tab }}
                  onPress={() => setQueueTab(tab)}
                  style={[styles.tab, queueTab === tab && styles.selectedTab]}>
                  {/*
                    The count on a line of its own, and a line budget (two, or
                    three for the two-word "Arrival Photos") the text shrinks to
                    fit: on a narrow phone "Outstanding" was split mid-word as
                    "Outsta / nding" (owner's screenshot, 2026-11-04).
                  */}
                  <Text
                    numberOfLines={tab === 'arrival' ? 3 : 2}
                    adjustsFontSizeToFit
                    minimumFontScale={0.7}
                    style={[styles.tabText, queueTab === tab && styles.selectedTabText]}>
                    {tab === 'outstanding' ? 'Outstanding' : tab === 'completed' ? 'Completed' : 'Arrival Photos'}
                    {'\n'}(
                    {tab === 'outstanding'
                      ? outstandingItems.length
                      : tab === 'completed'
                        ? completedItems.length
                        : arrivalRequests.length}
                    )
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            {/*
              Waiting / Completed as one row of two equal halves (owner,
              2026-11-04, phone screenshot: "arrange this"). The camera and the
              words "Arrival photos" before them pushed Completed onto a second
              line on a phone; the selected tab above already names the list,
              so the row holds only the two choices.
            */}
            {showingArrival ? (
              <View style={styles.arrivalBar} accessibilityRole="tablist">
                {(['waiting', 'completed'] as const).map((view) => {
                  const selected = arrivalView === view;
                  const count = view === 'waiting' ? arrivalRequests.length : completedArrival.length;
                  return (
                    <TouchableOpacity
                      key={view}
                      accessibilityRole="tab"
                      accessibilityLabel={`${view === 'waiting' ? 'Waiting' : 'Completed'} arrival photo requests, ${count}`}
                      accessibilityState={{ selected }}
                      onPress={() => setArrivalView(view)}
                      style={[styles.subTab, selected && styles.subTabSelected]}>
                      <Text
                        numberOfLines={1}
                        adjustsFontSizeToFit
                        minimumFontScale={0.8}
                        style={[styles.subTabText, selected && styles.subTabTextSelected]}>
                        {view === 'waiting' ? 'Waiting' : 'Completed'}
                      </Text>
                      <Text style={view === 'waiting' ? styles.countWaiting : styles.countDone}>{count}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ) : null}
            {showingArrival && !!arrivalErrors[arrivalView] && (
              <View accessibilityLiveRegion="polite" style={styles.error}>
                <Text style={styles.errorText}>{arrivalErrors[arrivalView]}</Text>
                {(showingSent ? completedArrival : arrivalRequests).length > 0 && (
                  <Text style={styles.meta}>Showing the last loaded arrival photos. Retry to check for updates.</Text>
                )}
                <TouchableOpacity accessibilityRole="button"
                  accessibilityLabel={`Retry ${arrivalView} arrival photos`} style={styles.retry}
                  disabled={refreshing} onPress={() => void load(true)}>
                  <Text style={styles.buttonText}>Retry</Text>
                </TouchableOpacity>
              </View>
            )}
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
          ) : !error && !(showingArrival && arrivalErrors[arrivalView]) ? (
            <Text style={styles.meta}>
              {enabled
                ? showingSent
                  ? "No arrival photos sent yet. Once you send a request's photos, it moves here."
                  : showingArrival
                  ? 'No arrival photo requests. When the office asks you to photograph a lot that has arrived, it is listed here.'
                  : queueTab === 'completed'
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
      {arrivalRequest && !setup ? (
        <LotListingFormSheet
          visible
          arrivalRequest={arrivalRequest}
          onClose={closeArrival}
          onSuccess={() => {
            setArrivalView('completed');
            closeArrival();
          }}
        />
      ) : null}
    </View>
  );
}

/*
  Arrival photos' colours (owner, 2026-11-04: "Add a little color to the UI",
  as on the website). Violet marks arrival photos; amber is waiting and green is
  sent, from the theme's warning and success colours. Violet has its own value
  in each theme.
*/
const createStyles = (colors: AppThemeColors, isDark = false) =>
  StyleSheet.create({
    // One row that never wraps: two halves of equal width on the violet track.
    arrivalBar: {
      flexDirection: 'row',
      alignItems: 'stretch',
      gap: 4,
      padding: 4,
      borderRadius: 10,
      backgroundColor: isDark ? 'rgba(139, 92, 246, 0.14)' : '#F5F3FF',
    },
    // The border is always there (clear when not selected), so picking a
    // half does not nudge the row by a pixel.
    subTab: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      minHeight: 40,
      paddingHorizontal: 8,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: 'transparent',
    },
    subTabSelected: { backgroundColor: colors.surface, borderColor: colors.border },
    subTabText: { flexShrink: 1, fontSize: 13, fontWeight: '700', color: colors.textSecondary },
    subTabTextSelected: { color: colors.text },
    countWaiting: {
      fontSize: 12,
      fontWeight: '700',
      color: colors.warning,
      backgroundColor: colors.warningSoft,
      borderRadius: 999,
      paddingHorizontal: 7,
      overflow: 'hidden',
    },
    countDone: {
      fontSize: 12,
      fontWeight: '700',
      color: colors.success,
      backgroundColor: colors.successSoft,
      borderRadius: 999,
      paddingHorizontal: 7,
      overflow: 'hidden',
    },
    lotTag: {
      fontSize: 15,
      fontWeight: '800',
      color: isDark ? '#DDD6FE' : '#5B21B6',
      backgroundColor: isDark ? 'rgba(139, 92, 246, 0.18)' : '#EDE9FE',
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 2,
      overflow: 'hidden',
    },
    waiting: { flex: 1, fontSize: 12, fontWeight: '700', color: colors.warning },
    sent: { flex: 1, fontSize: 13, fontWeight: '700', color: colors.success },
    photoPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      marginLeft: 'auto',
      paddingHorizontal: 9,
      paddingVertical: 2,
      borderRadius: 999,
      backgroundColor: colors.successSoft,
    },
    photoPillText: { fontSize: 13, fontWeight: '800', color: colors.success },
    container: { flex: 1 },
    content: { padding: 16, paddingBottom: 32, width: '100%', maxWidth: 920, alignSelf: 'center' },
    intro: { gap: 8, marginBottom: 16 },
    heading: { fontSize: 17, fontWeight: '700', color: colors.text },
    tabs: { flexDirection: 'row', gap: 8, marginVertical: 8 },
    tab: {
      flex: 1,
      minHeight: 44,
      paddingVertical: 10,
      paddingHorizontal: 4,
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
