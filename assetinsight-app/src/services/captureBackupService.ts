import { AppState, Dimensions, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import { requireOptionalNativeModule } from 'expo-modules-core';
import api from './api';
import { API_BASE_URL } from '../config/api';
import OfflineCaptureStore from './offlineCaptureStore';
import { getOrCreateDeviceKey } from './deviceAccessStorage';
import { getAndroidReinstallId } from './deviceReinstallIdentity';
import { getAppVersionLabel } from './appVersion';
import { createCaptureBackupSnapshot, type CaptureBackupSnapshot } from './captureBackupSnapshot';
import { registerBackupHandoff } from './captureBackupHandoff';

export type BackupStatus = {
  clientDraftId: string; revision: number; planId?: string; title?: string; contractNo?: string; pauseReason?: string;
  status: 'queued' | 'uploading' | 'paused' | 'waiting_network' | 'interrupted' | 'auth_required' | 'needs_attention' | 'completed';
  verified: number; total: number; message?: string; updatedAt?: string;
  retainedEarlierRevisionsPending?: number;
  retainedEarlierRevisionsStatus?: BackupStatus['status'];
};
export type BackupNetworkPolicy = 'unmetered' | 'connected';
export type BackupConsent = { version: 1; ownerId: string; enabled: boolean };
export type BackupConsentState = 'loading' | 'required' | 'enabled' | 'disabled' | 'error';
type NativeBackup = {
  configure(options: { ownerId: string; apiBaseUrl: string; networkPolicy: BackupNetworkPolicy; token?: string; expiresAt?: string; headers?: Record<string, string> }): Promise<unknown>;
  enqueue(snapshot: CaptureBackupSnapshot): Promise<unknown>;
  pause(ownerId: string, draftId: string, reason?: string): Promise<unknown>;
  resume(ownerId: string, draftId: string): Promise<unknown>;
  list(ownerId: string): Promise<BackupStatus[]>;
  deactivate(): Promise<unknown>;
};
export type BackupView = { ownerId: string | null; supported: boolean; consent: BackupConsentState; networkPolicy: BackupNetworkPolicy; jobs: BackupStatus[]; error?: string };
const native = Platform.OS === 'android' ? requireOptionalNativeModule<NativeBackup>('CaptureBackup') : null;

/** Foreground reconciliation only. The native OS worker owns all byte transfers. */
export function createCaptureBackupService(deps: {
  enabled: boolean;
  native: NativeBackup | null;
  store: Pick<typeof OfflineCaptureStore, 'getOwnerId' | 'pendingBackups' | 'acknowledgeBackupQueue' | 'subscribeSaved' | 'getDraft'> & { seedBackups?: () => Promise<void> };
  requestGrant: () => Promise<{ ownerId: string; token: string; expiresAt: string }>;
  deviceHeaders: () => Promise<Record<string, string>>;
  readPolicy: (ownerId: string) => Promise<BackupNetworkPolicy>;
  savePolicy: (ownerId: string, policy: BackupNetworkPolicy) => Promise<void>;
  readConsent: (ownerId: string) => Promise<unknown>;
  saveConsent: (ownerId: string, consent: BackupConsent) => Promise<void>;
  connected: () => Promise<boolean>;
  apiBaseUrl: string;
}) {
  let view: BackupView = { ownerId: null, supported: deps.enabled && Boolean(deps.native), consent: 'loading', networkPolicy: 'unmetered', jobs: [] };
  let generation = 0;
  let owner: string | null = null;
  let active = false;
  let consentEnabled = false;
  let authorityUntil = 0;
  let nextGrantAttempt = 0;
  let flight: Promise<void> | null = null;
  let queueFlight: Promise<void> | null = null;
  let queueDirty = false;
  let nativeTail: Promise<unknown> = Promise.resolve();
  let consentTail: Promise<unknown> = Promise.resolve();
  let unsubscribe: (() => void) | undefined;
  let unregisterHandoff: (() => void) | undefined;
  let queueError: string | undefined;
  let authorityError: string | undefined;
  let readinessError: string | undefined;
  const listeners = new Set<() => void>();
  const publish = (update: Partial<BackupView>) => { view = { ...view, ...update }; listeners.forEach(listener => listener()); };
  const publishErrors = () => publish({ error: queueError || authorityError || readinessError });
  // Serialize native authority changes. A late configure can never run after logout.
  const serial = <T,>(work: () => Promise<T>): Promise<T> => {
    const next = nativeTail.catch(() => undefined).then(work);
    nativeTail = next.catch(() => undefined); return next;
  };
  const contextCurrent = (key: string, epoch: number) => active && owner === key && generation === epoch && deps.store.getOwnerId() === key;
  const current = (key: string, epoch: number) => deps.enabled && consentEnabled && contextCurrent(key, epoch);
  const detach = () => {
    unsubscribe?.(); unsubscribe = undefined;
    unregisterHandoff?.(); unregisterHandoff = undefined;
    flight = null; queueFlight = null;
  };
  async function activate(key: string, epoch: number) {
    if (!deps.native || !current(key, epoch)) return;
    const policy = await deps.readPolicy(key).catch(() => 'unmetered' as const);
    if (!current(key, epoch)) return;
    publish({ networkPolicy: policy });
    await serial(async () => { if (current(key, epoch)) await deps.native!.configure({ ownerId: key, apiBaseUrl: deps.apiBaseUrl, networkPolicy: policy }); });
    if (!current(key, epoch)) return;
    await deps.store.seedBackups?.();
    if (!current(key, epoch)) return;
    unsubscribe = deps.store.subscribeSaved(() => { void flush().catch(() => undefined); });
    unregisterHandoff = registerBackupHandoff(flush);
    await tick();
  }
  async function refreshState() {
    const key = owner; const epoch = generation;
    if (!key || !deps.native || !current(key, epoch)) return;
    const jobs = await deps.native.list(key);
    if (!current(key, epoch)) return;
    if (jobs.some(job => job.status === 'auth_required')) authorityUntil = 0;
    publish({ jobs });
  }
  async function flush() {
    queueDirty = true;
    if (queueFlight) return queueFlight;
    const key = owner; const epoch = generation;
    if (!key || !deps.native || !current(key, epoch)) return;
    const bridge = deps.native;
    const run = (async () => {
      const failed: string[] = [];
      let errorForPass: string | undefined;
      // Drain one metadata manifest at a time, including a save that arrives during
      // native enqueue. An old receipt never leaves the newer save waiting on a timer.
      for (let pass = 0; pass < 200; pass++) {
        queueDirty = false;
        const [draft] = await deps.store.pendingBackups(1, failed);
        if (!draft) { if (queueDirty) continue; break; }
        if (!current(key, epoch)) return;
        try {
          const latest = await deps.store.getDraft(draft.id);
          if (!current(key, epoch)) return;
          if (draft.submissionState === 'discarded' || latest?.submissionState === 'discarded') {
            await serial(async () => { if (current(key, epoch)) await bridge.pause(key, draft.id, 'draft_deleted'); });
          } else {
            const snapshot = createCaptureBackupSnapshot(draft);
            if (snapshot.ownerId !== key) throw new Error('This backup belongs to another account.');
            await serial(async () => { if (current(key, epoch)) await bridge.enqueue(snapshot); });
          }
          if (!current(key, epoch)) return;
          await deps.store.acknowledgeBackupQueue(draft.id, draft.localRevision!, key);
        } catch (error) {
          if (!current(key, epoch)) return;
          errorForPass = error instanceof Error && !/https?:|file:|content:|status code/i.test(error.message)
            ? error.message : 'The backup queue needs attention. Keep your originals and reopen the draft.';
          queueError = errorForPass; publishErrors();
          failed.push(draft.id);
        }
      }
      if (current(key, epoch)) { queueError = errorForPass; publishErrors(); }
    })();
    queueFlight = run;
    try { await run; } finally { if (queueFlight === run) queueFlight = null; }
  }
  async function tick() {
    if (flight) return flight;
    const key = owner; const epoch = generation;
    if (!key || !deps.native || !current(key, epoch)) return;
    const bridge = deps.native;
    const run = (async () => {
      try {
        // Hand the durable queue to Android BEFORE any network/authorization wait.
        await flush();
        if (!current(key, epoch)) return;
        await refreshState();
        if (!current(key, epoch)) return;
        if (Date.now() >= nextGrantAttempt && authorityUntil < Date.now() + 3600_000 && await deps.connected()) {
          if (!current(key, epoch)) return;
          nextGrantAttempt = Date.now() + 60_000;
          try {
            const [grant, headers] = await Promise.all([deps.requestGrant(), deps.deviceHeaders()]);
            if (!current(key, epoch)) return;
            if (grant.ownerId !== key || !grant.token || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now()) {
              throw new Error('Backup authorization was incomplete. Reconnect and retry.');
            }
            await serial(async () => {
              if (!current(key, epoch)) return;
              await bridge.configure({ ownerId: key, apiBaseUrl: deps.apiBaseUrl, networkPolicy: view.networkPolicy, token: grant.token, expiresAt: grant.expiresAt, headers });
            });
            if (!current(key, epoch)) return;
            authorityUntil = Date.parse(grant.expiresAt);
            authorityError = undefined; publishErrors();
          } catch {
            if (!current(key, epoch)) return;
            // Already-persisted authority remains valid offline. Never erase it for a timeout.
            authorityError = 'Backup authorization could not be refreshed. Originals remain on this phone. Reconnect or sign in again if backup stays paused.';
            publishErrors();
          }
        }
        await refreshState();
        if (current(key, epoch)) { readinessError = undefined; publishErrors(); }
      } catch {
        if (current(key, epoch)) {
          readinessError = 'Background backup is not ready. Your device originals are unchanged. Reopen the app and retry.';
          publishErrors();
        }
      }
    })();
    flight = run;
    try { await run; } finally { if (flight === run) flight = null; }
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => view,
    async init(nextOwner: string) {
      if (!nextOwner || deps.store.getOwnerId() !== nextOwner) return;
      if (active && owner === nextOwner) return tick();
      const epoch = ++generation; owner = nextOwner; active = true; consentEnabled = false; authorityUntil = 0; nextGrantAttempt = 0;
      detach();
      queueError = authorityError = readinessError = undefined;
      publish({ ownerId: nextOwner, consent: 'loading', jobs: [], error: undefined, networkPolicy: 'unmetered' });
      if (!deps.enabled) {
        publish({ consent: 'disabled' });
        await serial(async () => { if (contextCurrent(nextOwner, epoch)) await deps.native?.deactivate(); });
        return;
      }
      try {
        // A previous choice must finish persisting before a reopen can read it.
        await consentTail.catch(() => undefined);
        if (!contextCurrent(nextOwner, epoch)) return;
        const saved = await deps.readConsent(nextOwner);
        if (!contextCurrent(nextOwner, epoch)) return;
        const consent = saved && typeof saved === 'object' ? saved as Partial<BackupConsent> : null;
        const valid = consent?.version === 1 && consent.ownerId === nextOwner && typeof consent.enabled === 'boolean';
        consentEnabled = valid && consent.enabled === true;
        publish({ consent: consentEnabled ? 'enabled' : valid ? 'disabled' : 'required' });
      } catch {
        if (!contextCurrent(nextOwner, epoch)) return;
        readinessError = 'Your cloud backup choice could not be read. Backup stays off. Keep your originals and retry enabling it.';
        publish({ consent: 'error' }); publishErrors();
      }
      if (!current(nextOwner, epoch)) {
        // Includes old native work left by a pre-consent binary. No local or cloud
        // originals are deleted; native authority and work are disabled only.
        await serial(async () => { if (contextCurrent(nextOwner, epoch)) await deps.native?.deactivate(); });
        return;
      }
      await activate(nextOwner, epoch);
    },
    async setConsent(enabled: boolean) {
      const key = owner;
      if (!deps.enabled || !key || !deps.native || !contextCurrent(key, generation)) return;
      // Fence grants, enqueues and policy changes immediately, including an old
      // enable click whose storage or native response has not returned yet.
      const epoch = ++generation;
      consentEnabled = false; authorityUntil = 0; nextGrantAttempt = 0; detach();
      queueError = authorityError = readinessError = undefined;
      publish({ consent: enabled ? 'loading' : 'disabled', jobs: [], error: undefined });
      const stopped = serial(async () => { await deps.native!.deactivate(); });
      const saved = consentTail.catch(() => undefined).then(async () => {
        // Enabling always starts with the disclosed default, even if an older
        // installation saved a mobile-data preference before consent existed.
        if (enabled && contextCurrent(key, epoch)) await deps.savePolicy(key, 'unmetered');
        if (contextCurrent(key, epoch)) await deps.saveConsent(key, { version: 1, ownerId: key, enabled });
      });
      consentTail = saved;
      try {
        await Promise.all([saved, stopped]);
        if (!contextCurrent(key, epoch)) return;
        consentEnabled = enabled;
        publish({ consent: enabled ? 'enabled' : 'disabled' });
        if (enabled) await activate(key, epoch);
      } catch {
        if (!contextCurrent(key, epoch)) return;
        consentEnabled = false;
        readinessError = 'Your cloud backup choice could not be saved. Backup is stopped on this screen. Keep your originals and retry before reopening the app.';
        publish({ consent: 'error' }); publishErrors();
        // Even a failed consent write must not leave native authority running.
        await serial(async () => { if (contextCurrent(key, epoch)) await deps.native!.deactivate(); });
        throw new Error(readinessError);
      }
    },
    // Unmount/background stops observers, NOT the OS backup queue.
    cleanup() { active = false; generation++; detach(); },
    async deactivate() {
      active = false; generation++; owner = null; consentEnabled = false; authorityUntil = 0; detach();
      queueError = authorityError = readinessError = undefined;
      publish({ ownerId: null, consent: 'loading', jobs: [], error: undefined });
      await serial(async () => { await deps.native?.deactivate(); });
    },
    tick,
    flush,
    async setNetworkPolicy(policy: BackupNetworkPolicy) {
      const key = owner; const epoch = generation;
      if (!key || !current(key, epoch) || !deps.native || !['unmetered', 'connected'].includes(policy)) return;
      await deps.savePolicy(key, policy);
      if (!current(key, epoch)) return;
      await serial(async () => { if (current(key, epoch)) await deps.native!.configure({ ownerId: key, apiBaseUrl: deps.apiBaseUrl, networkPolicy: policy }); });
      if (current(key, epoch)) publish({ networkPolicy: policy });
    },
    async pause(draftId: string) {
      const key = owner; const epoch = generation;
      if (!key || !current(key, epoch)) return;
      await serial(async () => { if (current(key, epoch)) await deps.native?.pause(key, draftId, 'user_pause'); });
      await refreshState();
    },
    async resume(draftId: string) {
      const key = owner; const epoch = generation;
      if (!key || !current(key, epoch)) return;
      nextGrantAttempt = 0;
      await serial(async () => { if (current(key, epoch)) await deps.native?.resume(key, draftId); });
      await refreshState();
      void tick();
    },
  };
}

const CaptureBackupService = createCaptureBackupService({
  enabled: process.env.EXPO_PUBLIC_CAPTURE_BACKUP_ENABLED === 'true',
  native, store: OfflineCaptureStore, apiBaseUrl: API_BASE_URL,
  async requestGrant() { return (await api.post('/capture-backups/grant')).data.data; },
  async deviceHeaders() {
    const [key, reinstallId] = await Promise.all([getOrCreateDeviceKey(), getAndroidReinstallId()]);
    const screen = Dimensions.get('screen');
    return { 'X-Device-Key': key, ...(reinstallId ? { 'X-Device-Reinstall-Id': reinstallId } : {}),
      'X-Device-Platform': 'android', 'X-Activity-Source': 'android', 'X-App-Version': getAppVersionLabel() || 'unknown',
      'X-Device-Form-Factor': Math.min(screen.width, screen.height) >= 600 ? 'tablet' : 'mobile' };
  },
  async readPolicy(ownerId) { return (await AsyncStorage.getItem(`@capture-backup-network:${ownerId}`)) === 'connected' ? 'connected' : 'unmetered'; },
  async savePolicy(ownerId, policy) { await AsyncStorage.setItem(`@capture-backup-network:${ownerId}`, policy); },
  async readConsent(ownerId) {
    const saved = await AsyncStorage.getItem(`@capture-backup-consent:v1:${ownerId}`);
    return saved ? JSON.parse(saved) : null;
  },
  async saveConsent(ownerId, consent) { await AsyncStorage.setItem(`@capture-backup-consent:v1:${ownerId}`, JSON.stringify(consent)); },
  async connected() { const net = await NetInfo.fetch(); return net.isConnected === true && net.isInternetReachable !== false; },
});

let stopLifecycle: (() => void) | undefined;
let lifecycleEpoch = 0;
export async function startCaptureBackups(ownerId: string) {
  const epoch = ++lifecycleEpoch;
  stopLifecycle?.();
  stopLifecycle = undefined;
  await CaptureBackupService.init(ownerId);
  if (epoch !== lifecycleEpoch || CaptureBackupService.getSnapshot().ownerId !== ownerId || !CaptureBackupService.getSnapshot().supported) return;
  const timer = setInterval(() => { if (AppState.currentState === 'active') void CaptureBackupService.tick(); }, 5000);
  const network = NetInfo.addEventListener(() => { void CaptureBackupService.tick(); });
  const app = AppState.addEventListener('change', state => { if (state === 'active') void CaptureBackupService.tick(); });
  stopLifecycle = () => { clearInterval(timer); network(); app.remove(); CaptureBackupService.cleanup(); };
}
export function stopCaptureBackupObservers() { lifecycleEpoch++; stopLifecycle?.(); stopLifecycle = undefined; CaptureBackupService.cleanup(); }
export default CaptureBackupService;
