import React, { useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Vibration } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { CaptureMode, MODE_CONFIG } from './types';

interface CaptureButtonsProps {
  onCapture: (mode: CaptureMode, isExtra: boolean) => void;
  disabled?: boolean;
  isLandscape?: boolean;
  lockedStructure?: boolean;
  currentMode?: CaptureMode;
}

export const CaptureButtons: React.FC<CaptureButtonsProps> = ({
  onCapture,
  disabled = false,
  isLandscape = false,
  lockedStructure = false,
  currentMode,
}) => {
  const policyRef = useRef({ disabled, lockedStructure, currentMode });
  useEffect(() => {
    policyRef.current = { disabled, lockedStructure, currentMode };
  }, [disabled, lockedStructure, currentMode]);

  const handleCapture = (mode: CaptureMode, isExtra: boolean) => {
    const policy = policyRef.current;
    if (policy.disabled || (policy.lockedStructure && mode !== policy.currentMode)) return;
    Vibration.vibrate(50);
    onCapture(mode, isExtra);
  };

  const modes: CaptureMode[] = lockedStructure
    ? currentMode ? [currentMode] : []
    : ['single_lot', 'per_item', 'per_photo'];

  if (isLandscape) {
    return (
      <View style={styles.landscapeContainer}>
        {modes.map((mode) => (
          <View key={mode} style={styles.landscapeRow}>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={`Capture ${MODE_CONFIG[mode].label} photo`}
              style={[styles.captureBtn, styles.captureBtnMain, styles.captureBtnLandscape, lockedStructure && styles.lockedCaptureBtn]}
              onPress={() => handleCapture(mode, false)}
              disabled={disabled}>
              <Feather name="camera" size={14} color="#fff" />
              <Text style={styles.captureBtnText}>{MODE_CONFIG[mode].shortLabel}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={`Capture extra ${MODE_CONFIG[mode].label} photo`}
              style={[styles.captureBtn, styles.captureBtnExtra, styles.captureBtnLandscape, lockedStructure && styles.lockedCaptureBtn]}
              onPress={() => handleCapture(mode, true)}
              disabled={disabled}>
              <Text style={styles.captureBtnTextSmall}>Extra</Text>
            </TouchableOpacity>
          </View>
        ))}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Main capture buttons in single row */}
      <View style={styles.row}>
        {modes.map((mode) => (
          <TouchableOpacity
            key={mode}
            accessibilityRole="button"
            accessibilityLabel={`Capture ${MODE_CONFIG[mode].label} photo`}
            style={[styles.captureBtn, styles.captureBtnMain, styles.captureBtnPortrait, lockedStructure && styles.lockedCaptureBtn]}
            onPress={() => handleCapture(mode, false)}
            disabled={disabled}>
            <Feather name="camera" size={12} color="#fff" />
            <Text style={styles.captureBtnText}>{MODE_CONFIG[mode].shortLabel}</Text>
          </TouchableOpacity>
        ))}
      </View>
      {/* Extra buttons in single row */}
      <View style={styles.row}>
        {modes.map((mode) => (
          <TouchableOpacity
            key={`${mode}-extra`}
            accessibilityRole="button"
            accessibilityLabel={`Capture extra ${MODE_CONFIG[mode].label} photo`}
            style={[styles.captureBtn, styles.captureBtnExtra, styles.captureBtnPortrait, lockedStructure && styles.lockedCaptureBtn]}
            onPress={() => handleCapture(mode, true)}
            disabled={disabled}>
            <Text style={styles.captureBtnTextSmall}>+{MODE_CONFIG[mode].shortLabel}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: '100%',
    alignSelf: 'stretch',
    gap: 6,
  },
  row: {
    flexDirection: 'row',
    width: '100%',
    justifyContent: 'space-between',
    gap: 6,
  },
  landscapeContainer: {
    flexDirection: 'column',
    width: '100%',
    gap: 6,
  },
  landscapeRow: {
    flexDirection: 'row',
    width: '100%',
    gap: 6,
  },
  captureBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 8,
    gap: 3,
    minWidth: 0,
  },
  captureBtnPortrait: {
    flex: 1,
  },
  captureBtnLandscape: {
    flex: 1,
    paddingVertical: 7,
    paddingHorizontal: 4,
  },
  lockedCaptureBtn: {
    minHeight: 44,
  },
  captureBtnMain: {
    backgroundColor: 'rgba(244, 63, 94, 0.9)',
  },
  captureBtnExtra: {
    backgroundColor: 'rgba(59, 130, 246, 0.85)',
  },
  captureBtnText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: 'bold',
  },
  captureBtnTextSmall: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '600',
  },
});

export default CaptureButtons;
