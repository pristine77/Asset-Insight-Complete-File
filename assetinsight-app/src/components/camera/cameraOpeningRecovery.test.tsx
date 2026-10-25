import React from 'react';
import { Alert, Platform } from 'react-native';
import { act, cleanup, fireEvent, render } from '@testing-library/react-native';
import NativeAuctionCameraScreen from './NativeAuctionCameraScreen';
import { loadNativeAuctionCamera } from './nativeAuctionCameraModule';
import { OfflineCaptureStore } from '../../services/offlineCaptureStore';

jest.mock('expo-crypto', () => {
  let sequence = 0;
  return { randomUUID: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` };
});
jest.mock('./CameraScreen', () => ({ __esModule: true, default: () => null }));
jest.mock('./nativeAuctionCameraModule', () => ({ loadNativeAuctionCamera: jest.fn() }));
jest.mock('../../services/offlineCaptureStore', () => ({ OfflineCaptureStore: {
  getPendingCapture: jest.fn(async () => null), stageCameraActivity: jest.fn(async () => undefined),
} }));

const context = { ownerId: 'owner', draftId: 'inspection', sessionId: 'inspection' };
const lots = Array.from({ length: 30 }, (_, index) => ({ id: `lot-${index}`, files: Array.from({ length: index < 24 ? 11 : 10 }, (_, p) =>
  ({ uri: `file:///isolated/lot-${index}-photo-${p}.jpg`, name: `${index}-${p}.jpg`, type: 'image/jpeg' })), extraFiles: [], coverIndex: 0 }));
const pending = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const input = () => ({ visible: true, captureContext: context, lots, activeLotIdx: 29,
  onClose: jest.fn(), setLots: jest.fn(), setActiveLotIdx: jest.fn(), onAutoSave: jest.fn<Promise<void>, any[]>(async () => undefined) });
const flush = () => act(async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); });
const advance = (ms: number) => act(async () => { jest.advanceTimersByTime(ms); for (let i = 0; i < 12; i++) await Promise.resolve(); });
const originalOS = Platform.OS;
beforeEach(() => {
  jest.clearAllMocks(); jest.useFakeTimers();
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => { await cleanup(); jest.useRealTimers(); jest.restoreAllMocks(); Object.defineProperty(Platform, 'OS', { value: originalOS }); });

it.each(['loader', 'capabilities'])('replaces a never-settling %s with Close and never launches after a late resolution', async stage => {
  const delayed = pending<any>();
  const openAuctionCamera = jest.fn();
  jest.mocked(loadNativeAuctionCamera).mockReturnValue(stage === 'loader' ? delayed.promise : Promise.resolve({ openAuctionCamera, getCameraCapabilities: () => delayed.promise }));
  const props = input();
  const view = await render(<NativeAuctionCameraScreen {...props} />); await flush();
  await advance(10_001);
  expect(view.getByText('Camera preparation paused')).toBeTruthy();
  expect(view.queryByText('Opening camera...')).toBeNull();
  expect(view.queryByRole('button', { name: 'Retry native camera' })).toBeNull();
  await act(async () => { delayed.resolve(stage === 'loader' ? { openAuctionCamera } : { lockedStructure: true }); });
  expect(openAuctionCamera).not.toHaveBeenCalled(); expect(props.setLots).not.toHaveBeenCalled();
  await fireEvent.press(view.getByRole('button', { name: 'Close camera' })); expect(props.onClose).toHaveBeenCalledTimes(1);
});

it.each([true, false])('never abandons or duplicates a long active capture, but permits explicit return (recovery=%s)', async modern => {
  const result = pending<string>(); const openAuctionCamera = jest.fn<Promise<string>, [string?, string?]>(() => result.promise);
  const cancelCameraLaunch = jest.fn<Promise<boolean>, [string]>(async () => true);
  const acknowledgeCapture = jest.fn();
  jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera, acknowledgeCapture, cancelCameraLaunch,
    getCameraCapabilities: async () => ({ lockedStructure: true, launchRecovery: modern }) });
  const props = input(); const view = await render(<NativeAuctionCameraScreen {...props} />); await flush();
  await advance(60 * 60_000);
  expect(openAuctionCamera).toHaveBeenCalledTimes(1); expect(cancelCameraLaunch).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled(); expect(props.onAutoSave).not.toHaveBeenCalled();
  expect(view.getByRole('button', { name: 'Return to inspection' })).toBeTruthy();
  await fireEvent.press(view.getByRole('button', { name: 'Return to inspection' })); await flush();
  expect(cancelCameraLaunch).toHaveBeenCalledTimes(modern ? 1 : 0);
  if (modern) expect(cancelCameraLaunch.mock.calls[0][0]).toEqual(openAuctionCamera.mock.calls[0][1]);
  expect(props.onClose).toHaveBeenCalledTimes(1);
  await act(async () => { result.resolve(JSON.stringify({ ...context, revision: 7, lots })); });
  expect(props.setLots).not.toHaveBeenCalled(); expect(props.onAutoSave).not.toHaveBeenCalled(); expect(acknowledgeCapture).not.toHaveBeenCalled();
});

it('accepts a genuine late result with all 30 lots / 324 photos when the inspection was not closed', async () => {
  const result = pending<string>(); const openAuctionCamera = jest.fn(() => result.promise); const acknowledgeCapture = jest.fn(async () => true);
  jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera, acknowledgeCapture });
  const props = input(); const view = await render(<NativeAuctionCameraScreen {...props} />); await flush(); await advance(25_001);
  expect(view.getByText('Camera opening is taking longer')).toBeTruthy();
  await act(async () => { result.resolve(JSON.stringify({ ...context, revision: 7, lots })); }); await flush();
  expect(props.onClose).toHaveBeenCalledTimes(1); expect(props.setLots.mock.calls[0][0]).toHaveLength(30);
  expect(props.setLots.mock.calls[0][0].reduce((n: number, lot: any) => n + lot.files.length, 0)).toBe(324);
  expect(acknowledgeCapture).toHaveBeenCalledWith('owner', 'inspection', 'inspection', 7);
});

it('allows escape from a stalled return save without acknowledging or dropping its journal', async () => {
  const save = pending<void>(); const acknowledgeCapture = jest.fn();
  jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ acknowledgeCapture,
    openAuctionCamera: async () => JSON.stringify({ ...context, revision: 8, lots }) });
  const props = input(); props.onAutoSave.mockReturnValue(save.promise);
  const view = await render(<NativeAuctionCameraScreen {...props} />); await flush(); await advance(20_001);
  expect(view.getByText('Draft saving is taking longer')).toBeTruthy();
  await fireEvent.press(view.getByRole('button', { name: 'Return to inspection' })); await flush();
  await act(async () => { save.resolve(); });
  expect(acknowledgeCapture).not.toHaveBeenCalled(); expect(props.onClose).toHaveBeenCalledTimes(1);
  expect(OfflineCaptureStore.stageCameraActivity).toHaveBeenCalledTimes(1);
});

it('retries a rejected interrupted launch only after an explicit tap, with a fresh request identity', async () => {
  const openAuctionCamera = jest.fn().mockRejectedValueOnce(Object.assign(new Error('Interrupted'), { code: 'E_CAMERA_INTERRUPTED' }))
    .mockReturnValue(new Promise<string>(() => {}));
  jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera, getCameraCapabilities: async () => ({ lockedStructure: true, launchRecovery: true }) });
  const props = input(); const view = await render(<NativeAuctionCameraScreen {...props} />); await flush();
  expect(openAuctionCamera).toHaveBeenCalledTimes(1); expect(props.setLots).not.toHaveBeenCalled();
  await fireEvent.press(view.getByRole('button', { name: 'Retry native camera' })); await flush();
  expect(openAuctionCamera).toHaveBeenCalledTimes(2);
  expect(openAuctionCamera.mock.calls[0][1]).not.toEqual(openAuctionCamera.mock.calls[1][1]);
});

it('immediately explains an account change even if the native promise never settles, and fences A-to-B-to-A', async () => {
  const result = pending<string>(); const acknowledgeCapture = jest.fn();
  jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ acknowledgeCapture, openAuctionCamera: () => result.promise });
  const props = input(); const view = await render(<NativeAuctionCameraScreen {...props} />); await flush();
  await view.rerender(<NativeAuctionCameraScreen {...props} captureContext={{ ...context, ownerId: 'other' }} />);
  expect(view.getByText('Camera closed')).toBeTruthy();
  expect(view.queryByText('Opening camera...')).toBeNull();
  await view.rerender(<NativeAuctionCameraScreen {...props} />);
  await act(async () => { result.resolve(JSON.stringify({ ...context, revision: 9, lots })); });
  expect(props.setLots).not.toHaveBeenCalled(); expect(props.onAutoSave).not.toHaveBeenCalled();
  expect(acknowledgeCapture).not.toHaveBeenCalled();
});

it('announces pending native shots without importing raw or partial photos into the form', async () => {
  jest.mocked(loadNativeAuctionCamera).mockResolvedValue({ openAuctionCamera: jest.fn(),
    getPendingCapture: async () => JSON.stringify({ ...context, revision: 12, pendingPhotoCount: 3, lots: [] }) });
  const props = input();
  await render(<NativeAuctionCameraScreen {...props} visible={false} />); await flush();
  expect(Alert.alert).toHaveBeenCalledWith('Camera photos waiting to finish', expect.stringContaining('3 captured photos'));
  expect(props.setLots).not.toHaveBeenCalled(); expect(props.onAutoSave).not.toHaveBeenCalled();
});
