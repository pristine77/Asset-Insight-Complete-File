import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import NetInfo from '@react-native-community/netinfo';
import auctioneerService, {
  type AuctioneerProposalItem,
  type AuctioneerWorkItemSetup,
} from '../../services/auctioneerService';
import { auctioneerErrorMessage } from '../../services/auctioneerErrors';
import OfflineCaptureStore from '../../services/offlineCaptureStore';
import { getAuthOperationEpoch } from '../../services/authSessionOperation';
import type { MixedLot } from '../camera/types';
import {
  PROPOSAL_ITEM_STATE_LABELS,
  PROPOSAL_NOT_FOUND_OFFLINE_MESSAGE,
  isProposalListSetup,
  proposalItemLabel,
  proposalItemLot,
  proposalItemsOf,
  proposalItemSourceKeyOfLot,
  proposalNotFoundPrompt,
} from './proposalListPolicy';

// One shared empty list keeps the form's draft callbacks stable for other setups.
const NO_ITEMS: AuctioneerProposalItem[] = [];

/**
 * The listed items of a Proposal worked from its list (owner 2026-10-28), for
 * one Incoming form. Items still to capture can be added to the form (a new
 * form already has them) or returned to Auctioneer as Not found; the others are
 * shown read-only so nobody wonders where they went. When the setup has no
 * list, nothing is shown and nothing changes.
 */
export function useProposalList({
  setup,
  lots,
  setLots,
  setActiveLotIdx,
  active = true,
}: {
  setup?: AuctioneerWorkItemSetup;
  lots: MixedLot[];
  setLots: React.Dispatch<React.SetStateAction<MixedLot[]>>;
  setActiveLotIdx?: React.Dispatch<React.SetStateAction<number>>;
  active?: boolean;
}) {
  const listed = isProposalListSetup(setup);
  const owner = OfflineCaptureStore.getOwnerId();
  const authEpoch = getAuthOperationEpoch();
  // A distinct token also fences A -> B -> A transitions with the same setup object.
  const context = useMemo(() => ({ setup, owner, authEpoch, active }), [setup, owner, authEpoch, active]);
  const contextRef = useRef(context);
  contextRef.current = context;
  // Refresh and Not found answer with the list as the server now sees it. A
  // newer setup from the boundary replaces both, so an old list never outlives
  // its assignment (same rule as the Schedule A item picker).
  const [refreshed, setRefreshed] = useState<{ context: typeof context; items: AuctioneerProposalItem[] }>();
  const items = !listed ? NO_ITEMS : refreshed && refreshed.context === context ? refreshed.items : proposalItemsOf(setup);
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');
  const busyRef = useRef(false);
  const operationRef = useRef<object | undefined>(undefined);
  const mountedRef = useRef(true);
  const lotsRef = useRef(lots);
  lotsRef.current = lots;
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    operationRef.current = undefined;
    busyRef.current = false;
    setBusy(undefined);
    setMessage('');
    setNotice('');
  }, [context]);
  const isCurrent = useCallback(() =>
    mountedRef.current && context.active && contextRef.current === context &&
    context.owner === OfflineCaptureStore.getOwnerId() &&
    context.authEpoch === getAuthOperationEpoch(), [context]);

  const inForm = useMemo(
    () => new Set(lots.map((lot) => proposalItemSourceKeyOfLot(lot)).filter((key): key is string => Boolean(key))),
    [lots]
  );

  const add = useCallback((toAdd: AuctioneerProposalItem[]) => {
    if (!isCurrent()) return;
    setMessage('');
    setNotice('');
    // A listed item is one lot: never add a second lot for an item already here.
    setLots((previous) => {
      if (!isCurrent()) return previous;
      const present = new Set(previous.map((lot) => proposalItemSourceKeyOfLot(lot)));
      const fresh = toAdd.filter((item) => item.state === 'outstanding' && !present.has(item.sourceKey));
      return fresh.length ? [...previous, ...fresh.map(proposalItemLot)] : previous;
    });
  }, [isCurrent, setLots]);

  const runExclusive = useCallback(async (key: string, work: (stillHere: () => boolean) => Promise<void>) => {
    if (!setup || !isCurrent() || busyRef.current) return;
    const operation = {};
    operationRef.current = operation;
    const stillHere = () => isCurrent() && operationRef.current === operation;
    busyRef.current = true;
    setBusy(key);
    setMessage('');
    setNotice('');
    try {
      await work(stillHere);
    } finally {
      if (operationRef.current === operation) {
        operationRef.current = undefined;
        busyRef.current = false;
        if (isCurrent()) setBusy(undefined);
      }
    }
  }, [isCurrent, setup]);

  const refresh = useCallback(() => runExclusive('refresh', async (stillHere) => {
    try {
      // The office may push more items to this user while the form is open.
      const fresh = await auctioneerService.getSetup(setup!.workItemId);
      if (!stillHere()) return;
      if (fresh.workItemId !== setup!.workItemId || fresh.contract.id !== setup!.contract.id || !fresh.proposalList) {
        throw new Error('This Incoming assignment changed. Close this form and reopen it from Incoming.');
      }
      setRefreshed({ context, items: fresh.proposalList.items });
    } catch (error) {
      if (stillHere()) {
        setMessage(auctioneerErrorMessage(error, 'The listed items could not be checked. Check the connection, then try again.'));
      }
    }
  }), [context, runExclusive, setup]);

  const returnNotFound = useCallback((item: AuctioneerProposalItem) => runExclusive(item.lineId, async (stillHere) => {
    try {
      // Not found goes straight to Auctioneer; it is never queued for later.
      const network = await NetInfo.fetch();
      if (!stillHere()) return;
      if (network.isConnected === false) {
        setMessage(PROPOSAL_NOT_FOUND_OFFLINE_MESSAGE);
        return;
      }
      const result = await auctioneerService.markProposalItemsNotFound(setup!.workItemId, [item.lineId]);
      if (!stillHere()) return;
      if (result.setup.workItemId !== setup!.workItemId || result.setup.contract.id !== setup!.contract.id || !result.setup.proposalList) {
        throw new Error('This Incoming assignment changed. Close this form and reopen it from Incoming.');
      }
      setRefreshed({
        context,
        items: result.setup.proposalList.items,
      });
      // The item is back in Auctioneer, so its lot leaves this form.
      const remaining = lotsRef.current.filter((lot) => proposalItemSourceKeyOfLot(lot) !== item.sourceKey).length;
      setLots((previous) => isCurrent() ? previous.filter((lot) => proposalItemSourceKeyOfLot(lot) !== item.sourceKey) : previous);
      setActiveLotIdx?.((index) => isCurrent() ? Math.max(0, Math.min(index, remaining - 1)) : index);
      setNotice(result.remainsInAssetInsight === false
        ? `${proposalItemLabel(item)} was returned as not found. Every listed item is now back in Auctioneer.`
        : `${proposalItemLabel(item)} was returned as not found.`);
    } catch (error) {
      if (stillHere()) {
        setMessage(auctioneerErrorMessage(error, 'The item was not returned. Check the connection, then try again.'));
      }
    }
  }), [context, isCurrent, runExclusive, setActiveLotIdx, setLots, setup]);

  const confirmNotFound = useCallback((item: AuctioneerProposalItem) => {
    if (!isCurrent() || busyRef.current) return;
    const lot = lotsRef.current.find((candidate) => proposalItemSourceKeyOfLot(candidate) === item.sourceKey);
    Alert.alert('Not found', proposalNotFoundPrompt(item, lot), [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Return as not found', style: 'destructive', onPress: () => { if (isCurrent()) void returnNotFound(item); } },
    ]);
  }, [isCurrent, returnNotFound]);

  return { listed, items, inForm, add, refresh, confirmNotFound, busy, message, notice };
}

export type ProposalListState = ReturnType<typeof useProposalList>;

interface Props {
  list: ProposalListState;
  disabled?: boolean;
  /** The host form's own section and title styles, so the panel looks like its neighbours. */
  style?: StyleProp<ViewStyle>;
  titleStyle?: StyleProp<TextStyle>;
}

const STATE_STYLES = {
  in_other_report: { color: '#475569', backgroundColor: '#E2E8F0' },
  returned: { color: '#15803D', backgroundColor: '#DCFCE7' },
  not_found: { color: '#B91C1C', backgroundColor: '#FEE2E2' },
} as const;

export default function ProposalListPanel({ list, disabled = false, style, titleStyle }: Props) {
  if (!list.listed) return null;
  const working = disabled || Boolean(list.busy);
  const toCapture = list.items.filter((item) => item.state === 'outstanding');
  const missing = toCapture.filter((item) => !list.inForm.has(item.sourceKey));
  const back = list.items.filter((item) => item.state === 'returned' || item.state === 'not_found').length;
  return (
    <View testID="proposal-list-panel" style={style}>
      <Text style={titleStyle}>Proposal items</Text>
      <Text style={styles.help}>
        One lot per listed item. Use Add Lot for an item that is not on the list. If you cannot find a listed
        item, tap Not found: it goes back to Auctioneer at once.
      </Text>
      <Text style={styles.summary}>
        {toCapture.length} to capture · {back} back in Auctioneer
      </Text>
      {list.items.length === 0 ? (
        <Text style={styles.notice}>No listed items are assigned to you on this Proposal. Add a lot for each item you find.</Text>
      ) : null}
      {missing.length > 1 ? (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={`Add all ${missing.length} listed items to this form`}
          accessibilityState={{ disabled: working }}
          disabled={working}
          onPress={() => list.add(missing)}
          style={[styles.addAll, working && styles.disabled]}>
          <Feather name="plus" size={14} color="#1D4ED8" />
          <Text style={styles.addText}>Add all {missing.length} to this form</Text>
        </TouchableOpacity>
      ) : null}
      <View style={styles.rows}>
        {list.items.map((item) => {
          const label = proposalItemLabel(item);
          const here = list.inForm.has(item.sourceKey);
          return (
            <View key={item.lineId} style={styles.row}>
              <View style={styles.rowText}>
                <Text style={styles.itemTitle}>{label}</Text>
                {item.serialNumber ? <Text style={styles.itemMeta}>S/N {item.serialNumber}</Text> : null}
              </View>
              {item.state === 'outstanding' ? (
                <View style={styles.actions}>
                  {here ? (
                    <Text style={styles.inForm}>In this form</Text>
                  ) : (
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel={`Add ${label} to this form`}
                      accessibilityState={{ disabled: working }}
                      disabled={working}
                      onPress={() => list.add([item])}
                      style={[styles.action, styles.addAction, working && styles.disabled]}>
                      <Text style={styles.addText}>Add</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={`Not found: ${label}`}
                    accessibilityState={{ disabled: working, busy: list.busy === item.lineId }}
                    disabled={working}
                    onPress={() => list.confirmNotFound(item)}
                    style={[styles.action, styles.notFoundAction, working && styles.disabled]}>
                    {list.busy === item.lineId ? <ActivityIndicator size="small" color="#B91C1C" /> : null}
                    <Text style={styles.notFoundText}>Not found</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <Text style={[styles.state, STATE_STYLES[item.state]]}>{PROPOSAL_ITEM_STATE_LABELS[item.state]}</Text>
              )}
            </View>
          );
        })}
      </View>
      {list.message ? <Text accessibilityRole="alert" style={styles.error}>{list.message}</Text> : null}
      {list.notice ? <Text accessibilityLiveRegion="polite" style={styles.done}>{list.notice}</Text> : null}
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Refresh Proposal items"
        accessibilityState={{ disabled: working, busy: list.busy === 'refresh' }}
        disabled={working}
        onPress={() => void list.refresh()}
        style={styles.refresh}>
        {list.busy === 'refresh' ? (
          <ActivityIndicator size="small" color="#2563EB" />
        ) : (
          <Feather name="refresh-cw" size={14} color="#2563EB" />
        )}
        <Text style={styles.refreshText}>Refresh list</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  help: { color: '#475569', fontSize: 12, lineHeight: 17, marginBottom: 6 },
  summary: { color: '#1F2937', fontSize: 13, fontWeight: '700', marginBottom: 8 },
  notice: {
    color: '#92400E',
    backgroundColor: '#FEF3C7',
    borderRadius: 10,
    padding: 10,
    fontSize: 13,
    lineHeight: 19,
  },
  rows: { gap: 8 },
  row: {
    minHeight: 44,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    backgroundColor: '#F8FAFC',
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
  },
  rowText: { flex: 1, minWidth: 140 },
  itemTitle: { color: '#1F2937', fontSize: 13, fontWeight: '700' },
  itemMeta: { color: '#64748B', fontSize: 12, marginTop: 2 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  action: {
    minHeight: 36,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  addAction: { borderColor: '#93C5FD', backgroundColor: '#EFF6FF' },
  notFoundAction: { borderColor: '#FCA5A5', backgroundColor: '#FEF2F2' },
  addText: { color: '#1D4ED8', fontSize: 12, fontWeight: '700' },
  notFoundText: { color: '#B91C1C', fontSize: 12, fontWeight: '700' },
  inForm: { color: '#475569', fontSize: 12, fontWeight: '600' },
  state: {
    fontSize: 11,
    fontWeight: '700',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  addAll: {
    minHeight: 40,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  disabled: { opacity: 0.5 },
  error: { color: '#DC2626', fontSize: 12, marginTop: 6 },
  done: { color: '#15803D', fontSize: 12, marginTop: 6 },
  refresh: {
    minHeight: 44,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  refreshText: { color: '#2563EB', fontSize: 13, fontWeight: '700' },
});
