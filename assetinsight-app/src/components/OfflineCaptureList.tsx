import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useAppTheme } from '../context/ThemeContext';
import OfflineCaptureStore, { OfflineDraftSummary } from '../services/offlineCaptureStore';
import AutoSaveService, { OfflineReportDraft } from '../services/autoSaveService';
import { needsExplicitUploadResume } from '../services/offlineDraftPolicy';
import backgroundUploadManager, { describeBackgroundUpload } from '../services/backgroundUploadManager';
import { loadNativeAuctionCamera } from './camera/nativeAuctionCameraModule';
import LotPhotoCounts from './LotPhotoCounts';
import { useBackgroundUploads } from './useBackgroundUploads';

type InterruptedMedia = { photos: number; videos: number; pending: number };

/** A stalled native read must not hold the scan, or the next one, forever. */
const JOURNAL_READ_TIMEOUT_MS = 3000;
function withinTimeout<T>(promise: Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), JOURNAL_READ_TIMEOUT_MS); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Media held by an interrupted camera session, per draft. If Android closes the
 * app during a phone call, the form is gone when the person returns; the media
 * waits in the camera journal and is offered only when that exact draft is opened.
 * A count here says which capture to open (2026-10-26). Journals the camera screen
 * would ignore (another owner or draft, no revision) are ignored here too.
 */
async function interruptedCameraMedia(ownerId: string, ids: string[]): Promise<Record<string, InterruptedMedia>> {
  if (Platform.OS !== 'android' || !ids.length) return {};
  const native = await withinTimeout(loadNativeAuctionCamera()).catch(() => undefined);
  if (!native?.getPendingCapture) return {};
  const found: Record<string, InterruptedMedia> = {};
  for (const id of ids) {
    try {
      const raw = await withinTimeout(native.getPendingCapture(ownerId, id));
      if (!raw) continue;
      const journal = JSON.parse(raw);
      if (journal.ownerId !== ownerId || journal.draftId !== id || !Number.isInteger(journal.revision)) continue;
      const lots: any[] = Array.isArray(journal.lots) ? journal.lots : [];
      const media = {
        photos: lots.reduce((sum, lot) => sum + (Array.isArray(lot?.files) ? lot.files.length : 0) + (Array.isArray(lot?.extraFiles) ? lot.extraFiles.length : 0), 0),
        videos: lots.filter((lot) => lot?.videoFile != null).length,
        pending: Number.isInteger(journal.pendingPhotoCount) && journal.pendingPhotoCount > 0 ? journal.pendingPhotoCount : 0,
      };
      if (media.photos || media.videos || media.pending) found[id] = media;
    } catch { /* An unreadable journal stays on the device for support recovery. */ }
  }
  return found;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Name the step the camera screen offers: unfinished photos have no Recover button yet. */
function interruptedCameraHint(media: InterruptedMedia): string {
  if (media.pending) {
    return `An interrupted camera session has ${plural(media.pending, 'photo')} still processing for this capture. Tap Open and submit, then open the camera to finish saving ${media.pending === 1 ? 'it' : 'them'}.`;
  }
  const saved = [media.photos ? plural(media.photos, 'photo') : '', media.videos ? plural(media.videos, 'video') : ''].filter(Boolean).join(' and ');
  return `An interrupted camera session saved ${saved} for this capture. Tap Open and submit, then ${media.videos ? 'Recover media' : 'Recover photos'}.`;
}

export default function OfflineCaptureList({ onOpen }: { onOpen: (id: string, type: 'asset' | 'lotListing') => void }) {
  const { colors } = useAppTheme();
  const [items, setItems] = useState<OfflineDraftSummary[]>([]);
  const [legacy, setLegacy] = useState<OfflineReportDraft[]>([]);
  const [legacyJobs, setLegacyJobs] = useState<Array<{ id: string; job: Record<string, any> }>>([]);
  const [error, setError] = useState('');
  const [page, setPage] = useState(0);
  const [legacyLimit, setLegacyLimit] = useState(20);
  const [expanded, setExpanded] = useState<string>();
  const [cameraWaiting, setCameraWaiting] = useState<Record<string, InterruptedMedia>>({});
  const scanning = useRef(false);
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
      // The journal scan only adds a hint. It runs after the list is shown, one at
      // a time, so a stalled native read can never hide Open and submit (2026-10-26).
      if (!owner) { setCameraWaiting({}); return; }
      if (scanning.current) return;
      scanning.current = true;
      void interruptedCameraMedia(owner, captures.map((item) => item.id))
        .then((waiting) => { if (owner === OfflineCaptureStore.getOwnerId()) setCameraWaiting(waiting); })
        .finally(() => { scanning.current = false; });
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
    <Text style={[styles.small, { color: colors.textSecondary }]}>Photos remain on this device. On supported Android builds, cloud backup runs separately; check Photo cloud backup for verified progress and Pause/Resume. Open a draft to review and submit the report yourself.</Text>
    {error ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>{error}</Text> : null}
    {visible.map((item) => {
      // The background upload line knows more than the stored state: a draft
      // it is sending is stored as 'ready' but is not waiting for anyone.
      const background = backgroundUploadManager.statusFor(item.id);
      const busy = backgroundUploadManager.isBusy(item.id);
      const asset = item.type === 'asset';
      return <View key={item.id} style={[styles.card, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      <View style={styles.cardTop}>
        <View style={[styles.typeIcon, { backgroundColor: asset ? '#FFE4E6' : '#F3E8FF' }]}>
          <Feather name={asset ? 'package' : 'list'} size={16} color={asset ? '#E11D48' : '#7C3AED'} />
        </View>
        <View style={styles.cardText}>
          <Text numberOfLines={1} adjustsFontSizeToFit style={[styles.heading, { color: colors.text }]}>{item.contractNo || 'Contract not entered'} · {asset ? 'Asset' : 'Lot listing'}</Text>
          <Text style={[styles.small, { color: colors.textSecondary }]}>{item.counts.lots} lots · {item.counts.images} photos · {item.counts.extraImages} report-only{item.counts.missingImages ? ` · ${item.counts.missingImages} missing` : ''}</Text>
          <Text style={[styles.small, { color: colors.textMuted }]}>Saved on this device · {new Date(item.updatedAt).toLocaleString()}</Text>
        </View>
      </View>
      {background ? <Text accessibilityLiveRegion="polite" style={[styles.small, { color: background.status === 'attention' ? colors.warning : colors.info }]}>Background upload: {describeBackgroundUpload(background)}</Text>
        : needsExplicitUploadResume(item.submissionState) ? <Text style={[styles.small, { color: colors.warning }]}>Report submission needs your confirmation — open the draft, then tap Resume upload. Cloud backup does not submit it.</Text> : null}
      {cameraWaiting[item.id] ? <Text style={[styles.small, { color: colors.warning }]}>{interruptedCameraHint(cameraWaiting[item.id])}</Text> : null}
      {item.inventoryError ? <Text accessibilityRole="alert" style={[styles.small, { color: colors.warning }]}>{item.inventoryError}</Text> : null}
      <View style={styles.buttonRow}>
        <TouchableOpacity accessibilityRole="button" accessibilityHint="Review saved data first. The report is submitted only after you tap Submit; cloud backup is separate." onPress={() => onOpen(item.id, item.type)} style={[styles.button, styles.primary, { backgroundColor: colors.accent }]}><Text numberOfLines={1} adjustsFontSizeToFit style={[styles.buttonText, { color: colors.accentText }]}>Open and submit</Text></TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" accessibilityState={{ expanded: expanded === item.id }} onPress={() => setExpanded(expanded === item.id ? undefined : item.id)} style={[styles.button, styles.lotCounts, { borderColor: colors.border }]}><Text numberOfLines={1} adjustsFontSizeToFit style={[styles.buttonText, { color: colors.text }]}>Lot counts</Text></TouchableOpacity>
        <TouchableOpacity accessibilityRole="button" accessibilityState={{ disabled: busy }} accessibilityHint={busy ? 'Uploading in the background. Pause it from the upload bar first.' : undefined}
          disabled={busy} onPress={() => remove(item)} style={[styles.button, styles.discard, { borderColor: colors.dangerSoft }, busy && styles.disabled]}><Text numberOfLines={1} adjustsFontSizeToFit style={[styles.buttonText, { color: colors.danger }]}>Discard</Text></TouchableOpacity>
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

const styles = StyleSheet.create({ section: { gap: 8, marginVertical: 12 }, title: { fontSize: 17, fontWeight: '700' },
  small: { fontSize: 12, lineHeight: 17 },
  card: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 8 }, heading: { fontSize: 15, fontWeight: '600' },
  cardTop: { flexDirection: 'row', gap: 10 }, cardText: { flex: 1, gap: 2 },
  typeIcon: { width: 32, height: 32, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  buttonRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  button: { minHeight: 40, paddingHorizontal: 10, borderRadius: 10, borderWidth: 1, borderColor: 'transparent', justifyContent: 'center' },
  primary: { flex: 3, alignItems: 'center' }, lotCounts: { flex: 2, alignItems: 'center' }, discard: { flex: 1.4, alignItems: 'center' }, buttonText: { fontSize: 13, fontWeight: '600' },
  disabled: { opacity: 0.4 } });
