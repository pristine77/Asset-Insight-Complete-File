import React from 'react';
import { ActivityIndicator, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppTheme } from '../../context/ThemeContext';

export default function DraftStorageStatus({ saving, error, onRetry, onClose }: {
  saving?: boolean; error?: string; onRetry: () => void; onClose: () => void;
}) {
  const { colors } = useAppTheme();
  return <Modal visible onRequestClose={saving ? undefined : onClose}>
    <SafeAreaView style={[styles.page, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
      <View style={styles.content}>
        {!error && <ActivityIndicator size="large" color={colors.accent} />}
        <Text accessibilityRole={error ? 'alert' : undefined} accessibilityLiveRegion="polite" style={[styles.title, { color: colors.text }]}>
          {error || (saving ? 'Saving on this device…' : 'Opening saved draft…')}
        </Text>
        <Text style={{ color: colors.textSecondary }}>{saving ? 'Please wait until the local save finishes. Cloud backup is separate; this does not submit the report.' : 'Your saved details, lots and photo order will be restored for review. Cloud backup does not submit the report.'}</Text>
        {error && <TouchableOpacity accessibilityRole="button" onPress={onRetry} style={styles.button}><Text style={{ color: colors.accent }}>Retry opening draft</Text></TouchableOpacity>}
        {!saving && <TouchableOpacity accessibilityRole="button" onPress={onClose} style={styles.button}><Text style={{ color: colors.accent }}>Close</Text></TouchableOpacity>}
      </View>
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}
const styles = StyleSheet.create({ page: { flex: 1 }, scroll: { flexGrow: 1, justifyContent: 'center', padding: 24 }, content: { gap: 16, width: '100%', maxWidth: 520, alignSelf: 'center' }, title: { fontSize: 18, fontWeight: '600' }, button: { minHeight: 48, justifyContent: 'center', paddingVertical: 12 } });
