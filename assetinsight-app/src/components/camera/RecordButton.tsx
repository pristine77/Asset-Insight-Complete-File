import React from 'react';
import { Text, TouchableOpacity, StyleSheet, Vibration, View } from 'react-native';
import { Feather } from '@expo/vector-icons';

/*
 * The video controls (owner, 2026-11-19: "can the video pause actually pause
 * the video, the paused video can be unpaused to continue the same video.
 * Stop video is when the video ends and saves").
 *
 * Not recording: one Rec button. Recording: Pause (Resume while paused) and
 * Stop side by side. Pause and Resume keep the same video going; only Stop
 * ends it and saves it to the lot. CameraScreen drives the recorder.
 */
interface RecordButtonProps {
  isRecording: boolean;
  /** The recording is paused; the same video continues at Resume. */
  isPaused?: boolean;
  onStartRecording: () => void;
  onPauseRecording?: () => void;
  onResumeRecording?: () => void;
  /** Ends the video and saves it. */
  onStopRecording: () => void;
  disabled?: boolean;
  isLandscape?: boolean;
  compact?: boolean;
}

export const RecordButton: React.FC<RecordButtonProps> = ({
  isRecording,
  isPaused = false,
  onStartRecording,
  onPauseRecording,
  onResumeRecording,
  onStopRecording,
  disabled = false,
  isLandscape = false,
  compact = false,
}) => {
  const iconSize = compact ? 18 : 20;
  const buttonStyle = [
    styles.recordBtn,
    isLandscape && styles.recordBtnLandscape,
    compact && styles.recordBtnCompact,
    disabled && styles.recordBtnDisabled,
  ];
  const textStyle = [styles.recordBtnText, compact && styles.recordBtnTextCompact];

  if (!isRecording) {
    return (
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Record video, 720p at 30 frames per second"
        accessibilityState={{ disabled }}
        hitSlop={8}
        style={buttonStyle}
        onPress={() => {
          Vibration.vibrate(100);
          onStartRecording();
        }}
        disabled={disabled}>
        <Feather name="video" size={iconSize} color="#fff" />
        <Text style={textStyle}>{compact ? 'Rec' : 'Record 720p'}</Text>
      </TouchableOpacity>
    );
  }

  const canPauseOrResume = isPaused ? Boolean(onResumeRecording) : Boolean(onPauseRecording);
  return (
    <View style={[styles.controlsRow, compact && styles.controlsRowCompact]}>
      {canPauseOrResume && (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={isPaused ? 'Resume video recording' : 'Pause video recording'}
          hitSlop={8}
          style={[...buttonStyle, isPaused ? styles.resumeBtn : styles.pauseBtn]}
          onPress={() => {
            Vibration.vibrate(60);
            if (isPaused) onResumeRecording?.();
            else onPauseRecording?.();
          }}>
          <Feather name={isPaused ? 'play' : 'pause'} size={iconSize} color="#fff" />
          <Text style={textStyle}>{isPaused ? 'Resume' : 'Pause'}</Text>
        </TouchableOpacity>
      )}
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Stop video recording"
        hitSlop={8}
        style={[...buttonStyle, styles.recordBtnActive]}
        onPress={() => {
          Vibration.vibrate(100);
          onStopRecording();
        }}>
        <Feather name="square" size={iconSize} color="#fff" />
        <Text style={textStyle}>Stop</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    gap: 8,
  },
  controlsRowCompact: {
    alignSelf: 'auto',
    gap: 6,
  },
  recordBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(234, 179, 8, 0.9)',
    paddingVertical: 12,
    paddingHorizontal: 24,
    borderRadius: 24,
    alignSelf: 'center',
    gap: 8,
  },
  recordBtnActive: {
    backgroundColor: 'rgba(239, 68, 68, 0.95)',
  },
  pauseBtn: {
    backgroundColor: 'rgba(71, 85, 105, 0.95)',
  },
  resumeBtn: {
    backgroundColor: 'rgba(22, 163, 74, 0.95)',
  },
  recordBtnLandscape: {
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  recordBtnCompact: {
    paddingVertical: 7,
    paddingHorizontal: 10,
    borderRadius: 18,
    alignSelf: 'auto',
    gap: 6,
  },
  recordBtnDisabled: {
    opacity: 0.5,
  },
  recordBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: 'bold',
  },
  recordBtnTextCompact: {
    fontSize: 11,
  },
});

export default RecordButton;
