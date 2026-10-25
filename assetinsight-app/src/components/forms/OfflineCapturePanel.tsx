import React, { memo, useMemo } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
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
  return <View style={[styles.panel, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <Text style={[styles.heading, { color: colors.text }]}>Capture mode</Text>
    <View accessibilityRole="radiogroup" style={styles.row}>
      {(['online', 'offline'] as const).map((value) => <TouchableOpacity key={value} accessibilityRole="radio"
        accessibilityLabel={`${value === 'online' ? 'Online' : 'Offline'} capture`} accessibilityState={{ checked: mode === value, disabled }}
        disabled={disabled} onPress={() => onChange(value)} style={[styles.option, { borderColor: mode === value ? colors.accent : colors.border }]}>
        <Text style={{ color: colors.text }}>{mode === value ? '◉' : '○'} {value === 'online' ? 'Online' : 'Offline'}</Text>
      </TouchableOpacity>)}
    </View>
    {onPause ? <TouchableOpacity accessibilityRole="button" onPress={onPause} style={[styles.option, { borderColor: colors.border }]}>
      <Text style={{ color: colors.accent }}>Pause upload</Text>
    </TouchableOpacity> : null}
    {mode === 'offline' || manualSubmissionRequired ? <>
      <Text accessibilityLiveRegion="polite" style={{ color: colors.text }}>{error ? 'Save needs attention' : savedAt ? 'Saved on this device' : 'Not saved yet'}{savedAt ? ` · ${new Date(savedAt).toLocaleString()}` : ''}</Text>
      <Text style={{ color: colors.textSecondary }}>Only counts and activity sync automatically. Photos are not cloud-backed up. Keep the original photos on this device.</Text>
      <Text style={{ color: colors.textSecondary }}>{mode === 'offline' && !reviewingSavedDraft
        ? 'Tap Save to finish on this device. Later, choose Open and submit in Drafts → Offline captures.'
        : `Review your restored details, lot order and photos. Connect and tap ${paused ? 'Resume upload' : 'Submit'} when ready. Opening this draft does not upload anything.`}</Text>
      {error ? <Text accessibilityRole="alert" style={{ color: colors.text }}>{error}</Text> : null}
      <TouchableOpacity accessibilityRole="button" disabled={disabled} onPress={onSave} style={[styles.option, { borderColor: colors.border }]}>
        <Text style={{ color: colors.accent }}>Save on device</Text>
      </TouchableOpacity>
    </> : null}
    <Text style={{ color: colors.textSecondary }}>{lots.length} lots · {images} photos ({extra} report-only){missing ? ` · ${missing} missing` : ''}</Text>
    <LotPhotoCounts lots={counts} />
  </View>;
});

const styles = StyleSheet.create({ panel: { borderWidth: 1, borderRadius: 8, padding: 12, marginVertical: 8, gap: 8 },
  heading: { fontWeight: '600', fontSize: 15 }, row: { flexDirection: 'row', gap: 8 },
  option: { minHeight: 44, padding: 12, borderWidth: 1, borderRadius: 6, justifyContent: 'center', flexShrink: 1 } });
