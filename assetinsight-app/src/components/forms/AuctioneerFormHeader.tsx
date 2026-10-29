import React from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useAppTheme } from '../../context/ThemeContext';
import type { AuctioneerWorkItemSetup } from '../../services/auctioneerService';

export default function AuctioneerFormHeader({ setup, disabled, closeDisabled, submitting, paused, onPress, onSubmit }: {
  setup: AuctioneerWorkItemSetup;
  disabled: boolean;
  closeDisabled: boolean;
  submitting: boolean;
  paused: boolean;
  onPress: () => void;
  onSubmit: () => void;
}) {
  const { colors } = useAppTheme();
  return <View style={[styles.container, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <Text style={[styles.title, { color: colors.text }]}>Contract {setup.contract.contractNo}{setup.kind === 'scheduleA' ? ' · Schedule A lots are locked' : setup.proposalList ? ' · Proposal list' : ''}</Text>
    <View testID="auctioneer-create-actions" style={styles.actions}>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Create Lot & Continue"
        accessibilityHint="Submit this report and open a new form for the same contract."
        accessibilityState={{ disabled }} style={[styles.button, styles.continueButton, disabled && styles.disabled]}
        disabled={disabled} onPress={onPress}>
        <Text style={styles.buttonText}>{'Create Lot &\nContinue'}</Text>
      </TouchableOpacity>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel={paused ? 'Resume upload' : 'Create Lot & Close'}
        accessibilityHint="Submit this report and close the form."
        accessibilityState={{ disabled: closeDisabled, busy: submitting }}
        style={[styles.button, styles.closeButton, closeDisabled && styles.disabled]}
        disabled={closeDisabled} onPress={onSubmit}>
        {submitting ? <ActivityIndicator accessibilityRole="progressbar" accessibilityLabel="Submitting report" color="#fff" size="small" /> : null}
        <Text style={styles.buttonText}>{paused ? 'Resume\nupload' : 'Create Lot &\nClose'}</Text>
      </TouchableOpacity>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  container: { padding: 12, gap: 6, borderBottomWidth: 1 },
  title: { fontSize: 14, fontWeight: '600' },
  actions: { flexDirection: 'row', alignItems: 'stretch', gap: 8 },
  button: { flex: 1, minWidth: 0, minHeight: 48, paddingVertical: 10, paddingHorizontal: 6, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  continueButton: { backgroundColor: '#15803D' },
  closeButton: { backgroundColor: '#B91C1C' },
  disabled: { opacity: 0.5 },
  buttonText: { color: '#fff', fontSize: 14, lineHeight: 20, fontWeight: '700', textAlign: 'center' },
});
