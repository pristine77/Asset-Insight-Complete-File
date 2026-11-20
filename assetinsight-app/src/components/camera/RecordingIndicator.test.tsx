/*
 * The recording timer shows a paused video as PAUSED with its time held
 * (owner, 2026-11-19: video Pause / Resume / Stop).
 */
import React from 'react';
import { render, screen } from '@testing-library/react-native';
import RecordingIndicator from './RecordingIndicator';
import RecordButton from './RecordButton';

jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));

describe('the recording timer', () => {
  it('reads REC while recording', async () => {
    await render(<RecordingIndicator isRecording recordingTime={65} />);
    expect(screen.getByText('REC 01:05')).toBeTruthy();
  });

  it('reads PAUSED, with the time held, while paused', async () => {
    await render(<RecordingIndicator isRecording isPaused recordingTime={65} />);
    expect(screen.getByText('PAUSED 01:05')).toBeTruthy();
  });

  it('is gone when not recording', async () => {
    await render(<RecordingIndicator isRecording={false} recordingTime={0} />);
    expect(screen.queryByText(/REC|PAUSED/)).toBeNull();
  });
});

describe('the record controls', () => {
  const handlers = () => ({
    onStartRecording: jest.fn(),
    onPauseRecording: jest.fn(),
    onResumeRecording: jest.fn(),
    onStopRecording: jest.fn(),
  });

  it('offer only Rec before recording', async () => {
    await render(<RecordButton isRecording={false} {...handlers()} compact />);
    expect(screen.getByText('Rec')).toBeTruthy();
    expect(screen.queryByText('Pause')).toBeNull();
    expect(screen.queryByText('Stop')).toBeNull();
  });

  it('offer Pause and Stop while recording, Resume and Stop while paused', async () => {
    const recording = await render(<RecordButton isRecording {...handlers()} compact />);
    expect(screen.getByText('Pause')).toBeTruthy();
    expect(screen.getByText('Stop')).toBeTruthy();
    recording.unmount();
    await render(<RecordButton isRecording isPaused {...handlers()} compact />);
    expect(screen.getByText('Resume')).toBeTruthy();
    expect(screen.getByText('Stop')).toBeTruthy();
    expect(screen.queryByText('Pause')).toBeNull();
  });
});
