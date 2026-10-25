import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  CONDITION_SELECTION_GROUPS,
  normalizeConditionSelection,
  type ConditionSelectionKey,
} from '../../utils/conditionSelections';

type Selections = Record<string, string> | undefined;
type SelectionProps = {
  accent: string;
  disabled: boolean;
  onChange: (field: ConditionSelectionKey, value: string) => void;
};

function ConditionOptions({
  accent,
  disabled,
  onChange,
  selections,
  labelSuffix,
}: SelectionProps & { selections: Selections; labelSuffix: string }) {
  return (
    <View style={styles.groups}>
      {CONDITION_SELECTION_GROUPS.map((group) => (
        <View key={group.key} style={styles.group}>
          <Text accessibilityRole="header" style={styles.groupLabel}>
            {group.label}
          </Text>
          <View style={styles.options}>
            {group.options.map((option) => {
              const selected =
                normalizeConditionSelection(selections?.[group.key]) ===
                normalizeConditionSelection(option);
              return (
                <Pressable
                  key={option}
                  accessibilityRole="button"
                  accessibilityLabel={`${group.label}: ${option} ${labelSuffix}`}
                  accessibilityState={{ selected, disabled }}
                  disabled={disabled}
                  onPress={() => onChange(group.key, option)}
                  style={[
                    styles.option,
                    selected && { borderColor: accent, backgroundColor: `${accent}10` },
                    disabled && styles.disabled,
                  ]}>
                  <Text style={[styles.optionText, selected && { color: accent }]}>{option}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
    </View>
  );
}

export function AssetBulkConditionControls({
  lots,
  indexes,
  accent,
  disabled,
  onChange,
  onSelectAll,
  onClear,
}: SelectionProps & {
  lots: Array<{ condition_report_selections?: Record<string, string> }>;
  indexes: ReadonlySet<number>;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  if (lots.length < 2) return null;
  const selectedLots = lots.filter((_, index) => indexes.has(index));
  const common: Record<string, string> = {};
  CONDITION_SELECTION_GROUPS.forEach(({ key }) => {
    const first = selectedLots[0]?.condition_report_selections?.[key];
    if (
      first &&
      selectedLots.every(
        (lot) =>
          normalizeConditionSelection(lot.condition_report_selections?.[key]) ===
          normalizeConditionSelection(first)
      )
    )
      common[key] = first;
  });
  return (
    <View style={styles.bulk}>
      <Text accessibilityRole="header" style={styles.title}>
        Update selected lots
      </Text>
      <Text style={styles.note}>
        Select lots below, then choose a value. Each choice changes only that group. Individual
        overrides remain available.
      </Text>
      <Text accessibilityLiveRegion="polite" style={styles.count}>
        {selectedLots.length} of {lots.length} lots selected
      </Text>
      <View style={styles.options}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Select all ${lots.length} lots`}
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={onSelectAll}
          style={[styles.option, disabled && styles.disabled]}>
          <Text style={[styles.optionText, { color: accent }]}>Select all {lots.length} lots</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear lot selection"
          accessibilityState={{ disabled: disabled || !selectedLots.length }}
          disabled={disabled || !selectedLots.length}
          onPress={onClear}
          style={[styles.option, (disabled || !selectedLots.length) && styles.disabled]}>
          <Text style={styles.optionText}>Clear selection</Text>
        </Pressable>
      </View>
      <ConditionOptions
        accent={accent}
        disabled={disabled || !selectedLots.length}
        onChange={onChange}
        selections={common}
        labelSuffix="to selected lots"
      />
    </View>
  );
}

/** Collapsed by default: large reports do not mount every lot's option panels. */
export function AssetLotConditionEditor({
  lotNumber,
  selections,
  ...props
}: SelectionProps & { lotNumber: string; selections: Selections }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={styles.editor}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Edit required selections for lot ${lotNumber}`}
        accessibilityState={{ expanded, disabled: props.disabled }}
        disabled={props.disabled}
        onPress={() => setExpanded((value) => !value)}
        style={styles.expand}>
        <Text style={styles.groupLabel}>Required selections {expanded ? '−' : '+'}</Text>
        <Text style={styles.note}>
          {CONDITION_SELECTION_GROUPS.map(
            (group) => `${group.label}: ${selections?.[group.key] || 'Not selected'}`
          ).join(' · ')}
        </Text>
      </Pressable>
      {expanded ? (
        <View style={styles.editorOptions}>
          <ConditionOptions
            {...props}
            selections={selections}
            labelSuffix={`for lot ${lotNumber}`}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bulk: {
    marginBottom: 16,
    padding: 14,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 10,
    gap: 10,
  },
  title: { fontSize: 16, lineHeight: 22, fontWeight: '700', color: '#111827' },
  note: { fontSize: 12, lineHeight: 18, color: '#475569', flexShrink: 1 },
  count: { fontSize: 13, fontWeight: '700', color: '#1F2937' },
  groups: { gap: 12 },
  group: { gap: 6 },
  groupLabel: { fontSize: 13, lineHeight: 19, fontWeight: '700', color: '#1F2937' },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  option: {
    minHeight: 44,
    maxWidth: '100%',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 7,
    paddingHorizontal: 10,
    paddingVertical: 8,
    justifyContent: 'center',
    flexShrink: 1,
  },
  optionText: { fontSize: 13, lineHeight: 19, color: '#334155', flexShrink: 1 },
  disabled: { opacity: 0.45 },
  editor: {
    marginBottom: 14,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#CBD5E1',
    borderRadius: 8,
  },
  expand: { padding: 12, minHeight: 44, gap: 6 },
  editorOptions: { padding: 12, paddingTop: 0 },
});
