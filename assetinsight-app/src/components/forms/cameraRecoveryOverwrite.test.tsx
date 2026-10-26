import React from 'react';
import { Alert, Platform } from 'react-native';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import AssetFormSheet from './AssetFormSheet';
import AutoSaveService from '../../services/autoSaveService';
import { loadNativeAuctionCamera } from '../camera/nativeAuctionCameraModule';

/*
 * Contract 95131, 2026-10-23: "Recover photos" saved 190 lots, then a save the
 * person started while that slow save ran (Open Camera saves the draft first)
 * wrote the form's old 122 lots back over it. 68 lots and 182 photos were lost.
 */

jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID() }));
jest.mock('@react-native-community/netinfo', () => ({ __esModule: true, default: { fetch: jest.fn(async () => ({ isConnected: true, isInternetReachable: true })) } }));
jest.mock('../../services/offlineCaptureStore', () => {
  const store = {
    getOwnerId: () => 'owner', getDraft: jest.fn(), setSubmissionState: jest.fn(async () => undefined), recordDraftOpened: jest.fn(async () => undefined),
    getPendingCapture: jest.fn(async () => null), stageCameraActivity: jest.fn(async () => undefined), acknowledgePendingCapture: jest.fn(async () => true),
  };
  return { __esModule: true, default: store, OfflineCaptureStore: store };
});
jest.mock('../../services/offlineSubmissionService', () => ({ prepareOfflineSubmission: jest.fn(async (draft: unknown) => draft) }));
jest.mock('@expo/vector-icons', () => ({ Feather: () => null }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaView: require('react-native').View }));
jest.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: { username: 'Inspector', companyName: 'QA' } }) }));
jest.mock('../../context/ThemeContext', () => ({ useAppTheme: () => ({ colors: { background: '#101010', surface: '#202020', text: '#ffffff', textSecondary: '#cccccc', borderStrong: '#777777', accent: '#ff3344' } }) }));
jest.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-CA', regionCode: 'CA' }] }));
jest.mock('../camera/CameraScreen', () => ({ __esModule: true, default: () => null }));
jest.mock('../camera/nativeAuctionCameraModule', () => ({ loadNativeAuctionCamera: jest.fn() }));
jest.mock('./LotManager', () => {
  const { Text, TouchableOpacity, View } = require('react-native');
  return { __esModule: true, default: ({ lots, onOpenCamera }: any) => <View>
    <Text testID="form-lot-count">{lots.length}</Text>
    <TouchableOpacity accessibilityRole="button" accessibilityLabel="Open Camera" onPress={() => onOpenCamera(0)}><Text>Open Camera</Text></TouchableOpacity>
  </View> };
});
jest.mock('../../services/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
jest.mock('../../services/assetService', () => ({ __esModule: true, default: { createAssetReport: jest.fn() } }));
jest.mock('../../services/savedInputService', () => ({ __esModule: true, default: { create: jest.fn() } }));
jest.mock('../../services/reportDraftService', () => ({ __esModule: true, default: { upsertFromLocalDraft: jest.fn(), processPreview: jest.fn() }, getDuplicateLotWarning: () => null }));
jest.mock('../../services/offlineQueueService', () => ({ __esModule: true, default: { getConnectivityStatus: jest.fn(async () => ({ status: 'online' })), getSubmissionError: jest.fn() } }));
jest.mock('../../services/autoSaveService', () => ({ __esModule: true, default: {
  getDraft: jest.fn(), saveDraft: jest.fn(), migrateLegacyAutoSaveIfNeeded: jest.fn(), getAutoSaveSummary: jest.fn(async () => null),
} }));
jest.mock('../../utils/mobileLocation', () => ({
  normalizeHiddenLocation: (location?: string) => ({ location: location || 'Not provided' }),
  getHiddenCurrentLocation: jest.fn(async () => ({ location: 'Not provided' })),
}));

const photo = (name: string) => ({ uri: `file:///camera/${name}.jpg`, originalUri: `file:///camera/${name}.jpg`, name: `${name}.jpg`, type: 'image/jpeg', mediaId: name });
const savedLot = (id: string, names: string[]) => ({ id, mode: 'single_lot' as const, mainImages: names.map(photo), extraImages: [], videoFiles: [], coverIndex: 0 });
const draft = {
  id: 'local-95131', ownerId: 'owner', type: 'asset', title: '95131', contractNo: '95131', captureMode: 'offline', manualSubmissionRequired: true,
  submissionState: 'local', createdAt: '2026-10-23', updatedAt: '2026-10-23', activeLotIdx: 0,
  formData: { captureMode: 'offline', contractNo: '95131', clientSubmissionId: 'cv-mobile-95131', clientName: 'Customer', appraisalPurpose: 'Auction', appraiser: 'Inspector', currency: 'CAD', language: 'en' as const },
  lots: [savedLot('lot-1', ['a', 'b'])],
};
// What the interrupted camera session holds: the saved lot plus a new one.
const journal = { ownerId: 'owner', draftId: draft.id, sessionId: draft.id, revision: 1039,
  lots: [{ id: 'lot-1', mode: 'single_lot', files: [photo('a'), photo('b')], extraFiles: [], coverIndex: 0 },
    { id: 'lot-2', mode: 'single_lot', files: [photo('c'), photo('d'), photo('e')], extraFiles: [], coverIndex: 0 }] };
const originalPlatform = Platform.OS;

beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  jest.mocked(AutoSaveService.getDraft).mockResolvedValue(draft as any);
});

afterEach(async () => {
  await cleanup();
  jest.restoreAllMocks();
  Object.defineProperty(Platform, 'OS', { value: originalPlatform, configurable: true });
});

it('keeps recovered camera lots when Open Camera is tapped while the recovery is still saving', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const acknowledgeCapture = jest.fn(async () => true);
  jest.mocked(loadNativeAuctionCamera).mockResolvedValue({
    openAuctionCamera: jest.fn(() => new Promise<string>(() => {})),
    getCameraCapabilities: jest.fn(async () => ({ lockedStructure: true, launchRecovery: true })),
    getPendingCapture: jest.fn(async () => JSON.stringify(journal)), acknowledgeCapture,
  });
  const saves: { lots: unknown[]; finish: () => void }[] = [];
  jest.mocked(AutoSaveService.saveDraft).mockImplementation((input: any) => new Promise((resolve) => {
    saves.push({ lots: input.lots, finish: () => resolve({ ...draft, ...input, updatedAt: new Date().toISOString() }) });
  }));

  await render(<AssetFormSheet visible draftIdToLoad={draft.id} onClose={jest.fn()} />);
  await waitFor(() => expect(alert).toHaveBeenCalledWith('Recover camera photos?', expect.any(String), expect.any(Array)));
  await act(async () => { alert.mock.calls.find(([title]) => title === 'Recover camera photos?')?.[2]?.find(button => button.text === 'Recover photos')?.onPress?.(); });
  await waitFor(() => expect(saves).toHaveLength(1));
  expect(saves[0].lots).toHaveLength(2);

  // The recovery save is still running when the person taps Open Camera.
  await fireEvent.press(screen.getByRole('button', { name: 'Open Camera' }));
  await waitFor(() => expect(saves.length).toBeGreaterThanOrEqual(2));
  expect(saves.slice(1).map(save => save.lots.length)).toEqual(saves.slice(1).map(() => 2));

  await act(async () => { saves.forEach(save => save.finish()); });
  await waitFor(() => expect(acknowledgeCapture).toHaveBeenCalledWith('owner', draft.id, draft.id, 1039));
  expect(saves.every(save => save.lots.length === 2)).toBe(true);
  expect(screen.getByTestId('form-lot-count').props.children).toBe(2);
}, 30_000);
