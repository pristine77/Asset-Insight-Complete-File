import React, { memo, useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useAppTheme } from '../../context/ThemeContext';
import type { MixedLot } from '../camera/types';
import LotPhotoCounts from '../LotPhotoCounts';

type Props = { mode: 'online' | 'offline'; onChange: (value: 'online' | 'offline') => void;
  lots: MixedLot[]; savedAt?: string; error?: string; disabled?: boolean; paused?: boolean; manualSubmissionRequired?: boolean; reviewingSavedDraft?: boolean; onSave: () => void; onPause?: () => void };

export default memo(function OfflineCapturePanel({ mode, onChange, lots, savedAt, error, disabled, paused, manualSubmissionRequired, reviewingSavedDraft, onSave, onPause }: Props) {
  const { colors } = useAppTheme();
  const counts = useMemo(() => lots.map(lot => ({ id: lot.id, lotNumber: lot.lotNumber,
    images: lot.files.length + lot.extraFiles.length, extraImages: lot.extraFiles.length,
    missingImages: lot.files.reduce((sum, photo) => sum + Number(photo.availability === 'missing' || photo.missing === true), 0)
      + lot.extraFiles.reduce((sum, photo) => sum + Number(photo.availability === 'missing' || photo.missing === true), 0),
  })), [lots]);
  const images = counts.reduce((sum, lot) => sum + lot.images, 0);
  const extra = counts.reduce((sum, lot) => sum + lot.extraImages, 0);
  const missing = counts.reduce((sum, lot) => sum + lot.missingImages, 0);
  const statusColor = error ? colors.danger : savedAt ? colors.success : colors.textMuted;
  return <View style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <Text style={[styles.heading, { color: colors.text }]}>Capture mode</Text>
    <View accessibilityRole="radiogroup" style={[styles.segments, { backgroundColor: colors.surfaceMuted }]}>
      {(['online', 'offline'] as const).map((value) => {
        const selected = mode === value;
        return <TouchableOpacity key={value} accessibilityRole="radio"
          accessibilityLabel={`${value === 'online' ? 'Online' : 'Offline'} capture`} accessibilityState={{ checked: selected, disabled }}
          disabled={disabled} onPress={() => onChange(value)} style={[styles.segment, selected && { backgroundColor: colors.accent }]}>
          <Feather name={value === 'online' ? 'wifi' : 'wifi-off'} size={16} color={selected ? colors.accentText : colors.textSecondary} />
          <Text style={[styles.segmentText, { color: selected ? colors.accentText : colors.textSecondary }, selected && styles.strong]}>{value === 'online' ? 'Online' : 'Offline'}</Text>
        </TouchableOpacity>;
      })}
    </View>
    {onPause ? <TouchableOpacity accessibilityRole="button" onPress={onPause} style={[styles.outlineButton, { borderColor: colors.border }]}>
      <Text style={[styles.strong, { color: colors.accent }]}>Pause upload</Text>
    </TouchableOpacity> : null}
    {mode === 'offline' || manualSubmissionRequired ? <>
      <View style={styles.statusRow}>
        <Feather name={error ? 'alert-circle' : savedAt ? 'check-circle' : 'clock'} size={18} color={statusColor} style={styles.statusIcon} />
        <View style={styles.flex}>
          <Text accessibilityLiveRegion="polite" style={[styles.strong, { color: statusColor }]}>{error ? 'Save needs attention' : savedAt ? 'Saved on this device' : 'Not saved yet'}</Text>
          {savedAt ? <Text style={[styles.small, { color: colors.textMuted }]}>{new Date(savedAt).toLocaleString()}</Text> : null}
        </View>
      </View>
      <View style={[styles.infoBox, { backgroundColor: colors.infoSoft }]}>
        <Feather name="info" size={16} color={colors.info} style={styles.statusIcon} />
        <View style={[styles.flex, styles.infoText]}>
          <Text style={[styles.small, { color: colors.textSecondary }]}>Only counts and activity sync automatically. Photos are not cloud-backed up. Keep the original photos on this device.</Text>
          <Text style={[styles.small, { color: colors.textSecondary }]}>{mode === 'offline' && !reviewingSavedDraft
            ? 'Tap Save to finish on this device. Later, choose Open and submit in Drafts → Offline captures.'
            : `Review your restored details, lot order and photos. Connect and tap ${paused ? 'Resume upload' : 'Submit'} when ready. Opening this draft does not upload anything.`}</Text>
        </View>
      </View>
      {error ? <Text accessibilityRole="alert" style={{ color: colors.danger }}>{error}</Text> : null}
      <TouchableOpacity accessibilityRole="button" disabled={disabled} onPress={onSave} style={[styles.saveButton, { backgroundColor: colors.accentSoft }]}>
        <Feather name="save" size={17} color={colors.accent} />
        <Text style={[styles.strong, { color: colors.accent }]}>Save on device</Text>
      </TouchableOpacity>
    </> : null}
    <View style={styles.stats}>
      {([[lots.length, 'Lots'], [images, 'Photos'], [extra, 'Report-only']] as const).map(([value, label]) =>
        <View key={label} style={[styles.stat, { backgroundColor: colors.surfaceMuted }]}>
          <Text numberOfLines={2} adjustsFontSizeToFit style={[styles.statValue, { color: colors.text }]}>{value}{'\n'}<Text style={[styles.small, { color: colors.textMuted }]}>{label}</Text></Text>
        </View>)}
    </View>
    {missing ? <Text style={{ color: colors.danger }}>{missing} missing</Text> : null}
    <View style={[styles.divider, { borderTopColor: colors.border }]}>
      <LotPhotoCounts lots={counts} />
    </View>
  </View>;
});

const styles = StyleSheet.create({ panel: { borderWidth: 1, borderRadius: 12, padding: 14, marginVertical: 8, gap: 12 },
  heading: { fontWeight: '600', fontSize: 15 }, strong: { fontWeight: '600' }, small: { fontSize: 13, lineHeight: 18 }, flex: { flex: 1 },
  segments: { flexDirection: 'row', borderRadius: 10, padding: 4, gap: 4 },
  segment: { flex: 1, minHeight: 44, borderRadius: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  segmentText: { fontSize: 15 },
  outlineButton: { minHeight: 44, paddingHorizontal: 12, borderWidth: 1, borderRadius: 10, justifyContent: 'center' },
  statusRow: { flexDirection: 'row', gap: 8 }, statusIcon: { marginTop: 1 },
  infoBox: { flexDirection: 'row', gap: 8, borderRadius: 10, padding: 10 }, infoText: { gap: 6 },
  saveButton: { minHeight: 44, borderRadius: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  stats: { flexDirection: 'row', gap: 8 }, stat: { flex: 1, borderRadius: 8, paddingVertical: 8, alignItems: 'center' },
  statValue: { fontSize: 18, fontWeight: '600', textAlign: 'center' },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 4 } });
