import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { requireOptionalNativeModule } from 'expo-modules-core';
import api from './api';
import offlineStore from './offlineCaptureStore';
import type { OfflineReportDraft } from './autoSaveService';
import { flushBackupHandoff } from './captureBackupHandoff';
import CaptureBackupService, {
  createCaptureBackupService, startCaptureBackups, stopCaptureBackupObservers, type BackupConsent,
} from './captureBackupService';

jest.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
  Dimensions: { get: jest.fn(() => ({ width: 390, height: 844 })) }, Platform: { OS: 'android' },
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null), setItem: jest.fn(async () => undefined),
}));
jest.mock('@react-native-community/netinfo', () => ({
  fetch: jest.fn(async () => ({ isConnected: false, isInternetReachable: false })),
  addEventListener: jest.fn(() => jest.fn()),
}));
jest.mock('expo-modules-core', () => ({ requireOptionalNativeModule: jest.fn(() => ({
  configure: jest.fn(async () => undefined), enqueue: jest.fn(async () => undefined),
  pause: jest.fn(async () => undefined), resume: jest.fn(async () => undefined),
  list: jest.fn(async () => []), deactivate: jest.fn(async () => undefined),
})) }));
jest.mock('./api', () => ({ __esModule: true, default: {
  post: jest.fn(), get: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn(),
} }));
jest.mock('../config/api', () => ({ API_BASE_URL: 'https://fixture.invalid/api' }));
jest.mock('./offlineCaptureStore', () => ({ __esModule: true, default: {
  getOwnerId: jest.fn(() => 'owner-a'), pendingBackups: jest.fn(async () => []),
  acknowledgeBackupQueue: jest.fn(async () => undefined), subscribeSaved: jest.fn(() => jest.fn()),
  getDraft: jest.fn(async () => null), seedBackups: jest.fn(async () => undefined),
} }));
jest.mock('./deviceAccessStorage', () => ({ getOrCreateDeviceKey: jest.fn(async () => 'fixture-device') }));
jest.mock('./deviceReinstallIdentity', () => ({ getAndroidReinstallId: jest.fn(async () => 'fixture-reinstall') }));
jest.mock('./appVersion', () => ({ getAppVersionLabel: jest.fn(() => '1.0.2 (24)') }));

type Dependencies = Parameters<typeof createCaptureBackupService>[0];
type Native = NonNullable<Dependencies['native']>;
type Service = ReturnType<typeof createCaptureBackupService>;
const singletonNative = jest.mocked(requireOptionalNativeModule).mock.results[0].value as jest.Mocked<Native>;
const services: Service[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function until(predicate: () => boolean) {
  for (let pass = 0; pass < 100; pass++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  expect(predicate()).toBe(true);
}
const grant = (ownerId = 'owner-a', token = `grant-${ownerId}`) => ({
  ownerId, token, expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
});
const draft = (id = 'draft-one', localRevision = 1, ownerId = 'owner-a'): OfflineReportDraft => ({
  id, ownerId, localRevision, captureId: `capture-${id}`, type: 'asset', captureMode: 'offline',
  title: 'Equipment', contractNo: 'QA-001', formData: { clientSubmissionId: 'manual-submission' },
  lots: [{ id: 'lot-one', mainImages: [{ uri: 'file:///documents/original.jpg', name: 'original.jpg', type: 'image/jpeg', size: 123 }],
    extraImages: [], videoFiles: [], coverIndex: 0 }],
  activeLotIdx: 0, createdAt: '2026-10-06T10:00:00.000Z', updatedAt: '2026-10-06T10:00:00.000Z',
});
function fixture(initial: OfflineReportDraft[] = [], supported = true, enabled = true) {
  let owner = 'owner-a';
  const key = (value: OfflineReportDraft) => `${value.ownerId}:${value.id}`;
  const pending = new Map(initial.map(value => [key(value), value]));
  const latest = new Map(pending);
  const savedListeners = new Set<() => void>();
  const native: jest.Mocked<Native> = {
    configure: jest.fn<ReturnType<Native['configure']>, Parameters<Native['configure']>>(async () => undefined),
    enqueue: jest.fn<ReturnType<Native['enqueue']>, Parameters<Native['enqueue']>>(async () => undefined),
    pause: jest.fn<ReturnType<Native['pause']>, Parameters<Native['pause']>>(async () => undefined),
    resume: jest.fn<ReturnType<Native['resume']>, Parameters<Native['resume']>>(async () => undefined),
    list: jest.fn<ReturnType<Native['list']>, Parameters<Native['list']>>(async () => []),
    deactivate: jest.fn(async () => undefined),
  };
  const store = {
    getOwnerId: jest.fn(() => owner), seedBackups: jest.fn(async () => undefined),
    pendingBackups: jest.fn(async (limit = 10, excluded: string[] = []) =>
      Array.from(pending.values()).filter(value => value.ownerId === owner && !excluded.includes(value.id)).slice(0, limit)),
    getDraft: jest.fn(async (id: string) => latest.get(`${owner}:${id}`) ?? null),
    acknowledgeBackupQueue: jest.fn(async (id: string, revision: number, expected: string) => {
      if (expected !== owner) throw new Error('Owner changed');
      const queueKey = `${expected}:${id}`;
      if (pending.get(queueKey)?.localRevision === revision) pending.delete(queueKey);
    }),
    subscribeSaved: jest.fn((listener: () => void) => {
      savedListeners.add(listener); return () => { savedListeners.delete(listener); };
    }),
  };
  const deps = {
    enabled, native: supported ? native : null, store,
    requestGrant: jest.fn(async () => grant(owner)), deviceHeaders: jest.fn(async () => ({ 'X-Device-Key': 'fixture' })),
    readPolicy: jest.fn(async () => 'unmetered' as const),
    savePolicy: jest.fn<Promise<void>, [string, 'unmetered' | 'connected']>(async () => undefined),
    readConsent: jest.fn<Promise<unknown>, [string]>(async key => ({ version: 1, ownerId: key, enabled: true })),
    saveConsent: jest.fn<Promise<void>, [string, BackupConsent]>(async () => undefined),
    connected: jest.fn(async () => false), apiBaseUrl: 'https://fixture.invalid/api',
  };
  const service = createCaptureBackupService(deps); services.push(service);
  return { service, native, store, deps, pending, latest, savedListeners,
    setOwner: (value: string) => { owner = value; },
    save: (value: OfflineReportDraft) => {
      pending.set(key(value), value); latest.set(key(value), value); savedListeners.forEach(listener => listener());
    },
  };
}

beforeEach(() => { jest.clearAllMocks(); });
afterEach(() => {
  stopCaptureBackupObservers();
  services.splice(0).forEach(service => service.cleanup());
  jest.restoreAllMocks(); jest.useRealTimers();
});

test.each([null, {}, { version: 0, ownerId: 'owner-a', enabled: true },
  { version: 1, ownerId: 'owner-b', enabled: true }, { version: 1, ownerId: 'owner-a', enabled: 'true' }])(
  'missing or invalid consent never initiates any cloud backup (%p)', async saved => {
    const rig = fixture([draft()]); rig.deps.readConsent.mockResolvedValue(saved); rig.deps.connected.mockResolvedValue(true);
    await rig.service.init('owner-a'); await rig.service.tick(); await rig.service.flush();
    await rig.service.setNetworkPolicy('connected'); await rig.service.resume('draft-one');
    rig.save(draft('new-draft'));
    expect(rig.service.getSnapshot()).toMatchObject({ consent: 'required', jobs: [] });
    expect(rig.native.deactivate).toHaveBeenCalledTimes(1);
    expect(rig.native.configure).not.toHaveBeenCalled(); expect(rig.native.enqueue).not.toHaveBeenCalled(); expect(rig.native.resume).not.toHaveBeenCalled();
    expect(rig.store.seedBackups).not.toHaveBeenCalled(); expect(rig.store.pendingBackups).not.toHaveBeenCalled(); expect(rig.store.subscribeSaved).not.toHaveBeenCalled();
    expect(rig.deps.requestGrant).not.toHaveBeenCalled(); expect(rig.deps.deviceHeaders).not.toHaveBeenCalled();
    expect(rig.pending.size).toBe(2);
  },
);

test('only a successfully persisted explicit enable starts backup, and the choice survives reopen', async () => {
  const rig = fixture([draft()]); let persisted: BackupConsent | null = null;
  const writing = deferred<void>();
  rig.deps.readConsent.mockImplementation(async () => persisted);
  rig.deps.saveConsent.mockImplementation(async (_key, value) => { await writing.promise; persisted = value; });
  await rig.service.init('owner-a');
  const enabling = rig.service.setConsent(true);
  await until(() => rig.deps.saveConsent.mock.calls.length === 1);
  await rig.service.tick(); await rig.service.flush();
  expect(rig.native.configure).not.toHaveBeenCalled(); expect(rig.store.seedBackups).not.toHaveBeenCalled();
  expect(rig.deps.requestGrant).not.toHaveBeenCalled(); expect(rig.native.enqueue).not.toHaveBeenCalled();
  writing.resolve(); await enabling;
  expect(rig.deps.savePolicy).toHaveBeenCalledWith('owner-a', 'unmetered');
  expect(rig.deps.saveConsent).toHaveBeenCalledWith('owner-a', { version: 1, ownerId: 'owner-a', enabled: true });
  expect(rig.service.getSnapshot().consent).toBe('enabled'); expect(rig.native.enqueue).toHaveBeenCalledTimes(1);
  rig.service.cleanup(); await rig.service.init('owner-a');
  expect(rig.service.getSnapshot().consent).toBe('enabled'); expect(rig.store.seedBackups).toHaveBeenCalledTimes(2);
});

test('declining or disabling is owner-bound, survives restart and retains original queue entries', async () => {
  const rig = fixture([draft()]); const choices = new Map<string, BackupConsent>();
  rig.deps.readConsent.mockImplementation(async key => choices.get(key) ?? null);
  rig.deps.saveConsent.mockImplementation(async (key, value) => { choices.set(key, value); });
  await rig.service.init('owner-a'); await rig.service.setConsent(false);
  rig.service.cleanup(); await rig.service.init('owner-a');
  expect(rig.service.getSnapshot().consent).toBe('disabled'); expect(rig.pending.size).toBe(1);
  expect(rig.native.enqueue).not.toHaveBeenCalled();
  await rig.service.setConsent(true); expect(rig.service.getSnapshot().consent).toBe('enabled');
  await rig.service.setConsent(false); rig.save(draft('second'));
  await rig.service.tick(); await rig.service.flush();
  expect(rig.native.enqueue).toHaveBeenCalledTimes(1); expect(rig.pending.size).toBe(1);
  expect(rig.service.getSnapshot().consent).toBe('disabled');
  await rig.service.deactivate(); rig.setOwner('owner-b'); await rig.service.init('owner-b');
  expect(rig.service.getSnapshot().consent).toBe('required');
  expect(choices.get('owner-a')).toEqual({ version: 1, ownerId: 'owner-a', enabled: false });
  expect(choices.has('owner-b')).toBe(false);
});

test('consent read and write failures fail closed and preserve originals', async () => {
  const source = draft(); const before = JSON.stringify(source); const rig = fixture([source]);
  rig.deps.readConsent.mockRejectedValueOnce(new Error('Storage unavailable'));
  await rig.service.init('owner-a');
  expect(rig.service.getSnapshot().consent).toBe('error');
  rig.deps.saveConsent.mockRejectedValueOnce(new Error('Storage full'));
  await expect(rig.service.setConsent(true)).rejects.toThrow('could not be saved');
  await rig.service.tick(); await rig.service.flush();
  expect(rig.native.configure).not.toHaveBeenCalled(); expect(rig.native.enqueue).not.toHaveBeenCalled();
  expect(rig.deps.requestGrant).not.toHaveBeenCalled(); expect(rig.store.seedBackups).not.toHaveBeenCalled();
  expect(rig.native.deactivate).toHaveBeenCalled(); expect(rig.pending.size).toBe(1);
  expect(JSON.stringify(source)).toBe(before);
});

test('disabling fences a pending grant and removes native authority without deleting retained jobs', async () => {
  const rig = fixture([draft()]); const waiting = deferred<ReturnType<typeof grant>>();
  rig.deps.connected.mockResolvedValue(true); rig.deps.requestGrant.mockReturnValueOnce(waiting.promise);
  const init = rig.service.init('owner-a'); await until(() => rig.deps.requestGrant.mock.calls.length === 1);
  await rig.service.setConsent(false); rig.save(draft('after-disable'));
  waiting.resolve(grant()); await init; await rig.service.flush();
  expect(rig.native.configure.mock.calls.some(([value]) => Boolean(value.token))).toBe(false);
  expect(rig.native.deactivate).toHaveBeenCalledTimes(1);
  expect(rig.native.enqueue).toHaveBeenCalledTimes(1);
  expect(rig.pending.has('owner-a:after-disable')).toBe(true);
  expect(rig.service.getSnapshot()).toMatchObject({ consent: 'disabled', jobs: [] });
});

test('disabling during a network check cannot issue a new grant when that check returns', async () => {
  const rig = fixture(); const connected = deferred<boolean>(); rig.deps.connected.mockReturnValueOnce(connected.promise);
  const init = rig.service.init('owner-a'); await until(() => rig.deps.connected.mock.calls.length === 1);
  await rig.service.setConsent(false); connected.resolve(true); await init;
  expect(rig.deps.requestGrant).not.toHaveBeenCalled(); expect(rig.deps.deviceHeaders).not.toHaveBeenCalled();
});

test('an enable finishing after decline cannot overwrite the durable off choice or start work', async () => {
  const rig = fixture([draft()]); const pendingSave = deferred<void>(); let persisted: BackupConsent | null = null;
  rig.deps.readConsent.mockResolvedValue(null);
  rig.deps.saveConsent.mockImplementation(async (_key, value) => { if (value.enabled) await pendingSave.promise; persisted = value; });
  await rig.service.init('owner-a'); const enable = rig.service.setConsent(true);
  await until(() => rig.deps.saveConsent.mock.calls.length === 1);
  const disable = rig.service.setConsent(false); pendingSave.resolve(); await Promise.all([enable, disable]);
  expect(persisted).toEqual({ version: 1, ownerId: 'owner-a', enabled: false });
  expect(rig.service.getSnapshot().consent).toBe('disabled'); expect(rig.native.configure).not.toHaveBeenCalled();
  expect(rig.native.enqueue).not.toHaveBeenCalled(); expect(rig.pending.size).toBe(1);
});

test('a late consent read cannot leak enabled state to a new account', async () => {
  const rig = fixture(); const oldRead = deferred<unknown>(); rig.deps.readConsent.mockReturnValueOnce(oldRead.promise).mockResolvedValue(null);
  const first = rig.service.init('owner-a'); await until(() => rig.deps.readConsent.mock.calls.length === 1);
  await rig.service.deactivate(); rig.setOwner('owner-b'); await rig.service.init('owner-b');
  oldRead.resolve({ version: 1, ownerId: 'owner-a', enabled: true }); await first;
  expect(rig.service.getSnapshot()).toMatchObject({ ownerId: 'owner-b', consent: 'required', jobs: [] });
  expect(rig.native.configure).not.toHaveBeenCalled(); expect(rig.store.seedBackups).not.toHaveBeenCalled();
});

test('a disabled build ignores even stored consent and rejects every backup control', async () => {
  const rig = fixture([draft()], true, false); rig.deps.connected.mockResolvedValue(true);
  await rig.service.init('owner-a');
  await rig.service.setConsent(true); await rig.service.resume('draft-one'); await rig.service.setNetworkPolicy('connected');
  await rig.service.flush(); await rig.service.tick(); rig.save(draft('new'));
  expect(rig.service.getSnapshot()).toMatchObject({ supported: false, consent: 'disabled' });
  expect(rig.deps.readConsent).not.toHaveBeenCalled(); expect(rig.deps.saveConsent).not.toHaveBeenCalled();
  expect(rig.deps.requestGrant).not.toHaveBeenCalled(); expect(rig.store.seedBackups).not.toHaveBeenCalled();
  expect(rig.native.configure).not.toHaveBeenCalled(); expect(rig.native.enqueue).not.toHaveBeenCalled(); expect(rig.native.resume).not.toHaveBeenCalled();
  expect(rig.native.deactivate).toHaveBeenCalledTimes(1); expect(rig.pending.size).toBe(2);
});

test('clears an authorization warning after a later successful reconnect', async () => {
  const rig = fixture();
  let now = Date.now();
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  rig.deps.connected.mockResolvedValue(true);
  rig.deps.requestGrant.mockRejectedValueOnce(new Error('Temporary connection failure'));
  await rig.service.init('owner-a');
  expect(rig.service.getSnapshot().error).toContain('authorization could not be refreshed');
  now += 61_000;
  await rig.service.tick();
  expect(rig.service.getSnapshot().error).toBeUndefined();
});

test('hands every offline save to the native scheduler before any network authorization', async () => {
  const source = draft(); const before = JSON.stringify(source);
  const rig = fixture([source]);
  await rig.service.init('owner-a');
  expect(rig.store.seedBackups).toHaveBeenCalledTimes(1);
  expect(rig.native.enqueue).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'owner-a', revision: 1,
    formData: expect.objectContaining({ manualSubmissionRequired: true, clientSubmissionId: 'manual-submission' }) }));
  expect(rig.store.acknowledgeBackupQueue).toHaveBeenCalledWith('draft-one', 1, 'owner-a');
  expect(rig.pending.size).toBe(0);
  expect(rig.deps.requestGrant).not.toHaveBeenCalled();
  expect(JSON.stringify(source)).toBe(before);
  expect(api.post).not.toHaveBeenCalled();
});

test('a stalled grant cannot hold already saved metadata away from Android', async () => {
  const rig = fixture([draft()]); const wait = deferred<ReturnType<typeof grant>>();
  rig.deps.connected.mockResolvedValue(true); rig.deps.requestGrant.mockReturnValue(wait.promise);
  const starting = rig.service.init('owner-a');
  await until(() => rig.deps.requestGrant.mock.calls.length === 1);
  expect(rig.native.enqueue).toHaveBeenCalledTimes(1);
  expect(rig.pending.size).toBe(0);
  wait.resolve(grant()); await starting;
  expect(rig.native.configure).toHaveBeenLastCalledWith(expect.objectContaining({ ownerId: 'owner-a', token: 'grant-owner-a' }));
});

test('rejects a requested owner that does not match the local store', async () => {
  const rig = fixture([draft()]); await rig.service.init('owner-b');
  expect(rig.native.configure).not.toHaveBeenCalled();
  expect(rig.store.pendingBackups).not.toHaveBeenCalled();
  expect(rig.service.getSnapshot().ownerId).toBeNull();
  expect(rig.pending.size).toBe(1);
});

test('late grants cannot reactivate a signed-out owner or overwrite the next account', async () => {
  const rig = fixture(); const oldGrant = deferred<ReturnType<typeof grant>>();
  rig.deps.connected.mockResolvedValue(true); rig.deps.requestGrant.mockReturnValueOnce(oldGrant.promise);
  const oldStart = rig.service.init('owner-a'); await until(() => rig.deps.requestGrant.mock.calls.length === 1);
  await rig.service.deactivate(); rig.setOwner('owner-b'); await rig.service.init('owner-b');
  const readsBeforeOldGrant = rig.native.list.mock.calls.length;
  oldGrant.resolve(grant('owner-a', 'late-owner-a-token')); await oldStart;
  expect(rig.native.configure.mock.calls.some(([options]) => options.token === 'late-owner-a-token')).toBe(false);
  expect(rig.service.getSnapshot().ownerId).toBe('owner-b');
  expect(rig.native.deactivate).toHaveBeenCalledTimes(1);
  expect(rig.native.list).toHaveBeenCalledTimes(readsBeforeOldGrant);
  expect(rig.native.list).toHaveBeenLastCalledWith('owner-b');
});

test('late native status reads cannot display another owner\'s jobs', async () => {
  const rig = fixture(); const oldJobs = deferred<Awaited<ReturnType<Native['list']>>>();
  rig.native.list.mockReturnValueOnce(oldJobs.promise);
  const first = rig.service.init('owner-a'); await until(() => rig.native.list.mock.calls.length === 1);
  await rig.service.deactivate(); rig.setOwner('owner-b'); await rig.service.init('owner-b');
  oldJobs.resolve([{ clientDraftId: 'private-owner-a', revision: 1, status: 'completed', verified: 1, total: 1 }]);
  await first;
  expect(rig.service.getSnapshot()).toMatchObject({ ownerId: 'owner-b', jobs: [] });
});

test('logout serializes behind an in-flight native configure and stops further queue work', async () => {
  const rig = fixture([draft()]); const configuring = deferred<unknown>();
  rig.native.configure.mockReturnValueOnce(configuring.promise);
  const starting = rig.service.init('owner-a'); await until(() => rig.native.configure.mock.calls.length === 1);
  const stopping = rig.service.deactivate();
  expect(rig.native.deactivate).not.toHaveBeenCalled();
  configuring.resolve(undefined); await Promise.all([starting, stopping]);
  expect(rig.native.deactivate).toHaveBeenCalledTimes(1);
  expect(rig.native.enqueue).not.toHaveBeenCalled();
  expect(rig.service.getSnapshot().ownerId).toBeNull();
});

test('owner changes during enqueue cannot acknowledge the old save against another account', async () => {
  const rig = fixture([draft()]); const enqueue = deferred<unknown>();
  rig.native.enqueue.mockReturnValueOnce(enqueue.promise);
  const starting = rig.service.init('owner-a'); await until(() => rig.native.enqueue.mock.calls.length === 1);
  const stopping = rig.service.deactivate(); rig.setOwner('owner-b');
  rig.save(draft('draft-one', 2, 'owner-b'));
  const next = rig.service.init('owner-b'); enqueue.resolve(undefined);
  await Promise.all([starting, stopping, next]);
  expect(rig.store.acknowledgeBackupQueue.mock.calls).toEqual([['draft-one', 2, 'owner-b']]);
  expect(rig.pending.get('owner-a:draft-one')?.localRevision).toBe(1);
  expect(rig.native.enqueue.mock.calls.map(([snapshot]) => snapshot.ownerId)).toEqual(['owner-a', 'owner-b']);
});

test('a save arriving during enqueue is drained immediately; stale revision acknowledgement cannot erase it', async () => {
  const rig = fixture([draft()]); const enqueue = deferred<unknown>();
  rig.native.enqueue.mockReturnValueOnce(enqueue.promise);
  const starting = rig.service.init('owner-a'); await until(() => rig.native.enqueue.mock.calls.length === 1);
  rig.save(draft('draft-one', 2));
  const joined = rig.service.flush();
  expect(rig.pending.get('owner-a:draft-one')?.localRevision).toBe(2);
  enqueue.resolve(undefined); await Promise.all([starting, joined]);
  expect(rig.native.enqueue.mock.calls.map(([snapshot]) => snapshot.revision)).toEqual([1, 2]);
  expect(rig.store.acknowledgeBackupQueue.mock.calls).toEqual([['draft-one', 1, 'owner-a'], ['draft-one', 2, 'owner-a']]);
  expect(rig.pending.size).toBe(0);
});

test('drains more than the former ten-draft window in a single offline handoff', async () => {
  const rig = fixture(Array.from({ length: 14 }, (_, index) => draft(`draft-${index}`)));
  await rig.service.init('owner-a');
  expect(rig.native.enqueue).toHaveBeenCalledTimes(14);
  expect(rig.pending.size).toBe(0);
  expect(rig.deps.requestGrant).not.toHaveBeenCalled();
});

test('one unavailable original does not starve other drafts and remains retryable', async () => {
  const unavailable = draft('bad'); unavailable.lots[0].mainImages = [{ uri: 'file:///gone.jpg', name: 'gone.jpg', type: 'image/jpeg', missing: true }];
  const rig = fixture([unavailable, draft('good')]); await rig.service.init('owner-a');
  expect(rig.native.enqueue.mock.calls.map(([snapshot]) => snapshot.clientDraftId)).toEqual(['good']);
  expect(Array.from(rig.pending.keys())).toEqual(['owner-a:bad']);
  expect(rig.store.acknowledgeBackupQueue.mock.calls).toEqual([['good', 1, 'owner-a']]);
  expect(rig.service.getSnapshot().error).toMatch(/not available/);
  rig.save(draft('bad', 2)); await rig.service.flush();
  expect(rig.pending.size).toBe(0);
  expect(rig.native.enqueue).toHaveBeenLastCalledWith(expect.objectContaining({ clientDraftId: 'bad', revision: 2 }));
});

test('a native enqueue failure is unacknowledged, sanitized, and does not block later drafts', async () => {
  const rig = fixture([draft('bad'), draft('good')]);
  rig.native.enqueue.mockRejectedValueOnce(new Error('HTTP status code 503 https://private.invalid/signed?token=secret'));
  await rig.service.init('owner-a');
  expect(Array.from(rig.pending.keys())).toEqual(['owner-a:bad']);
  expect(rig.store.acknowledgeBackupQueue.mock.calls).toEqual([['good', 1, 'owner-a']]);
  expect(rig.service.getSnapshot().error).not.toMatch(/private|secret|https:/);
  await rig.service.flush(); expect(rig.pending.size).toBe(0);
});

test('explicit pause and resume address only the current draft and never authorize report submission', async () => {
  const source = draft(); const before = JSON.stringify(source); const rig = fixture([source]);
  await rig.service.init('owner-a'); await rig.service.pause(source.id);
  expect(rig.native.pause).toHaveBeenCalledWith('owner-a', source.id, 'user_pause');
  rig.deps.connected.mockResolvedValue(true); await rig.service.resume(source.id);
  await rig.service.tick();
  expect(rig.deps.requestGrant).toHaveBeenCalledTimes(1);
  expect(rig.native.resume).toHaveBeenCalledWith('owner-a', source.id);
  expect(rig.native.deactivate).not.toHaveBeenCalled();
  expect(JSON.stringify(source)).toBe(before);
  expect(api.post).not.toHaveBeenCalled(); expect(api.put).not.toHaveBeenCalled(); expect(api.delete).not.toHaveBeenCalled();
});

test('Pause and Resume settle while a network grant is stalled, without disabling other backups', async () => {
  const rig = fixture([draft()]); const wait = deferred<ReturnType<typeof grant>>();
  rig.deps.connected.mockResolvedValue(true); rig.deps.requestGrant.mockReturnValueOnce(wait.promise);
  const starting = rig.service.init('owner-a'); await until(() => rig.deps.requestGrant.mock.calls.length === 1);
  let paused = false;
  const pausing = rig.service.pause('draft-one').then(() => { paused = true; });
  await until(() => paused);
  expect(rig.native.pause).toHaveBeenCalledWith('owner-a', 'draft-one', 'user_pause');
  let resumed = false;
  const resuming = rig.service.resume('draft-one').then(() => { resumed = true; });
  await until(() => resumed);
  expect(rig.native.resume).toHaveBeenCalledWith('owner-a', 'draft-one');
  expect(rig.native.deactivate).not.toHaveBeenCalled();
  wait.resolve(grant()); await Promise.all([starting, pausing, resuming]);
});

test('a native authentication-required receipt allows explicit resume to refresh a previously valid grant', async () => {
  const rig = fixture(); rig.deps.connected.mockResolvedValue(true);
  await rig.service.init('owner-a');
  rig.native.list.mockResolvedValue([{ clientDraftId: 'draft-one', revision: 1, status: 'auth_required', verified: 0, total: 1 }]);
  await rig.service.resume('draft-one'); await rig.service.tick();
  expect(rig.deps.requestGrant).toHaveBeenCalledTimes(2);
  expect(rig.native.resume).toHaveBeenCalledWith('owner-a', 'draft-one');
});

test.each(['queued', 'latest'] as const)('a %s discarded draft pauses backup without deleting originals or cloud objects', async state => {
  const source = draft(); const rig = fixture([state === 'queued' ? { ...source, submissionState: 'discarded' } : source]);
  if (state === 'latest') rig.latest.set('owner-a:draft-one', { ...source, submissionState: 'discarded' });
  await rig.service.init('owner-a');
  expect(rig.native.pause).toHaveBeenCalledWith('owner-a', 'draft-one', 'draft_deleted');
  expect(rig.native.enqueue).not.toHaveBeenCalled();
  expect(rig.store.acknowledgeBackupQueue).toHaveBeenCalledWith('draft-one', 1, 'owner-a');
  expect(source.lots[0].mainImages).toHaveLength(1);
  expect(api.delete).not.toHaveBeenCalled();
});

test('native-unavailable clients preserve the durable queue without promising background support', async () => {
  const rig = fixture([draft()], false); await rig.service.init('owner-a'); await rig.service.flush();
  expect(rig.service.getSnapshot()).toMatchObject({ ownerId: 'owner-a', supported: false, jobs: [] });
  expect(rig.pending.size).toBe(1);
  expect(rig.store.pendingBackups).not.toHaveBeenCalled(); expect(rig.store.subscribeSaved).not.toHaveBeenCalled();
  expect(rig.deps.requestGrant).not.toHaveBeenCalled(); expect(rig.store.acknowledgeBackupQueue).not.toHaveBeenCalled();
});

test('foreground cleanup stops observers but does not deactivate persisted native work', async () => {
  const rig = fixture([draft()]); await rig.service.init('owner-a'); rig.service.cleanup();
  expect(rig.savedListeners.size).toBe(0);
  rig.save(draft('draft-two')); await rig.service.tick();
  expect(rig.native.enqueue).toHaveBeenCalledTimes(1);
  expect(rig.pending.size).toBe(1);
  expect(rig.native.deactivate).not.toHaveBeenCalled();
  await rig.service.init('owner-a'); expect(rig.pending.size).toBe(0);
});

test('the bounded close/save handoff leaves an unacknowledged outbox record durable while native enqueue stalls', async () => {
  jest.useFakeTimers(); const rig = fixture(); await rig.service.init('owner-a');
  const enqueue = deferred<unknown>(); rig.native.enqueue.mockReturnValueOnce(enqueue.promise);
  rig.save(draft()); await until(() => rig.native.enqueue.mock.calls.length === 1);
  let handedOff = false;
  const close = flushBackupHandoff().then(() => { handedOff = true; });
  await jest.advanceTimersByTimeAsync(4999); expect(handedOff).toBe(false);
  await jest.advanceTimersByTimeAsync(1); await close;
  expect(handedOff).toBe(true);
  expect(rig.pending.size).toBe(1); expect(rig.store.acknowledgeBackupQueue).not.toHaveBeenCalled();
  enqueue.resolve(undefined); await rig.service.flush();
  expect(rig.pending.size).toBe(0); expect(jest.getTimerCount()).toBe(0);
});

test('a late policy save does not reconfigure the previous owner after an account change', async () => {
  const rig = fixture(); await rig.service.init('owner-a'); const save = deferred<void>();
  rig.deps.savePolicy.mockReturnValueOnce(save.promise);
  const changing = rig.service.setNetworkPolicy('connected');
  await rig.service.deactivate(); rig.setOwner('owner-b'); await rig.service.init('owner-b');
  save.resolve(); await changing;
  expect(rig.deps.savePolicy).toHaveBeenCalledWith('owner-a', 'connected');
  expect(rig.native.configure.mock.calls.some(([options]) => options.networkPolicy === 'connected')).toBe(false);
  expect(rig.service.getSnapshot()).toMatchObject({ ownerId: 'owner-b', networkPolicy: 'unmetered' });
});

test.each(['foreign', 'expired', 'missing'] as const)('rejects %s grants without erasing existing native authority', async kind => {
  const rig = fixture(); rig.deps.connected.mockResolvedValue(true);
  rig.deps.requestGrant.mockResolvedValue(kind === 'foreign' ? grant('owner-b') : kind === 'expired'
    ? { ...grant(), expiresAt: '2000-01-01T00:00:00.000Z' } : { ...grant(), token: '' });
  await rig.service.init('owner-a');
  expect(rig.native.configure).toHaveBeenCalledTimes(1);
  expect(rig.native.configure.mock.calls[0][0]).not.toHaveProperty('token');
  expect(rig.native.deactivate).not.toHaveBeenCalled();
  expect(rig.service.getSnapshot().error).toMatch(/authorization could not be refreshed/);
});

test('the release adapter defaults off and cancels previous native work without any authority or upload', async () => {
  await CaptureBackupService.init('owner-a'); await CaptureBackupService.setNetworkPolicy('connected');
  await CaptureBackupService.setConsent(true); await CaptureBackupService.flush(); await CaptureBackupService.tick();
  expect(CaptureBackupService.getSnapshot()).toMatchObject({ supported: false, consent: 'disabled', jobs: [] });
  expect(api.post).not.toHaveBeenCalled();
  expect(api.get).not.toHaveBeenCalled(); expect(api.put).not.toHaveBeenCalled(); expect(api.patch).not.toHaveBeenCalled(); expect(api.delete).not.toHaveBeenCalled();
  expect(AsyncStorage.getItem).not.toHaveBeenCalled(); expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  expect(singletonNative.configure).not.toHaveBeenCalled(); expect(singletonNative.enqueue).not.toHaveBeenCalled();
  expect(singletonNative.deactivate).toHaveBeenCalledTimes(1);
  expect(offlineStore.seedBackups).not.toHaveBeenCalled();
  expect(offlineStore.acknowledgeBackupQueue).not.toHaveBeenCalled();
});

test('disabled release startup deactivates persisted jobs and never registers automatic lifecycle work', async () => {
  jest.useFakeTimers();
  await startCaptureBackups('owner-a');
  expect(CaptureBackupService.getSnapshot().supported).toBe(false);
  expect(singletonNative.deactivate).toHaveBeenCalledTimes(1);
  expect(singletonNative.configure).not.toHaveBeenCalled(); expect(singletonNative.enqueue).not.toHaveBeenCalled();
  expect(NetInfo.addEventListener).not.toHaveBeenCalled(); expect(AppState.addEventListener).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);
});

test('stopping during async startup cannot install late timers or lifecycle observers', async () => {
  jest.useFakeTimers(); const init = deferred<void>();
  jest.spyOn(CaptureBackupService, 'init').mockReturnValueOnce(init.promise);
  jest.spyOn(CaptureBackupService, 'getSnapshot').mockReturnValue({ ownerId: 'owner-a', supported: true, consent: 'enabled', networkPolicy: 'unmetered', jobs: [] });
  const starting = startCaptureBackups('owner-a'); stopCaptureBackupObservers(); init.resolve(); await starting;
  expect(jest.getTimerCount()).toBe(0);
  expect(NetInfo.addEventListener).not.toHaveBeenCalled(); expect(AppState.addEventListener).not.toHaveBeenCalled();
});

test('overlapping same-owner restarts attach only the newest lifecycle epoch and clean it up', async () => {
  jest.useFakeTimers(); const old = deferred<void>(); const newest = deferred<void>();
  jest.spyOn(CaptureBackupService, 'init').mockReturnValueOnce(old.promise).mockReturnValueOnce(newest.promise);
  jest.spyOn(CaptureBackupService, 'getSnapshot').mockReturnValue({ ownerId: 'owner-a', supported: true, consent: 'enabled', networkPolicy: 'unmetered', jobs: [] });
  const first = startCaptureBackups('owner-a'); const second = startCaptureBackups('owner-a');
  old.resolve(); await first;
  expect(NetInfo.addEventListener).not.toHaveBeenCalled();
  newest.resolve(); await second;
  expect(NetInfo.addEventListener).toHaveBeenCalledTimes(1); expect(AppState.addEventListener).toHaveBeenCalledTimes(1);
  expect(jest.getTimerCount()).toBe(1);
  const networkUnsubscribe = jest.mocked(NetInfo.addEventListener).mock.results[0].value;
  const appSubscription = jest.mocked(AppState.addEventListener).mock.results[0].value;
  stopCaptureBackupObservers();
  expect(jest.getTimerCount()).toBe(0); expect(networkUnsubscribe).toHaveBeenCalledTimes(1); expect(appSubscription.remove).toHaveBeenCalledTimes(1);
});
