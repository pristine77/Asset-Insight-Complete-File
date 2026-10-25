import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from '../context/ThemeContext';
import CaptureBackupService, { type BackupStatus } from '../services/captureBackupService';

export function describeCaptureBackup(job: BackupStatus): string {
  const count = `Backed up ${job.verified} of ${job.total} files`;
  switch (job.status) {
    case 'completed': return job.total === 0 && job.verified === 0 ? 'No files in this saved revision'
      : job.total > 0 && job.verified === job.total ? `${(job.retainedEarlierRevisionsPending || 0) > 0 ? 'Current revision verified' : 'Fully backed up'} · ${job.total} files` : `${count} · verification pending`;
    case 'paused': return `${count} · ${job.pauseReason === 'draft_deleted' ? 'paused after draft deletion' : 'paused'}`;
    case 'waiting_network': return `${count} · waiting for an allowed network`;
    case 'interrupted': return `${count} · interrupted; safe to resume`;
    case 'auth_required': return `${count} · open the app online to renew authorization`;
    case 'needs_attention': return `${count} · needs attention`;
    case 'uploading': return `${count} · backing up`;
    default: return `${count} · queued on this phone`;
  }
}

export default function CaptureBackupPanel() {
  const { colors } = useAppTheme();
  const backup = useSyncExternalStore(CaptureBackupService.subscribe, CaptureBackupService.getSnapshot, CaptureBackupService.getSnapshot);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(5);
  const operation = useRef(0);
  const locked = useRef(false);
  useEffect(() => { operation.current++; locked.current = false; setBusy(undefined); setError(''); setLimit(5); }, [backup.ownerId]);
  if (!backup.supported || !backup.ownerId) return null;
  const act = async (key: string, work: () => Promise<unknown>, interrupt = false) => {
    if (locked.current && !interrupt) return;
    locked.current = true;
    const run = ++operation.current;
    setBusy(key); setError('');
    try { await work(); }
    catch { if (run === operation.current) setError('The backup control could not be saved. Keep your originals and try again.'); }
    finally { if (run === operation.current) { locked.current = false; setBusy(undefined); } }
  };
  const enabled = backup.consent === 'enabled';
  return <View style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <Text style={[styles.title, { color: colors.text }]}>Photo cloud backup</Text>
    <Text style={{ color: colors.textSecondary }}>Optional: after you enable cloud backup, Asset Insight uploads photos, videos and report details from saved Asset and Lot Listing drafts to its private cloud storage. Uploads can continue in the background even when this app is closed, using Wi-Fi / unmetered networks by default.</Text>
    <Text style={{ color: colors.textSecondary }}>Backup works separately from report submission and never submits a report automatically. Originals stay on this phone. You can pause or resume a draft backup, or turn cloud backup off here. Turning it off stops future uploads; it does not delete originals or earlier cloud backups.</Text>
    <TouchableOpacity accessibilityRole="link" style={styles.button} onPress={() => { void act('privacy', () => Linking.openURL('https://assetinsightvaluator.com/privacy')); }}>
      <Text style={{ color: colors.accent }}>Privacy policy</Text>
    </TouchableOpacity>
    {!enabled ? <View>
      <Text style={{ color: colors.text }}>{backup.consent === 'loading' ? 'Checking your backup choice…' : 'Cloud backup is off. Your saved photos and videos stay on this phone unless you upload or submit them.'}</Text>
      <TouchableOpacity accessibilityRole="button" style={styles.button} disabled={Boolean(busy) || backup.consent === 'loading'}
        accessibilityState={{ disabled: Boolean(busy) || backup.consent === 'loading' }}
        onPress={() => { void act('enable', () => CaptureBackupService.setConsent(true)); }}>
        {busy === 'enable' ? <ActivityIndicator color={colors.accent} /> : <Text style={{ color: colors.accent, fontWeight: '600' }}>Enable cloud backup</Text>}
      </TouchableOpacity>
      <TouchableOpacity accessibilityRole="button" style={styles.button} disabled={busy === 'decline'}
        accessibilityState={{ disabled: busy === 'decline' }}
        onPress={() => { void act('decline', () => CaptureBackupService.setConsent(false), true); }}>
        <Text style={{ color: colors.accent }}>Not now — keep cloud backup off</Text>
      </TouchableOpacity>
    </View> : <TouchableOpacity accessibilityRole="button" style={styles.button} disabled={busy === 'disable'}
      onPress={() => { void act('disable', () => CaptureBackupService.setConsent(false), true); }}>
      <Text style={{ color: colors.accent, fontWeight: '600' }}>Turn off cloud backup</Text>
    </TouchableOpacity>}
    {backup.error || error ? <Text accessibilityRole="alert" style={{ color: colors.warning }}>{error || backup.error}</Text> : null}
    {enabled ? <>
    <View style={styles.row}>
      <Text style={[styles.flex, { color: colors.text }]}>Allow mobile data</Text>
      <Switch accessibilityLabel="Allow mobile data for photo backups" disabled={Boolean(busy)} value={backup.networkPolicy === 'connected'}
        onValueChange={enabled => { void act('network', () => CaptureBackupService.setNetworkPolicy(enabled ? 'connected' : 'unmetered')); }} />
    </View>
    <Text style={{ color: colors.textSecondary }}>{backup.networkPolicy === 'unmetered' ? 'Wi-Fi / unmetered networks only.' : 'Backups can use mobile data and may incur data charges.'} Android may defer background work. Force-stop requires reopening the app.</Text>
    {!backup.jobs.length ? <Text style={{ color: colors.textSecondary }}>No backup queued yet. Saved offline drafts will appear here.</Text> : null}
    {backup.jobs.slice(0, limit).map(job => {
      const earlierPending = (job.retainedEarlierRevisionsPending || 0) > 0;
      const resume = ['paused', 'interrupted', 'auth_required', 'needs_attention'].includes(job.status)
        || (earlierPending && ['paused', 'interrupted', 'auth_required', 'needs_attention'].includes(job.retainedEarlierRevisionsStatus || ''));
      const completed = job.status === 'completed' && job.verified === job.total && !earlierPending;
      return <View key={job.clientDraftId} style={[styles.job, { borderColor: colors.border }]}>
        <Text style={{ color: colors.text, fontWeight: '600' }}>{job.contractNo || job.title || 'Saved draft'}</Text>
        <Text accessibilityLiveRegion="polite" style={{ color: colors.textSecondary }}>{describeCaptureBackup(job)}</Text>
        {earlierPending ? <Text style={{ color: colors.textSecondary }}>Earlier saved revision {resume ? 'needs to resume' : 'still backing up'}. Its original photos are retained separately.</Text> : null}
        {job.message ? <Text style={{ color: colors.textSecondary }}>{job.message}</Text> : null}
        {!completed && job.pauseReason !== 'draft_deleted' ? <TouchableOpacity accessibilityRole="button" accessibilityLabel={`${resume ? 'Resume' : 'Pause'} backup ${job.contractNo || job.clientDraftId}`}
          accessibilityState={{ disabled: Boolean(busy) }} disabled={Boolean(busy)} style={styles.button}
          onPress={() => { void act(job.clientDraftId, () => resume ? CaptureBackupService.resume(job.clientDraftId) : CaptureBackupService.pause(job.clientDraftId)); }}>
          {busy === job.clientDraftId ? <ActivityIndicator color={colors.accent} /> : <Text style={{ color: colors.accent, fontWeight: '600' }}>{resume ? 'Resume backup' : 'Pause backup'}</Text>}
        </TouchableOpacity> : null}
      </View>;
    })}
    {backup.jobs.length > limit ? <TouchableOpacity accessibilityRole="button" style={styles.button} onPress={() => setLimit(value => value + 5)}><Text style={{ color: colors.accent }}>Show more backups</Text></TouchableOpacity> : null}
    <TouchableOpacity accessibilityRole="button" style={styles.button} disabled={Boolean(busy)} onPress={() => { void act('refresh', () => CaptureBackupService.tick()); }}><Text style={{ color: colors.accent }}>Refresh backup status</Text></TouchableOpacity>
    </> : null}
  </View>;
}
const styles = StyleSheet.create({ panel: { borderWidth: 1, borderRadius: 12, padding: 16, marginVertical: 12, gap: 10 }, title: { fontSize: 18, fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 }, flex: { flex: 1 }, job: { borderTopWidth: 1, paddingTop: 12, gap: 6 }, button: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 8 } });
