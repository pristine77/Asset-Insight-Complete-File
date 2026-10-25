import React from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

type Props = {
  testID: string;
  visible: boolean;
  completedFiles?: number;
  totalFiles?: number;
  onResumeNow: () => void;
  onPause: () => void;
};

/**
 * Shown while an interrupted upload waits to continue by itself
 * (useUploadAutoResume). Android back stops waiting, like Pause upload.
 */
export default function UploadWaitingForSignal({ testID, visible, completedFiles, totalFiles, onResumeNow, onPause }: Props) {
  return (
    <Modal testID={testID} visible={visible} transparent animationType="fade" onRequestClose={onPause}>
      <View style={styles.overlay}>
        <View style={styles.card} accessibilityViewIsModal>
          <ActivityIndicator size="large" color="#2563EB" />
          <Text style={styles.title}>Waiting for signal</Text>
          <Text style={styles.message} accessibilityLiveRegion="polite">
            The upload will continue by itself once the connection is steady. Your draft is saved. Keep this report open.
          </Text>
          {totalFiles ? (
            <Text style={styles.files}>{completedFiles || 0} of {totalFiles} files sent so far</Text>
          ) : null}
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Resume upload now" onPress={onResumeNow} style={styles.primary}>
            <Text style={styles.primaryText}>Resume now</Text>
          </TouchableOpacity>
          <TouchableOpacity accessibilityRole="button" accessibilityLabel="Pause upload" onPress={onPause} style={styles.secondary}>
            <Text style={styles.secondaryText}>Pause upload</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 22,
    padding: 22,
    width: '85%',
    maxWidth: 340,
    alignItems: 'center',
    gap: 10,
  },
  title: { fontSize: 20, fontWeight: 'bold', color: '#1F2937', textAlign: 'center' },
  message: { fontSize: 14, color: '#4B5563', textAlign: 'center' },
  files: { fontSize: 13, color: '#6B7280', textAlign: 'center' },
  primary: {
    minHeight: 44,
    alignSelf: 'stretch',
    borderRadius: 10,
    backgroundColor: '#2563EB',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  secondary: { minHeight: 44, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  secondaryText: { color: '#1D4ED8', fontSize: 15 },
});

