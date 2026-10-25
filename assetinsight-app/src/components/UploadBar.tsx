import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useAppTheme, type AppThemeColors } from '../context/ThemeContext';
import backgroundUploadManager, {
  type BackgroundUploadEntry,
  type BackgroundUploadNotice,
} from '../services/backgroundUploadManager';
import type { OfflineDraftType } from '../services/autoSaveService';
import { useBackgroundUploads } from './useBackgroundUploads';
import durableReportTransfer from '../services/durableReportTransfer';

/** How long a "Sent" notice stays before it dismisses itself. */
export const SENT_NOTICE_MS = 6_000;
/** Paused uploads listed one by one; the rest are counted. */
const MAX_PAUSED_ROWS = 2;
/** The newest notices are shown; older ones are counted (each draft's Drafts card keeps its status). */
const MAX_NOTICE_ROWS = 3;
/** About four rows of the line; longer lines scroll inside the bar. */
const QUEUE_LIST_MAX_HEIGHT = 180;

type Props = {
  /** Opens a saved draft in its form (App's handleContinueOfflineDraft). */
  onOpenDraft: (draftId: string, type: OfflineDraftType) => void;
};

/**
 * The upload bar (2026-10-02): background uploads at a glance on every main
 * screen, rendered once by App so it survives screen changes. It shows the
 * upload that is running, how many wait in line (tap to list them and pause
 * one), paused uploads with Resume and Open, and a notice when the server
 * accepts a report or one needs attention. Rules:
 * services/backgroundUploadManager.ts.
 *
 * It is docked below the screen, not laid over it: App renders it after the
 * screen in the same column, so the screen ends above it and nothing on the
 * screen is hidden behind it (Previews keeps its action bar at the bottom).
 * It takes no room when there is nothing to show. The report forms, the drawer
 * and other dialogs are full-screen modals and cover it while open.
 *
 * Pause is hidden while the submission is being finalized: that is when the
 * server accepts it, and pausing then would only lose the answer.
 */
export default function UploadBar({ onOpenDraft }: Props) {
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { active, queued, held, notices } = useBackgroundUploads();
  const [showQueue, setShowQueue] = useState(false);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // Each ordinary "Sent" notice gets one timer when it first appears; a later
  // change to the bar must not restart it. An acceptance this phone could not
  // record stays until dismissed (autoDismiss false).
  useEffect(() => {
    const live = new Set(notices.map((notice) => notice.id));
    for (const notice of notices) {
      if (notice.kind !== 'sent' || !notice.autoDismiss || timers.current.has(notice.id)) continue;
      timers.current.set(notice.id, setTimeout(() => {
        timers.current.delete(notice.id);
        backgroundUploadManager.dismiss(notice.id);
      }, SENT_NOTICE_MS));
    }
    for (const [id, timer] of Array.from(timers.current)) {
      if (live.has(id)) continue;
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, [notices]);
  useEffect(() => () => {
    for (const timer of Array.from(timers.current.values())) clearTimeout(timer);
    timers.current.clear();
  }, []);
  // The list closes by itself once nothing waits.
  useEffect(() => { if (!queued.length) setShowQueue(false); }, [queued.length]);

  // An upload the server accepted has nothing left to resume: once its notice is
  // dismissed it leaves the bar (its draft stays in Drafts), instead of a row
  // with no way to close it.
  const paused = held.filter((entry) => entry.status === 'paused' || (entry.durable && entry.status === 'attention' &&
    entry.canResume !== false && !notices.some(notice => notice.draftId === entry.draftId)));
  const actOnUpload = (action: () => unknown) => {
    void Promise.resolve().then(action).catch(error => Alert.alert('Upload needs attention',
      error instanceof Error ? error.message : 'The upload action could not be confirmed. Your draft and originals are kept.'));
  };
  const openDraft = (draftId: string, type: OfflineDraftType, durable = false, noticeId?: string) => actOnUpload(async () => {
    if (durable) await durableReportTransfer.releaseForEditing(draftId);
    if (noticeId) backgroundUploadManager.dismiss(noticeId);
    onOpenDraft(draftId, type);
  });
  if (!active && !queued.length && !paused.length && !notices.length) return null;
  const shownNotices = notices.slice(-MAX_NOTICE_ROWS);
  const olderNotices = notices.length - shownNotices.length;

  const renderNotice = (notice: BackgroundUploadNotice) => {
    const sent = notice.kind === 'sent';
    // An ordinary "Sent" needs no more words. An acceptance this phone could
    // not record says so, because its draft still offers Resume upload.
    const text = sent
      ? notice.autoDismiss ? `Sent: ${notice.title}` : `Sent: ${notice.title} — ${notice.message}`
      : `Needs attention: ${notice.title} — ${notice.message}`;
    return (
      <View key={notice.id} testID={`upload-notice-${notice.id}`}
        style={[styles.card, { borderLeftColor: sent ? colors.success : colors.warning }]}>
        <View style={styles.row}>
          <Feather name={sent ? 'check-circle' : 'alert-triangle'} size={18} color={sent ? colors.success : colors.warning} />
          <Text style={styles.text} numberOfLines={notice.autoDismiss ? 2 : 4} accessibilityRole={sent ? undefined : 'alert'}
            accessibilityLiveRegion="polite">
            {text}
          </Text>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={sent ? `Dismiss sent notice for ${notice.title}` : `Dismiss notice for ${notice.title}`}
            style={styles.iconButton} onPress={() => backgroundUploadManager.dismiss(notice.id)}>
            <Feather name="x" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
        {/* Own row: beside the text, Open and Resume squeezed it to a few letters a line. */}
        {!sent ? (
          <View style={styles.actionsRow}>
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Open ${notice.title}`} style={styles.button}
              onPress={() => openDraft(notice.draftId, notice.type, notice.id.startsWith('durable:'), notice.id)}>
              <Text style={styles.buttonText}>Open</Text>
            </TouchableOpacity>
            {notice.id.startsWith('durable:') && notice.canResume !== false ? (
              <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Resume upload of ${notice.title}`} style={styles.button}
                onPress={() => actOnUpload(() => backgroundUploadManager.resume(notice.jobId))}>
                <Text style={styles.buttonText}>Resume</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
      </View>
    );
  };

  const renderPaused = (entry: BackgroundUploadEntry) => (
    <View key={entry.id} testID={`upload-paused-${entry.id}`} style={[styles.card, { borderLeftColor: colors.textMuted }]}>
      <View style={styles.row}>
        <Feather name="pause-circle" size={18} color={colors.textSecondary} />
        <Text style={styles.text} numberOfLines={2}>
          {entry.status === 'attention' ? 'Needs attention' : 'Paused'}: {entry.title} · {entry.completedFiles} of {entry.totalFiles} sent
        </Text>
      </View>
      <View style={styles.actionsRow}>
        {entry.canResume !== false ? (
          <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Resume upload of ${entry.title}`} style={styles.button}
            onPress={() => actOnUpload(() => backgroundUploadManager.resume(entry.id))}>
            <Text style={styles.buttonText}>Resume</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Open ${entry.title}`} style={styles.button}
          onPress={() => openDraft(entry.draftId, entry.type, entry.durable)}>
          <Text style={styles.buttonText}>Open</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  // A report waiting in line can be paused from here, then opened or resumed.
  const renderQueued = (entry: BackgroundUploadEntry) => (
    <View key={entry.id} testID={`upload-queued-${entry.id}`} style={styles.row}>
      <Feather name="clock" size={16} color={colors.textSecondary} />
      <Text style={styles.text} numberOfLines={1}>In line: {entry.title} · {entry.totalFiles} files</Text>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Pause upload of ${entry.title}`} style={styles.button}
        onPress={() => actOnUpload(() => backgroundUploadManager.pause(entry.id))}>
        <Text style={styles.buttonText}>Pause</Text>
      </TouchableOpacity>
    </View>
  );

  const renderActive = (entry: BackgroundUploadEntry) => {
    const waiting = entry.status === 'waiting';
    const finalizing = entry.stage === 'finalizing' || entry.stage === 'complete';
    const counts = `${entry.completedFiles} of ${entry.totalFiles}`;
    const text = waiting
      ? `${entry.durable ? 'Waiting to continue' : 'Waiting for signal'} · ${counts} sent`
      : entry.pausing
        ? `Pausing ${entry.title}…`
        : finalizing
          ? `Finalizing ${entry.title}…`
          : `Uploading ${entry.title} · ${counts} files`;
    const percent = Math.max(0, Math.min(100, entry.percent || 0));
    return (
      <View testID="upload-bar-active" style={[styles.card, { borderLeftColor: waiting ? colors.warning : colors.info }]}>
        <View style={styles.row}>
          <Feather name={waiting ? 'wifi-off' : 'upload-cloud'} size={18} color={waiting ? colors.warning : colors.info} />
          <View style={styles.textBlock}>
            <Text style={styles.textLine} numberOfLines={2} accessibilityLiveRegion="polite">{text}</Text>
            {waiting ? <Text style={styles.secondary} numberOfLines={1}>{entry.title}</Text> : null}
            <Text style={styles.secondary}>{entry.durable ? 'Saved upload · Android continues the transfer' : 'Keep the app open while this upload runs'}</Text>
          </View>
          {!waiting && entry.canPause ? (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Pause upload of ${entry.title}`} style={styles.button}
              onPress={() => actOnUpload(() => backgroundUploadManager.pause(entry.id))}>
              <Text style={styles.buttonText}>Pause</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        {/* Waiting for signal: its two buttons get their own row. Beside the
            text they left it a sliver ("Waitin / g for …", 2026-10-11 phone test). */}
        {waiting ? (
          <View style={styles.actionsRow}>
            {!entry.durable ? (
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Resume upload now" style={styles.button}
                onPress={() => backgroundUploadManager.resumeNow()}>
                <Text style={styles.buttonText}>Resume now</Text>
              </TouchableOpacity>
            ) : null}
            {entry.canPause ? (
              <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Pause upload of ${entry.title}`} style={styles.button}
                onPress={() => actOnUpload(() => backgroundUploadManager.pause(entry.id))}>
                <Text style={styles.buttonText}>Pause</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
        {!waiting ? (
          <View style={styles.track} accessible accessibilityRole="progressbar" accessibilityLabel={`Upload of ${entry.title}`}
            accessibilityValue={{ min: 0, max: entry.totalFiles || 100, now: entry.totalFiles ? entry.completedFiles : percent }}>
            <View style={[styles.fill, { width: `${finalizing ? 100 : percent}%` }]} />
          </View>
        ) : null}
        {queued.length ? (
          <TouchableOpacity accessibilityRole="button" accessibilityState={{ expanded: showQueue }}
            accessibilityLabel={`${queued.length} more ${queued.length === 1 ? 'upload' : 'uploads'} waiting in line`}
            style={styles.queueToggle} onPress={() => setShowQueue((value) => !value)}>
            <Text style={styles.secondary}>+{queued.length} waiting</Text>
            <Feather name={showQueue ? 'chevron-down' : 'chevron-up'} size={16} color={colors.textSecondary} />
          </TouchableOpacity>
        ) : null}
        {showQueue ? (
          <ScrollView style={styles.queueList} nestedScrollEnabled keyboardShouldPersistTaps="handled">
            {queued.map(renderQueued)}
          </ScrollView>
        ) : null}
      </View>
    );
  };

  return (
    <View testID="upload-bar" style={[styles.wrap, { paddingBottom: insets.bottom + 8 }]}>
      <View style={styles.stack}>
        {olderNotices > 0 ? (
          <Text style={[styles.secondary, styles.more]}>
            +{olderNotices} earlier {olderNotices === 1 ? 'notice' : 'notices'} · Drafts shows each report&apos;s status
          </Text>
        ) : null}
        {shownNotices.map(renderNotice)}
        {paused.slice(0, MAX_PAUSED_ROWS).map(renderPaused)}
        {paused.length > MAX_PAUSED_ROWS ? (
          <Text style={[styles.secondary, styles.more]}>+{paused.length - MAX_PAUSED_ROWS} more paused · open Drafts to see them</Text>
        ) : null}
        {active ? renderActive(active) : null}
        {!active && queued.length ? <ScrollView style={styles.queueList} nestedScrollEnabled>{queued.map(renderQueued)}</ScrollView> : null}
      </View>
    </View>
  );
}

const createStyles = (colors: AppThemeColors) => StyleSheet.create({
  wrap: {
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 8,
    backgroundColor: colors.background,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  stack: { width: '100%', maxWidth: 560, gap: 8 },
  card: {
    backgroundColor: colors.surfaceRaised,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: 4,
    borderRadius: 12,
    paddingVertical: 4,
    paddingLeft: 12,
    paddingRight: 4,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44 },
  actionsRow: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8 },
  textBlock: { flex: 1, paddingVertical: 4 },
  text: { flex: 1, color: colors.text, fontSize: 14, paddingVertical: 6 },
  textLine: { color: colors.text, fontSize: 14, fontWeight: '600' },
  secondary: { color: colors.textSecondary, fontSize: 12 },
  more: { textAlign: 'center' },
  button: { minHeight: 44, minWidth: 44, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: colors.info, fontSize: 14, fontWeight: '700' },
  iconButton: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  track: { height: 4, borderRadius: 2, backgroundColor: colors.surfaceMuted, marginRight: 8, marginBottom: 8, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2, backgroundColor: colors.info },
  queueToggle: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', paddingRight: 12 },
  queueList: { maxHeight: QUEUE_LIST_MAX_HEIGHT },
});
