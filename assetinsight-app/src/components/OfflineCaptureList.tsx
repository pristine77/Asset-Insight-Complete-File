import React, { useCallback, useEffect, useState } from 'react';
import { Alert, AppState, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from '../context/ThemeContext';
import OfflineCaptureStore, { OfflineDraftSummary } from '../services/offlineCaptureStore';
import AutoSaveService, { OfflineReportDraft } from '../services/autoSaveService';
import { needsExplicitUploadResume } from '../services/offlineDraftPolicy';
import backgroundUploadManager, { describeBackgroundUpload } from '../services/backgroundUploadManager';
import LotPhotoCounts from './LotPhotoCounts';
import { useBackgroundUploads } from './useBackgroundUploads';

export default function OfflineCaptureList({ onOpen }: { onOpen: (id: string, type: 'asset' | 'lotListing') => void }) {
  const { colors } = useAppTheme();
  const [items, setItems] = useState<OfflineDraftSummary[]>([]);
  const [legacy, setLegacy] = useState<OfflineReportDraft[]>([]);
  const [legacyJobs, setLegacyJobs] = useState<Array<{ id: string; job: Record<string, any> }>>([]);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [legacyLimit, setLegacyLimit] = useState(20);
  const [expanded, setExpanded] = useState<string>();
  // Re-renders with every background upload change; statusFor() reads it.
  useBackgroundUploads();
  const refresh = useCallback(async () => {
    const owner = OfflineCaptureStore.getOwnerId();
    try {
      const [summaries, old, jobs] = await Promise.all([OfflineCaptureStore.listSummaries(), OfflineCaptureStore.listLegacyDrafts(), OfflineCaptureStore.listLegacyJobs()]);
      if (owner !== OfflineCaptureStore.getOwnerId()) return;
      const captures = summaries.filter((item) => item.captureMode === 'offline' || item.manualSubmissionRequired);
      setItems(captures); setPage((current) => Math.min(current, Math.max(0, Math.ceil(captures.length / 20) - 1)));
      setLegacy(old); setLegacyJobs(jobs); setError('');
    } catch { setError('Could not read saved captures. Your local files have not been deleted.'); }
  }, []);
  useEffect(() => {
    void refresh();
    const listener = AppState.addEventListener('change', (state) => { if (state === 'active') void refresh(); });
    const timer = setInterval(() => void refresh(), 30000);
    return () => { clearInterval(timer); listener.remove(); };
  }, [refresh]);
  // A draft accepted in the background leaves this list at once.
  useEffect(() => backgroundUploadManager.onAccepted(() => { void refresh(); }), [refresh]);
  const recover = (draft: OfflineReportDraft) => Alert.alert('Recover older draft',
    'This older draft has no recorded owner. Confirm only if you created it. Recovery keeps its photos on this device and requires review before submission.', [
      { text: 'Cancel', style: 'cancel' }, { text: 'These are my drafts', onPress: () => {
        void OfflineCaptureStore.claimLegacyDraft(draft.id).then((saved) => { void refresh(); onOpen(saved.id, saved.type); })
          .catch((reason) => setError(reason.message || 'Could not recover this draft.'));
      } },
    ]);
  const remove = (item: OfflineDraftSummary) => backgroundUploadManager.isBusy(item.id)
    ? Alert.alert('Uploading in the background', 'This draft is uploading in the background. Pause it from the upload bar before discarding it.')
    : Alert.alert('Discard local draft?',
    'This removes it from your draft list. Original gallery photos are not deleted. Its operational history can still sync to admin.', [
      { text: 'Cancel', style: 'cancel' }, { text: 'Discard draft', style: 'destructive', onPress: () => {
        if (backgroundUploadManager.isBusy(item.id)) return;
        // A paused background upload of this draft must not be resumable from the bar once it is gone.
        backgroundUploadManager.forget(item.id);
        void AutoSaveService.deleteDraft(item.id).then(refresh).catch((reason) => setError(reason.message));
      } },
    ]);
  const visible = items.slice(page * 20, (page + 1) * 20);
  return <View style={styles.section}>
    <Text style={[styles.title, { color: colors.text }]}>Offline captures · {items.length}</Text>
    <Text style={{ color: colors.textSecondary }}>Photos remain on this device. On supported Android builds, cloud backup runs separately; check Photo cloud backup for verified progress and Pause/Resume. Open a draft to review and submit the report yourself.</Text>
    {error ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>{error}</Text> : null}
    {visible.map((item) => {
      // The background upload line knows more than the stored state: a draft
      // it is sending is stored as 'ready' but is not waiting for anyone.
      const background = backgroundUploadManager.statusFor(item.id);
      const busy = backgroundUploadManager.isBusy(item.id);
      return <View key={item.id} style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <Text style={[styles.heading, { color: colors.text }]}>{item.contractNo || 'Contract not entered'} · {item.type === 'asset' ? 'Asset' : 'Lot listing'}</Text>
      <Text style={{ color: colors.text }}>Saved on this device · {new Date(item.updatedAt).toLocaleString()}</Text>
      <Text style={{ color: colors.textSecondary }}>{item.counts.lots} lots · {item.counts.images} photos · {item.counts.extraImages} report-only{item.counts.missingImages ? ` · ${item.counts.missingImages} missing` : ''}</Text>
      {background ? <Text accessibilityLiveRegion="polite" style={{ color: background.status === 'attention' ? colors.warning : colors.info }}>Background upload: {describeBackgroundUpload(background)}</Text>
        : needsExplicitUploadResume(item.submissionState) ? <Text style={{ color: colors.warning }}>Report submission needs your confirmation — open the draft, then tap Resume upload. Cloud backup does not submit it.</Text> : null}
      {item.inventoryError ? <Text accessibilityRole="alert" style={{ color: colors.warning }}>{item.inventoryError}</Text> : null}
      <View style={styles.actions}>
        <TouchableOpacity accessibilityRole="button" accessibilityHint="Review saved data first. The report is submitted only after you tap Submit; cloud backup is separate." onPress={() => onOpen(item.id, item.type)} style={styles.button}><Text style={{ color: colors.accent }}>Open and submit</Text></TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" accessibilityState={{ expanded: expanded === item.id }} onPress={() => setExpanded(expanded === item.id ? undefined : item.id)} style={styles.button}><Text style={{ color: colors.text }}>Lot counts</Text></TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled: busy }} accessibilityHint={busy ? 'Uploading in the background. Pause it from the upload bar first.' : undefined}
          disabled={busy} onPress={() => remove(item)} style={[styles.button, busy && styles.disabled]}><Text style={{ color: colors.danger }}>Discard</Text></TouchableOpacity>
      </View>
      {expanded === item.id ? <LotPhotoCounts lots={item.counts.perLot} /> : null}
    </View>;
    })}
    {items.length > 20 ? <View style={styles.actions}>
      <TouchableOpacity accessibilityRole="button" disabled={!page} onPress={() => setPage(page - 1)} style={styles.button}><Text style={{ color: colors.accent }}>Previous</Text></TouchableOpacity>
      <Text style={{ color: colors.text }}>Page {page + 1} / {Math.ceil(items.length / 20)}</Text>
      <TouchableOpacity accessibilityRole="button" disabled={(page + 1) * 20 >= items.length} onPress={() => setPage(page + 1)} style={styles.button}><Text style={{ color: colors.accent }}>Next</Text></TouchableOpacity>
    </View> : null}
    {legacy.length || legacyJobs.length ? <View style={[styles.card, { borderColor: colors.border }]}>
      <Text style={[styles.heading, { color: colors.text }]}>Recover older drafts</Text>
      <Text style={{ color: colors.textSecondary }}>These records have no verified owner and cannot sync or submit until you confirm ownership and review them.</Text>
      {legacy.slice(0, legacyLimit).map((draft) => <TouchableOpacity key={draft.id} accessibilityRole="button" onPress={() => recover(draft)} style={styles.button}>
        <Text style={{ color: colors.accent }}>Recover {draft.contractNo || draft.title || draft.type}</Text>
      </TouchableOpacity>)}
      {legacyJobs.slice(0, legacyLimit).map((entry) => <TouchableOpacity key={entry.id} accessibilityRole="button" style={styles.button}
        onPress={() => Alert.alert('Recover older upload', 'Confirm only if this is your work. It will become a paused local draft for your review, not an automatic upload.', [
          { text: 'Cancel', style: 'cancel' }, { text: 'These are my drafts', onPress: () => {
            void OfflineCaptureStore.claimLegacyJobAsDraft(entry.id).then((saved) => { void refresh(); onOpen(saved.id, saved.type); })
              .catch((reason) => setError(reason.message || 'Could not recover this upload.'));
          } },
        ])}>
        <Text style={{ color: colors.accent }}>Recover upload {String(entry.job.details?.contract_no || entry.job.type || '')}</Text>
      </TouchableOpacity>)}
      {Math.max(legacy.length, legacyJobs.length) > legacyLimit ? <TouchableOpacity accessibilityRole="button" onPress={() => setLegacyLimit((limit) => limit + 20)} style={styles.button}><Text style={{ color: colors.accent }}>Show more older drafts</Text></TouchableOpacity> : null}
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({ section: { gap: 10, marginVertical: 16 }, title: { fontSize: 20, fontWeight: '700' },
  card: { borderWidth: 1, borderRadius: 8, padding: 12, gap: 8 }, heading: { fontSize: 16, fontWeight: '600' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }, button: { minHeight: 44, padding: 10, justifyContent: 'center' },
  disabled: { opacity: 0.4 } });
