import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import api from './api';
import store from './offlineCaptureStore';
import sync, { captureInventorySnapshot } from './offlineCaptureSync';
import type { OfflineReportDraft } from './autoSaveService';

let changeAppState: (state: string) => void;

jest.mock('@react-native-async-storage/async-storage', () => ({ __esModule: true, default: { getItem: jest.fn(async () => 'installation-1'), setItem: jest.fn() } }));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { version: '1.0' } } }));
jest.mock('@react-native-community/netinfo', () => ({ __esModule: true, default: { fetch: jest.fn(async () => ({ isConnected: true })), addEventListener: jest.fn(() => jest.fn()) } }));
jest.mock('./api', () => ({ __esModule: true, default: { put: jest.fn(), post: jest.fn() } }));
jest.mock('./offlineCaptureStore', () => ({ __esModule: true, default: { getOwnerId: jest.fn(() => 'owner'), pendingActivity: jest.fn(async () => []), acknowledgeActivity: jest.fn(), inventoryCandidates: jest.fn(), acknowledgeInventory: jest.fn(), recordInventoryError: jest.fn() } }));

const draft = (count = 2): OfflineReportDraft => ({ id: 'draft-1', captureId: 'capture-1', ownerId: 'owner', localRevision: 3,
  type: 'asset', captureMode: 'offline', inventoryAppVersion: 'saved-version', inventoryPlatform: 'ios', title: 'Local report', contractNo: 'same-contract', formData: { clientSubmissionId: 'stable-id', factorsAnalysis: 'PRIVATE NOTES' },
  lots: Array.from({ length: Math.ceil(count / 100) }, (_, index) => ({ id: `lot-${index}`, lotNumber: String(100 + index), title: 'Equipment',
    mainImages: Array.from({ length: Math.min(100, count - index * 100) }, (_, photo) => ({ uri: `content://media/private/${index}-${photo}`, name: 'private.jpg', type: 'image/jpeg', captureTimestamp: 1700000000000, availability: photo === 0 ? 'missing' as const : 'available' as const })),
    extraImages: [], videoFiles: [], coverIndex: 0 })), activeLotIdx: 0, createdAt: '2026-09-17T10:00:00.000Z', updatedAt: '2026-09-17T10:01:00.000Z' });

beforeEach(() => {
  jest.clearAllMocks(); Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_, listener) => {
    changeAppState = (state) => {
      Object.defineProperty(AppState, 'currentState', { configurable: true, value: state });
      listener(state as any);
    };
    return { remove: jest.fn() };
  });
  jest.mocked(store.getOwnerId).mockReturnValue('owner');
  jest.mocked(store.pendingActivity).mockResolvedValue([]);
  jest.mocked(store.inventoryCandidates).mockResolvedValue([{ draftId: 'draft-1', revision: 3, draft: draft() }]);
  jest.mocked(api.put).mockResolvedValue({ data: { data: { acknowledgedRevision: 3 } } });
});
afterEach(() => sync.cleanup());

test.each([0, 1, 2, 200, 5000])('metadata counts %i photos without copying photo bytes or private fields', (count) => {
  const payload = captureInventorySnapshot(draft(count), 'installation-1');
  expect(payload.lots.reduce((sum, lot) => sum + lot.mainPhotoCount + lot.extraPhotoCount, 0)).toBe(count);
  expect(payload.lots.every((lot) => lot.availablePhotoCount + lot.missingPhotoCount === lot.mainPhotoCount + lot.extraPhotoCount)).toBe(true);
  expect(JSON.stringify(payload)).not.toMatch(/content:\/\/|PRIVATE NOTES|private\.jpg/);
  expect(payload.clientSubmissionId).toBe('stable-id');
});
test('foreground sync sends only inventory and acknowledges the exact revision', async () => {
  sync.init(); await sync.syncOnce();
  expect(api.put).toHaveBeenCalledWith('/capture-inventory/capture-1', expect.objectContaining({ revision: 3, localStatus: 'saved' }), expect.any(Object));
  expect(store.acknowledgeInventory).toHaveBeenCalledWith('draft-1', 3);
});
test('activity replay retains IDs after lost responses and acknowledges only sent events', async () => {
  const events = [{ eventId: 'event-one', activityId: 'capture-one' }] as any;
  jest.mocked(store.pendingActivity).mockResolvedValue(events);
  jest.mocked(api.post).mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce({ data: { data: { acknowledgements: [{ eventId: 'event-one' }, { eventId: 'foreign-event' }] } } });
  sync.init(); await sync.syncOnce();
  expect(store.acknowledgeActivity).not.toHaveBeenCalled();
  jest.mocked(store.pendingActivity).mockResolvedValueOnce(events).mockResolvedValue([]);
  await sync.syncOnce();
  expect(api.post).toHaveBeenLastCalledWith('/report-activity/events', { ownerId: 'owner', events }, expect.any(Object));
  expect(store.acknowledgeActivity).toHaveBeenCalledWith(['event-one'], 'owner');
});
test('activity acknowledgements cannot cross an account switch', async () => {
  jest.mocked(store.pendingActivity).mockResolvedValue([{ eventId: 'event-one' }] as any);
  jest.mocked(api.post).mockImplementation(async () => {
    jest.mocked(store.getOwnerId).mockReturnValue('other');
    return { data: { data: { acknowledgements: [{ eventId: 'event-one' }] } } };
  });
  sync.init(); await sync.syncOnce();
  expect(store.acknowledgeActivity).not.toHaveBeenCalled();
  expect(api.put).not.toHaveBeenCalled();
});
test('no network request offline or when app is in background', async () => {
  jest.mocked(NetInfo.fetch).mockResolvedValueOnce({ isConnected: false } as any);
  sync.init(); await sync.syncOnce(); expect(api.put).not.toHaveBeenCalled();
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'background' });
  await sync.syncOnce(); expect(api.put).not.toHaveBeenCalled();
});
test('account switch fences a late acknowledgement', async () => {
  jest.mocked(api.put).mockImplementation(async () => { jest.mocked(store.getOwnerId).mockReturnValue('other'); return { data: { data: { acknowledgedRevision: 3 } } }; });
  sync.init(); await sync.syncOnce(); expect(store.acknowledgeInventory).not.toHaveBeenCalled();
});
test('backgrounding while connectivity is resolving cannot start a metadata request', async () => {
  let finish!: (value: any) => void;
  jest.mocked(NetInfo.fetch).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  sync.init(); const pending = sync.syncOnce();
  changeAppState('background'); finish({ isConnected: true });
  await pending;
  expect(api.put).not.toHaveBeenCalled();
  expect(store.inventoryCandidates).not.toHaveBeenCalled();
});
test('backgrounding aborts an active request and ignores its late acknowledgement', async () => {
  let capturedSignal!: AbortSignal;
  jest.mocked(api.put).mockImplementation(async (_url, _body, options) => {
    capturedSignal = options!.signal as AbortSignal;
    changeAppState('background');
    return { data: { data: { acknowledgedRevision: 3 } } };
  });
  sync.init(); await sync.syncOnce();
  expect(capturedSignal.aborted).toBe(true);
  expect(store.acknowledgeInventory).not.toHaveBeenCalled();
});
test('failed metadata sync does not mark the snapshot delivered', async () => {
  jest.mocked(api.put).mockRejectedValue(new Error('offline'));
  sync.init(); await sync.syncOnce(); expect(store.acknowledgeInventory).not.toHaveBeenCalled();
});
test('app upgrades do not change a saved revision or its exact-retry body', () => {
  expect(captureInventorySnapshot(draft(), 'installation-1').device).toEqual({ installationId: 'installation-1', appVersion: 'saved-version', platform: 'ios' });
});
test('a terminal metadata conflict cannot starve another capture', async () => {
  jest.mocked(store.inventoryCandidates).mockResolvedValueOnce([{ draftId: 'draft-1', revision: 3, draft: draft() }])
    .mockResolvedValueOnce([{ draftId: 'draft-2', revision: 3, draft: { ...draft(), id: 'draft-2', captureId: 'capture-2' } }]).mockResolvedValue([]);
  jest.mocked(api.put).mockRejectedValueOnce({ response: { status: 409 } }).mockResolvedValueOnce({ data: { data: { acknowledgedRevision: 3 } } });
  sync.init(); await sync.syncOnce();
  expect(store.recordInventoryError).toHaveBeenCalledWith('draft-1', 3, expect.any(String));
  expect(store.acknowledgeInventory).toHaveBeenCalledWith('draft-2', 3);
});
