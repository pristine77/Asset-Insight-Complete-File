import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAuth } from '../context/AuthContext';
import { useAppTheme } from '../context/ThemeContext';
import OfflineCaptureStore from '../services/offlineCaptureStore';
import durableContinuationService from '../services/durableContinuationService';
import type { DurableContinuationIntent } from '../services/durableContinuationTypes';
import type { AuctioneerReportType, AuctioneerWorkItemSetup } from '../services/auctioneerService';

/** A pending next lot remains reachable even when its accepted parent is hidden. */
export default function UploadContinuationPanel({ onOpen }: { onOpen: (draftId: string, type: AuctioneerReportType, setup: AuctioneerWorkItemSetup) => void }) {
  const { user } = useAuth(), { colors } = useAppTheme();
  const owner = user ? String(user._id || (user as any).id || '') : null;
  const [rows, setRows] = useState<DurableContinuationIntent[]>([]), [busy, setBusy] = useState<string>();
  const [loadError, setLoadError] = useState('');
  const epoch = useRef(0), readRevision = useRef(0), opening = useRef(false);
  const load = useCallback(() => {
    const current = epoch.current, revision = ++readRevision.current;
    if (!owner || OfflineCaptureStore.getOwnerId() !== owner) return;
    const isCurrent = () => epoch.current === current && readRevision.current === revision && OfflineCaptureStore.getOwnerId() === owner;
    void durableContinuationService.list().then(next => {
      if (isCurrent()) { setRows(next.filter(row => row.stage !== 'ready')); setLoadError(''); }
    }).catch(() => { if (isCurrent()) setLoadError('Continue requests could not be loaded. Retry to check saved next lots; no report will be submitted.'); });
  }, [owner]);
  useEffect(() => {
    epoch.current += 1; setRows([]); setBusy(undefined); setLoadError(''); opening.current = false;
    load(); const unsubscribe = OfflineCaptureStore.subscribeContinuations(load);
    return () => { epoch.current += 1; unsubscribe(); };
  }, [load]);
  const open = useCallback(async (row: DurableContinuationIntent) => {
    if (opening.current || OfflineCaptureStore.getOwnerId() !== row.ownerId) return;
    const current = epoch.current; opening.current = true; setBusy(row.id);
    try {
      const result = await durableContinuationService.complete(row.id);
      if (current === epoch.current && OfflineCaptureStore.getOwnerId() === row.ownerId) onOpen(result.draftId, row.type, result.setup);
    } catch (error) {
      if (current === epoch.current && OfflineCaptureStore.getOwnerId() === row.ownerId) Alert.alert('Next lot needs attention', error instanceof Error ? error.message : 'Retry this saved Continue request. Its parent will not be uploaded again.');
    } finally { if (current === epoch.current) { opening.current = false; setBusy(undefined); } }
  }, [onOpen]);
  if (!rows.length && !loadError) return null;
  return <View style={styles.section}>
    <Text style={[styles.heading, { color: colors.text }]}>Continue requests</Text>
    {loadError ? <View>
      <Text accessibilityLiveRegion="polite" style={{ color: colors.textSecondary }}>{loadError}</Text>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Retry loading Continue requests" onPress={load} style={styles.button}>
        <Text style={{ color: colors.accent }}>Retry loading requests</Text>
      </TouchableOpacity>
    </View> : null}
    {rows.map(row => <View key={row.id} style={[styles.card, { borderColor: colors.borderStrong, backgroundColor: colors.surface }]}>
      <Text style={{ color: colors.text }}>{row.parentSetup.contract.contractNo} · {row.type === 'asset' ? 'Asset' : 'Lot Listing'}</Text>
      <Text style={{ color: colors.textSecondary }}>Next lot awaiting confirmation. Retry checks the saved parent and opens the same successor; it does not submit a report automatically.</Text>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Retry next lot for ${row.parentSetup.contract.contractNo}`} disabled={Boolean(busy)} onPress={() => void open(row)} style={styles.button}>
        {busy === row.id ? <ActivityIndicator color={colors.accent} /> : <Text style={{ color: colors.accent }}>Retry next lot</Text>}
      </TouchableOpacity>
    </View>)}
  </View>;
}
const styles = StyleSheet.create({ section: { gap: 10, padding: 12 }, heading: { fontWeight: '700', fontSize: 16 },
  card: { borderWidth: 1, borderRadius: 10, padding: 12, gap: 8 }, button: { minHeight: 44, justifyContent: 'center', alignItems: 'center' } });
