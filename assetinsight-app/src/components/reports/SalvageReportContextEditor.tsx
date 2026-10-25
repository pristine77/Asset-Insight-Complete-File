import React, { useMemo, useState } from 'react';
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useAppTheme, type AppThemeColors } from '../../context/ThemeContext';
import type { SalvageReportContext } from '../../types/salvageReportEnrichment';

const FIELDS: ReadonlyArray<[keyof SalvageReportContext, string]> = [
  ['intended_use', 'Intended use'],
  ['scope_of_work', 'Scope of work'],
  ['valuation_premise', 'Valuation premise'],
  ['pre_loss_condition', 'Pre-loss condition'],
  ['inspection_basis', 'Inspection basis'],
  ['repair_estimate_status', 'Repair estimate status'],
  ['repair_estimate_date', 'Repair estimate date'],
  ['lead_time_notes', 'Parts and repair lead-time notes'],
  ['market_context', 'Market context'],
  ['reconciliation_notes', 'Reconciliation notes'],
  ['appraiser_conclusion', 'Appraiser conclusion'],
  ['client_comments', 'Client comments'],
];
interface Props {
  context?: SalvageReportContext;
  disabled?: boolean;
  onChange: (context: SalvageReportContext) => void;
}

export default function SalvageReportContextEditor({ context, disabled = false, onChange }: Props) {
  const { colors } = useAppTheme();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={styles.panel}>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Appraiser report notes"
        accessibilityState={{ expanded }}
        style={styles.button}
        onPress={() => setExpanded(!expanded)}>
        <Text style={styles.heading}>Appraiser report notes</Text>
        <Text style={styles.toggle}>{expanded ? '−' : '+'}</Text>
      </TouchableOpacity>
      {expanded ? (
        <View style={styles.content}>
          <Text style={styles.muted}>
            Optional appraiser-authored context, not verified findings. Notes do not establish a
            legal brand, roadworthiness or a supported value. Saving keeps them separate from photo
            evidence and does not start new research.
          </Text>
          <View style={styles.fields}>
            {FIELDS.map(([key, label]) => {
              const isDate = key === 'repair_estimate_date';
              return (
                <View key={key} style={styles.field}>
                  <Text style={styles.label}>{label}</Text>
                  <TextInput
                    accessibilityLabel={`Report notes: ${label}`}
                    value={context?.[key] ?? ''}
                    editable={!disabled}
                    maxLength={isDate ? 10 : 6000}
                    multiline={!isDate}
                    keyboardType={isDate ? 'numbers-and-punctuation' : 'default'}
                    autoCapitalize={isDate ? 'none' : 'sentences'}
                    placeholder={isDate ? 'YYYY-MM-DD · optional' : 'Not provided · optional'}
                    placeholderTextColor={colors.textMuted}
                    style={[styles.input, !isDate && styles.multiline, disabled && styles.disabled]}
                    onChangeText={(next) => {
                      if (!disabled) onChange({ ...context, [key]: next.trim() ? next : null });
                    }}
                  />
                </View>
              );
            })}
          </View>
        </View>
      ) : null}
    </View>
  );
}

const createStyles = (c: AppThemeColors) =>
  StyleSheet.create({
    panel: { borderColor: c.border, borderWidth: 1, borderRadius: 8, backgroundColor: c.surface },
    button: { padding: 12, minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12 },
    heading: { flex: 1, color: c.text, fontSize: 16, fontWeight: '700' },
    toggle: { color: c.accent, fontSize: 20 },
    content: { padding: 12, paddingTop: 0, gap: 12 },
    muted: { color: c.textSecondary, fontSize: 12, lineHeight: 18 },
    fields: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
    field: { flexBasis: 280, flexGrow: 1, flexShrink: 1, minWidth: 0, maxWidth: '100%', gap: 5 },
    label: { color: c.textSecondary, fontSize: 13, fontWeight: '600' },
    input: {
      backgroundColor: c.background,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 6,
      padding: 10,
      minHeight: 44,
      color: c.text,
      fontSize: 14,
    },
    multiline: { minHeight: 88, maxHeight: 180, textAlignVertical: 'top' },
    disabled: { opacity: 0.8 },
  });
