import NetInfo from '@react-native-community/netinfo';
import service, { DISCONNECT_PAUSE_DELAY_MS } from './offlineQueueService';
import asset from './assetService';
import listing from './lotListingService';
import { isUploadFinalizing, pauseActiveUploads } from './uploadCancellation';

jest.mock('@react-native-async-storage/async-storage', () => ({ __esModule: true, default: { getItem: jest.fn(), setItem: jest.fn() } }));
jest.mock('@react-native-community/netinfo', () => ({ __esModule: true, default: { addEventListener: jest.fn(() => jest.fn()) } }));
jest.mock('./assetService', () => ({ __esModule: true, default: { createAssetReport: jest.fn() } }));
jest.mock('./lotListingService', () => ({ __esModule: true, default: { createLotListing: jest.fn() } }));
jest.mock('./autoSaveService', () => ({ __esModule: true, default: {} }));
jest.mock('./offlineCaptureStore', () => ({ __esModule: true, default: { getOwnerId: () => 'owner' } }));
jest.mock('./localMediaStore', () => ({ LocalMediaStore: {} }));
jest.mock('./connectivityService', () => ({}));
jest.mock('./uploadCancellation', () => ({ pauseActiveUploads: jest.fn(), isUploadFinalizing: jest.fn(() => false) }));
jest.mock('expo-file-system/legacy', () => ({ documentDirectory: 'file:///isolated/' }));

/** The listener registered by the latest init(). */
const networkChanged = () => jest.mocked(NetInfo.addEventListener).mock.calls.at(-1)![0];

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(isUploadFinalizing).mockReturnValue(false);
});
afterEach(() => {
  service.cleanup();
  jest.useRealTimers();
});

test('startup, reconnect and refresh never submit queued photos; a lasting disconnect cancels active work', async () => {
  service.init();
  networkChanged()({ isConnected: true, isInternetReachable: true } as any);
  await service.forceSyncOnce();
  expect(asset.createAssetReport).not.toHaveBeenCalled();
  expect(listing.createLotListing).not.toHaveBeenCalled();
  jest.useFakeTimers();
  networkChanged()({ isConnected: false } as any);
  // A handover recovers well inside the delay, so nothing is paused at once.
  expect(pauseActiveUploads).not.toHaveBeenCalled();
  jest.advanceTimersByTime(DISCONNECT_PAUSE_DELAY_MS);
  expect(pauseActiveUploads).toHaveBeenCalledTimes(1);
  // Marked for feedback only; resume still requires explicit user action.
  expect(pauseActiveUploads).toHaveBeenCalledWith('connection');
});

/*
 * Revised 2026-10-01. NetInfo's isInternetReachable is its own probe of a public
 * URL and reads false on weak site signal or a network that blocks that URL;
 * it used to pause every upload in the field.
 */
test('an internet-reachability flicker never pauses uploads', () => {
  jest.useFakeTimers();
  service.init();
  networkChanged()({ isConnected: true, isInternetReachable: false } as any);
  jest.advanceTimersByTime(DISCONNECT_PAUSE_DELAY_MS * 3);
  expect(pauseActiveUploads).not.toHaveBeenCalled();
});

test('a disconnect that recovers within the delay pauses nothing', () => {
  jest.useFakeTimers();
  service.init();
  networkChanged()({ isConnected: false } as any);
  jest.advanceTimersByTime(DISCONNECT_PAUSE_DELAY_MS / 2);
  networkChanged()({ isConnected: true, isInternetReachable: true } as any);
  jest.advanceTimersByTime(DISCONNECT_PAUSE_DELAY_MS * 2);
  expect(pauseActiveUploads).not.toHaveBeenCalled();
});

test('a lasting disconnect leaves a submission that is being finalized to settle', () => {
  jest.useFakeTimers();
  jest.mocked(isUploadFinalizing).mockReturnValue(true);
  service.init();
  networkChanged()({ isConnected: false } as any);
  jest.advanceTimersByTime(DISCONNECT_PAUSE_DELAY_MS);
  expect(pauseActiveUploads).not.toHaveBeenCalled();
});

test('sign-out cancels a pending automatic pause along with the uploads themselves', () => {
  jest.useFakeTimers();
  service.init();
  networkChanged()({ isConnected: false } as any);
  service.cleanup();
  expect(pauseActiveUploads).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(DISCONNECT_PAUSE_DELAY_MS);
  expect(pauseActiveUploads).toHaveBeenCalledTimes(1);
});
