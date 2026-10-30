import React, { useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { REPORT_CURRENCIES } from '../../utils/reportCurrency';

export default function CurrencySelect({ value, onChange, disabled = false, label = 'Currency code, required' }: {
  value: string; onChange: (value: string) => void; disabled?: boolean; label?: string;
}) {
  const [open, setOpen] = useState(false);
  const options = Array.from(new Set([value, ...REPORT_CURRENCIES].filter(Boolean)));
  return <>
    <TouchableOpacity accessibilityRole="button" accessibilityLabel={label} accessibilityValue={{ text: value }} disabled={disabled} onPress={() => setOpen(true)} style={[styles.control, disabled && styles.disabled]}>
      <Text style={styles.value}>{value || 'Select currency'}</Text><Text style={styles.value}>⌄</Text>
    </TouchableOpacity>
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
      <View style={styles.backdrop}><View style={styles.dialog} accessibilityViewIsModal>
        <Text style={styles.title}>Report currency</Text>
        <ScrollView style={styles.options}>{options.map(code => <TouchableOpacity key={code} accessibilityRole="radio" accessibilityState={{ selected: code === value }} accessibilityLabel={code} onPress={() => { onChange(code); setOpen(false); }} style={styles.option}><Text style={styles.value}>{code}{code === value ? ' ✓' : ''}</Text></TouchableOpacity>)}</ScrollView>
        <TouchableOpacity accessibilityRole="button" onPress={() => setOpen(false)} style={styles.option}><Text style={styles.cancel}>Cancel</Text></TouchableOpacity>
      </View></View>
    </Modal>
  </>;
}
const styles = StyleSheet.create({ control: { minHeight: 46, borderWidth: 1, borderColor: '#D1D5DB', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 12, flexDirection: 'row', justifyContent: 'space-between', backgroundColor: '#FFF' }, disabled: { opacity: .5 }, value: { color: '#111827', fontSize: 15 }, backdrop: { flex: 1, backgroundColor: '#0008', justifyContent: 'center', padding: 24 }, dialog: { backgroundColor: '#FFF', borderRadius: 12, maxHeight: '80%', padding: 12 }, title: { fontSize: 18, fontWeight: '700', color: '#111827', padding: 12 }, options: { maxHeight: 360 }, option: { minHeight: 44, justifyContent: 'center', padding: 12 }, cancel: { color: '#2563EB', fontSize: 15 } });
