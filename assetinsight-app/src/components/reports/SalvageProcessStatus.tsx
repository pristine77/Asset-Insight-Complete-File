import React, { useMemo } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme, type AppThemeColors } from '../../context/ThemeContext';
import { isSalvageGenerating, type SalvageReport } from '../../services/salvageService';
import { salvageDisplayText } from '../../utils/salvageDisplayText';

interface Props {
  report: SalvageReport;
  busy: boolean;
  stopping: boolean;
  canOpen: boolean;
  readOnly: boolean;
  onOpen: () => void;
  onStop: () => void;
  onRetry: () => void;
}
export default function SalvageProcessStatus({
  report,
  busy,
  stopping,
  canOpen,
  readOnly,
  onOpen,
  onStop,
  onRetry,
}: Props) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const active = isSalvageGenerating(report);
  const failed = report.status === 'error' || report.generation_state === 'error';
  const stopped = report.workflow_stage === 'stopped';
  const title = stopping
    ? 'Stopping report processing…'
    : active
      ? report.files_generating || report.workflow_stage === 'generating_files'
        ? 'Generating report files'
        : 'Preparing preview'
      : stopped
        ? 'Processing stopped'
        : failed
          ? 'Processing needs attention'
          : report.files_ready
            ? 'Report files ready'
            : 'Preview ready';
  const percent = Math.max(0, Math.min(100, Number(report.workflow_progress_percent) || 0));
  return (
    <View style={styles.panel}>
      <Text style={styles.heading}>{title}</Text>
      {active || stopping ? <ActivityIndicator color={colors.accent} /> : null}
      <Text style={styles.text}>
        {salvageDisplayText(
          report.workflow_message || 'Your report and saved progress remain available here.'
        )}
      </Text>
      {active ? (
        <>
          <View
            accessibilityRole="progressbar"
            accessibilityLabel="Report progress"
            accessibilityValue={{ min: 0, max: 100, now: percent }}
            style={styles.track}>
            <View style={[styles.fill, { width: `${percent}%` }]} />
          </View>
          <Text style={styles.muted}>
            {Math.round(percent)}% · You can leave and reopen this report. Processing continues on
            the server.
          </Text>
        </>
      ) : null}
      {report.workflow_steps?.map((step) => (
        <View key={step.key} style={styles.step}>
          <Text style={step.status === 'active' ? styles.link : styles.muted}>
            {step.status === 'completed' ? '✓' : step.status === 'active' ? '●' : '○'}
          </Text>
          <Text style={styles.stepLabel}>{salvageDisplayText(step.label)}</Text>
          <Text style={styles.muted}>{step.status}</Text>
        </View>
      ))}
      {report.job_error ? (
        <Text style={styles.warning}>{salvageDisplayText(report.job_error)}</Text>
      ) : null}
      {!readOnly && active && report.can_cancel === true && report.job_id ? (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Stop processing"
          disabled={busy || stopping}
          onPress={onStop}
          style={styles.button}>
          <Text style={styles.warning}>
            {stopping ? 'Waiting for stop confirmation…' : 'Stop processing'}
          </Text>
        </TouchableOpacity>
      ) : null}
      {stopping ? (
        <Text style={styles.warning}>
          Wait for server confirmation before editing. Leaving this screen does not cancel work.
        </Text>
      ) : null}
      {!active && !stopping && canOpen ? (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Open preview"
          disabled={busy}
          onPress={onOpen}
          style={styles.button}>
          <Text style={styles.link}>Open preview</Text>
        </TouchableOpacity>
      ) : null}
      {!active && !stopping && !readOnly && (failed || stopped) ? (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Retry processing"
          disabled={busy}
          onPress={onRetry}
          style={styles.button}>
          <Text style={styles.link}>{stopped ? 'Resume processing' : 'Retry processing'}</Text>
        </TouchableOpacity>
      ) : null}
      {!active && !canOpen && !failed && !stopped ? (
        <Text style={styles.muted}>
          The preview is not available yet. Refresh to check the latest saved status.
        </Text>
      ) : null}
    </View>
  );
}
const createStyles = (c: AppThemeColors) =>
  StyleSheet.create({
    panel: {
      padding: 16,
      gap: 12,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 8,
      backgroundColor: c.surface,
    },
    heading: { color: c.text, fontSize: 18, fontWeight: '700' },
    text: { color: c.text, fontSize: 14, lineHeight: 21 },
    muted: { color: c.textSecondary, fontSize: 12, lineHeight: 18 },
    warning: { color: c.warning, fontSize: 13, lineHeight: 20 },
    link: { color: c.accent, fontSize: 14, fontWeight: '600' },
    track: { height: 8, borderRadius: 4, backgroundColor: c.border, overflow: 'hidden' },
    fill: { height: 8, backgroundColor: c.accent },
    step: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 40 },
    stepLabel: { flex: 1, color: c.text, fontSize: 13 },
    button: {
      minHeight: 48,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 6,
      paddingHorizontal: 12,
    },
  });
