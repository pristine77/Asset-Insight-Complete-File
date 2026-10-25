import React from 'react';
import { Alert, Keyboard, Platform, StyleSheet, type KeyboardEvent } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import AssignedApprovalsScreen from './AssignedApprovalsScreen';
import assignedApprovalService from '../services/assignedApprovalService';

jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('../context/ThemeContext', () => {
  const theme = { colors: { background: '#fff', surface: '#fff', text: '#111', accent: '#f00' } };
  return { useAppTheme: () => theme };
});
jest.mock('../services/assignedApprovalService', () => ({
  __esModule: true,
  default: { getAssignedApprovals: jest.fn(), reject: jest.fn(), approve: jest.fn() },
}));

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  jest.mocked(assignedApprovalService.getAssignedApprovals).mockResolvedValue({
    items: [{ _id: 'report-1', reportType: 'Asset', filename: 'Assigned asset', isAssetReport: true }],
    total: 1,
  });
});

async function openRejection() {
  const view = await render(<AssignedApprovalsScreen onOpenDrawer={jest.fn()} onOpenPreview={jest.fn()} />);
  await waitFor(() => expect(screen.getByText('Assigned asset')).toBeTruthy());
  await fireEvent.press(screen.getByText('Reject'));
  return view;
}

it('keeps the note and actions in a flexible keyboard-aware scroll container', async () => {
  await openRejection();
  const avoiding = screen.getByTestId('rejection-keyboard-container');
  expect(StyleSheet.flatten(avoiding.props.style)).toMatchObject({ flex: 1 });
  const scrolling = screen.getByTestId('rejection-scroll-container');
  expect(scrolling.props.keyboardShouldPersistTaps).toBe('handled');
  expect(StyleSheet.flatten(scrolling.props.contentContainerStyle)).toMatchObject({ flexGrow: 1 });
  expect(scrolling.props.keyboardDismissMode).toBe(Platform.OS === 'ios' ? 'interactive' : 'on-drag');
  expect(screen.getByLabelText('Rejection note').props.multiline).toBe(true);
  expect(screen.getByRole('button', { name: 'Cancel rejection' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Confirm report rejection' })).toBeTruthy();
});

it('preserves multiline edits and submits the existing trimmed rejection payload', async () => {
  await openRejection();
  jest.mocked(assignedApprovalService.reject).mockResolvedValue({ message: 'Rejected' });
  await fireEvent.changeText(screen.getByLabelText('Rejection note'), '  First finding\nSecond finding  ');
  expect(screen.getByLabelText('Rejection note').props.value).toBe('  First finding\nSecond finding  ');
  await fireEvent.press(screen.getByRole('button', { name: 'Confirm report rejection' }));
  expect(assignedApprovalService.reject).toHaveBeenCalledTimes(1);
  expect(assignedApprovalService.reject).toHaveBeenCalledWith('report-1', 'First finding\nSecond finding');
  await waitFor(() => expect(screen.queryByLabelText('Rejection note')).toBeNull());
});

it('bounds the Android dialog above the keyboard and restores it without dropping notes', async () => {
  const originalPlatform = Platform.OS;
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'android' });
  const keyboardEvents = new Map<string, (event: KeyboardEvent) => void>();
  const metrics = jest.spyOn(Keyboard, 'metrics').mockReturnValue({ screenX: 0, screenY: 350, width: 400, height: 450 });
  const addKeyboardListener = Keyboard.addListener.bind(Keyboard);
  const listeners = jest.spyOn(Keyboard, 'addListener').mockImplementation((name, callback) => {
    keyboardEvents.set(name, callback);
    return addKeyboardListener(name, callback);
  });
  try {
    await openRejection();
    await fireEvent(screen.getByTestId('rejection-keyboard-container'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 800 } },
    });
    expect(StyleSheet.flatten(screen.getByTestId('rejection-keyboard-container-content').props.style)).toMatchObject({ height: 350, flex: 0 });
    await fireEvent.changeText(screen.getByLabelText('Rejection note'), 'Line one\nLine two');
    await act(() => keyboardEvents.get('keyboardDidHide')?.({
      duration: 0, easing: 'keyboard', endCoordinates: { screenX: 0, screenY: 800, width: 400, height: 0 },
    }));
    expect(StyleSheet.flatten(screen.getByTestId('rejection-keyboard-container-content').props.style)).toMatchObject({ flex: 1 });
    expect(screen.getByLabelText('Rejection note').props.value).toBe('Line one\nLine two');
    expect(screen.getByRole('button', { name: 'Confirm report rejection' })).toBeTruthy();
  } finally {
    metrics.mockRestore();
    listeners.mockRestore();
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalPlatform });
  }
});

it('keeps the note visible after failure and never approves instead', async () => {
  await openRejection();
  jest.mocked(assignedApprovalService.reject).mockRejectedValue(new Error('Offline'));
  await fireEvent.changeText(screen.getByLabelText('Rejection note'), 'Keep these review notes');
  await fireEvent.press(screen.getByRole('button', { name: 'Confirm report rejection' }));
  await waitFor(() => expect(Alert.alert).toHaveBeenCalledWith('Reject failed', 'Failed to reject report.'));
  expect(screen.getByLabelText('Rejection note').props.value).toBe('Keep these review notes');
  expect(assignedApprovalService.approve).not.toHaveBeenCalled();
});

it('validates blank notes and allows cancellation without a report mutation', async () => {
  await openRejection();
  await fireEvent.changeText(screen.getByLabelText('Rejection note'), '   ');
  await fireEvent.press(screen.getByRole('button', { name: 'Confirm report rejection' }));
  expect(Alert.alert).toHaveBeenCalledWith('Rejection note', 'Please enter a note.');
  await fireEvent.press(screen.getByRole('button', { name: 'Cancel rejection' }));
  expect(screen.queryByLabelText('Rejection note')).toBeNull();
  expect(assignedApprovalService.reject).not.toHaveBeenCalled();
  expect(assignedApprovalService.approve).not.toHaveBeenCalled();
});
