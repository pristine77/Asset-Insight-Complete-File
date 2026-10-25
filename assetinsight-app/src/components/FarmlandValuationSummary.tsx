import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

type SavedValuation = {
  fair_market_value?: string | number;
  farmland_valuation?: {
    fair_market_value_formatted?: string;
    fair_market_value?: number;
    approaches_used?: {
      direct_comparable?: boolean;
      income_capitalization?: boolean;
      cost_approach?: boolean;
    };
  };
};

export default function FarmlandValuationSummary({ preview }: { preview: SavedValuation }) {
  const saved = preview.farmland_valuation;
  const value = saved?.fair_market_value_formatted?.trim() || (preview.fair_market_value ?? saved?.fair_market_value);
  const displayValue = typeof value === 'number'
    ? Number.isFinite(value) ? new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(value) : 'Not available'
    : value || 'Not available';
  const labels = [
    saved?.approaches_used?.direct_comparable && 'Direct comparable',
    saved?.approaches_used?.income_capitalization && 'Income capitalization',
    saved?.approaches_used?.cost_approach && 'Cost approach',
  ].filter(Boolean);

  return (
    <View style={styles.container}>
      <Text style={styles.label}>Calculated farmland value</Text>
      <Text selectable style={styles.value}>{displayValue}</Text>
      <Text style={styles.methods}>Saved methods: {labels.length ? labels.join(' · ') : 'Not recorded'}</Text>
      <Text style={styles.note}>Saved estimate, not a live calculation. Editing preview fields does not recalculate this value. Manual valuation fields below are separate.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 12, marginBottom: 12, borderRadius: 8, borderWidth: 1, borderColor: '#BFDBFE', backgroundColor: '#EFF6FF' },
  label: { color: '#1E3A8A', fontSize: 13, fontWeight: '600' },
  value: { color: '#1E3A8A', fontSize: 20, fontWeight: '700', marginTop: 4 },
  methods: { color: '#1E40AF', fontSize: 12, marginTop: 6 },
  note: { color: '#475569', fontSize: 12, lineHeight: 17, marginTop: 6 },
});
