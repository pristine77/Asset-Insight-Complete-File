import { AppState, Dimensions, Platform } from 'react-native';
import type { OfflineReportDraft } from './autoSaveService';
import type { DirectUploadFile, PreparedReportTransfer, ReportTransferHandoff } from './directR2UploadService';
import type { BackgroundUploadAccepted, BackgroundUploadEntry, BackgroundUploadNotice, BackgroundUploadSnapshot } from './backgroundUploadManager';
import { assertReportUploadAccepted, isExistingReportUploadReceipt } from './reportUploadReceipt';
import { cancellableUploadRequest, onUploadsPaused } from './uploadCancellation';
import { getPhotoUploadUri } from '../utils/photoFileUtils';

type TransferState = {
  ownerId: string; clientDraftId: string; captureId: string; clientSubmissionId: string; revision: number; sessionId: string; canPause?: boolean;
  type: 'asset' | 'lotListing'; title?: string;
  status: 'queued' | 'uploading' | 'paused' | 'waiting_network' | 'interrupted' | 'auth_required' | 'needs_attention' | 'accepted';
  completedFiles: number; totalFiles: number; percent: number; reportId?: string; message?: string; updatedAt: string;
  receipt?: Record<string, unknown>;
  /** Set here, never by Android: the server accepted it but this phone could not record that. */
  acceptedOnServer?: boolean;
};
type TransferGrant = { token: string; expiresAt: string; ownerId: string; sessionId: string; type: 'asset' | 'lotListing' };
type NativeTransfer = {
  getCapabilities(): { version: number; durable: boolean; uidt: boolean };
  configure(options: { ownerId: string; apiBaseUrl: string; headers?: Record<string, string> }): Promise<void>;
  enqueue(options: Record<string, unknown>): Promise<TransferState>;
  list(ownerId: string): Promise<TransferState[]>;
  pause(ownerId: string, draftId: string): Promise<unknown>;
  resume(ownerId: string, draftId: string, grant?: TransferGrant): Promise<unknown>;
  forget?(ownerId: string, draftId: string): Promise<unknown>;
  deactivate(): Promise<void>;
};

// Status imports remain cheap, and older binaries/iOS keep their honest existing path.
let native: NativeTransfer | null | undefined;
function bridge(): NativeTransfer | null {
  if (native !== undefined) return native;
  native = null;
  if (Platform.OS !== 'android') return native;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const candidate = require('expo-modules-core').requireOptionalNativeModule('ReportTransfer') as NativeTransfer | null;
    if (candidate?.getCapabilities().durable) native = candidate;
  } catch { /* The installed binary predates durable report transfers. */ }
  return native;
}
// Lazy imports avoid loading authenticated storage/network modules for a status bar.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const store = (): typeof import('./offlineCaptureStore').default => require('./offlineCaptureStore').default;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const api = (): typeof import('./api').default => require('./api').default;

let owner: string | null = null;
let generation = 0;
let states: TransferState[] = [];
let hydrating = false;
let hydration: Promise<void> = Promise.resolve();
let binding: Promise<void> = Promise.resolve();
let poll: ReturnType<typeof setInterval> | undefined;
let refreshing = false;
let initialized = false;
const listeners = new Set<() => void>();
const acceptedListeners = new Set<(event: BackgroundUploadAccepted) => void>();
const accepted = new Set<string>();
const dismissed = new Set<string>();
const resumeFlights = new Map<string, Promise<void>>();
let snapshot: BackgroundUploadSnapshot = { active: null, queued: [], held: [], notices: [] };
const idOf = (state: TransferState) => `durable:${state.clientDraftId}`;
const noticeId = (state: TransferState) => `${idOf(state)}:${state.status}:${state.updatedAt}`;
const isRunning = (state: TransferState) => ['queued', 'uploading', 'waiting_network', 'interrupted'].includes(state.status);

function entry(state: TransferState): BackgroundUploadEntry {
  const status = state.status === 'queued' ? 'queued' : state.status === 'uploading' ? 'uploading'
    : ['waiting_network', 'interrupted'].includes(state.status) ? 'waiting' : state.status === 'needs_attention' || state.status === 'auth_required' ? 'attention' : 'paused';
  return { id: idOf(state), draftId: state.clientDraftId, type: state.type, title: state.title || 'Report upload',
    status, percent: state.percent, completedFiles: state.completedFiles, totalFiles: state.totalFiles,
    stage: state.status === 'uploading' ? state.canPause === false ? 'finalizing' : 'uploading' : undefined, pausing: false,
    canPause: isRunning(state) && state.canPause !== false, canResume: !state.acceptedOnServer, message: state.message, durable: true };
}
function publish() {
  const entries = states.filter(state => state.status !== 'accepted').map(entry);
  const active = entries.find(item => item.status === 'uploading' || item.status === 'waiting') || null;
  const notices: BackgroundUploadNotice[] = states.filter(state => ['accepted', 'needs_attention', 'auth_required'].includes(state.status))
    .filter(state => !dismissed.has(noticeId(state))).map(state => ({
      id: noticeId(state), kind: state.status === 'accepted' ? 'sent' : 'attention', jobId: idOf(state), draftId: state.clientDraftId,
      type: state.type, title: state.title || 'Report upload', heading: state.status === 'accepted' ? 'Upload accepted' : 'Upload needs attention',
      message: state.status === 'accepted' ? 'The server accepted this report. Processing continues on the server.'
        : state.message || 'Your originals are kept. Review this upload before resuming.', reportId: state.reportId, autoDismiss: false, canResume: !state.acceptedOnServer,
    }));
  snapshot = { active, queued: entries.filter(item => item !== active && ['queued', 'uploading', 'waiting'].includes(item.status)),
    held: entries.filter(item => ['paused', 'attention'].includes(item.status)), notices };
  listeners.forEach(listener => listener());
}
function validState(state: TransferState): boolean {
  return !!state && typeof state.clientDraftId === 'string' && !!state.clientDraftId && typeof state.sessionId === 'string'
    && !!state.sessionId && state.ownerId === owner && typeof state.captureId === 'string' && !!state.captureId
    && typeof state.clientSubmissionId === 'string' && !!state.clientSubmissionId && ['asset', 'lotListing'].includes(state.type)
    && ['queued', 'uploading', 'paused', 'waiting_network', 'interrupted', 'auth_required', 'needs_attention', 'accepted'].includes(state.status)
    && typeof state.updatedAt === 'string' && Number.isFinite(Date.parse(state.updatedAt))
    && [state.completedFiles, state.totalFiles, state.revision].every(n => Number.isSafeInteger(n) && n >= 0)
    && state.completedFiles <= state.totalFiles && Number.isFinite(state.percent) && state.percent >= 0 && state.percent <= 100;
}
async function reconcileAccepted(state: TransferState, expected: string, epoch: number) {
  const key = `${state.sessionId}:${state.updatedAt}`;
  if (accepted.has(key)) return;
  try {
    assertReportUploadAccepted(state.receipt);
    if (state.receipt.accepted !== true || state.receipt.reportAvailable !== true || state.receipt.ownerId !== expected ||
        state.receipt.sessionId !== state.sessionId || state.receipt.type !== state.type || isExistingReportUploadReceipt(state.receipt)) {
      throw new Error('The server returned an earlier or unconfirmed report. Your draft and originals are kept for review.');
    }
    if (owner !== expected || generation !== epoch) return;
    const previous = await store().getDraft(state.clientDraftId);
    if (owner !== expected || generation !== epoch) return;
    const wasRecorded = ['accepted', 'submitted'].includes(previous?.submissionState || '') && previous?.reportId === state.receipt.reportId;
    // Accepted metadata hides the draft; the inventory/originals remain retained.
    await store().recordTransferAcceptance(state.clientDraftId, state.revision, state.captureId, state.clientSubmissionId, state.receipt.reportId);
    if (owner === expected && generation === epoch) {
      accepted.add(key);
      if (wasRecorded) dismissed.add(noticeId(state));
      else acceptedListeners.forEach(listener => listener({ draftId: state.clientDraftId, type: state.type, reportId: state.receipt!.reportId as string }));
    }
  } catch (error) {
    // Android's record still says accepted; only this phone's view changes.
    state.acceptedOnServer = true;
    state.status = 'needs_attention';
    state.message = error instanceof Error ? error.message : 'Local acceptance could not be recorded. Check Previews before resuming.';
  }
}
async function refresh() {
  const expected = owner, epoch = generation, module = bridge();
  if (!expected || !module || refreshing) return;
  refreshing = true;
  try {
    const rows = await module.list(expected);
    if (expected !== owner || epoch !== generation) return;
    if (!Array.isArray(rows) || rows.some(row => !validState(row))) throw new Error('Upload status could not be verified.');
    for (const state of rows) if (state.status === 'accepted') await reconcileAccepted(state, expected, epoch);
    if (expected !== owner || epoch !== generation) return;
    states = rows;
    hydrating = false;
    publish();
  } finally { if (epoch === generation) refreshing = false; }
}
function startPolling() {
  if (poll) clearInterval(poll);
  if (!owner || !bridge() || AppState.currentState === 'background') return;
  poll = setInterval(() => { void refresh().catch(() => undefined); }, 2_000);
}
function initialize() {
  if (initialized || !bridge()) return;
  initialized = true;
  AppState.addEventListener('change', state => {
    if (state === 'active') { void hydration.then(refresh).catch(() => undefined); startPolling(); }
    else if (poll) { clearInterval(poll); poll = undefined; }
  });
  onUploadsPaused((reason, source) => {
    // The explicit saved native transfer owns transient network recovery.
    // Native owner binding revokes account authority; React teardown must not
    // masquerade as a user pause or stop an independently scheduled transfer.
    if (reason === 'connection' || source === 'lifecycle') return;
    const expected = owner;
    if (!expected) return;
    states.filter(isRunning).forEach(state => { void bridge()?.pause(expected, state.clientDraftId).then(refresh).catch(() => undefined); });
  });
}

export const durableReportTransfer = {
  available: () => !!bridge(),
  getSnapshot: () => snapshot,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  onAccepted(listener: (event: BackgroundUploadAccepted) => void) { acceptedListeners.add(listener); return () => { acceptedListeners.delete(listener); }; },
  setOwner(next: string | null) {
    const previousOwner = owner;
    const unchanged = owner === next;
    if (unchanged && !next) return;
    if (!unchanged) {
      owner = next; generation += 1;
      states = []; accepted.clear(); dismissed.clear(); resumeFlights.clear(); refreshing = false; hydrating = !!next && !!bridge(); publish();
    }
    const epoch = generation;
    if (poll) { clearInterval(poll); poll = undefined; }
    if (!bridge()) return;
    initialize();
    // Serialize native owner changes; a slow previous configure cannot restore old authority.
    binding = binding.catch(() => undefined).then(async () => {
      if (epoch !== generation) return;
      if (!next) { await bridge()!.deactivate(); return; }
      if (previousOwner && previousOwner !== next) await bridge()!.deactivate();
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { API_BASE_URL } = require('../config/api');
      // Device proof stays separate from this session's scoped transfer grant;
      // the native scheduler never receives the main access/refresh token.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getOrCreateDeviceKey } = require('./deviceAccessStorage');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getAndroidReinstallId } = require('./deviceReinstallIdentity');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getAppVersionLabel } = require('./appVersion');
      const [deviceKey, reinstallId] = await Promise.all([getOrCreateDeviceKey(), getAndroidReinstallId()]);
      if (epoch !== generation || owner !== next) return;
      if (!deviceKey) throw new Error('This device must sign in again before uploads can continue.');
      const screen = Dimensions.get('screen');
      await bridge()!.configure({ ownerId: next, apiBaseUrl: API_BASE_URL, headers: {
        'X-Device-Key': deviceKey, ...(reinstallId ? { 'X-Device-Reinstall-Id': reinstallId } : {}),
        'X-Device-Platform': 'android', 'X-Activity-Source': 'android', 'X-App-Version': getAppVersionLabel() || 'unknown',
        'X-Device-Form-Factor': Math.min(screen.width, screen.height) >= 600 ? 'tablet' : 'mobile',
      } });
    });
    hydration = binding.then(async () => { if (epoch === generation && next) { try { await refresh(); } finally { startPolling(); } } });
    void hydration.catch(() => undefined); // Hydration failure keeps drafts locked until a verified refresh.
  },
  async ready() {
    try { await hydration; } catch { await binding; await refresh(); }
    if (hydrating) throw new Error('Upload status is still being checked. Retry in a moment.');
  },
  // An upload the server accepted (even one this phone could not record) no longer holds its draft.
  isBusy(draftId: string) { return hydrating || states.some(state => state.clientDraftId === draftId && state.status !== 'accepted' && !state.acceptedOnServer); },
  statusFor(draftId: string) { const state = states.find(row => row.clientDraftId === draftId && row.status !== 'accepted'); return state ? entry(state) : undefined; },
  async inspect(draftId: string): Promise<TransferState | undefined> {
    await this.ready();
    const expected = owner, epoch = generation;
    if (!expected || !bridge()) return undefined;
    const rows = await bridge()!.list(expected);
    if (owner !== expected || epoch !== generation) throw new Error('The signed-in account changed.');
    if (!Array.isArray(rows) || rows.some(row => !validState(row))) throw new Error('Upload status could not be verified.');
    return rows.find(row => row.clientDraftId === draftId);
  },
  async pause(id: string) { const state = states.find(row => idOf(row) === id); if (!owner || !state) return; await bridge()!.pause(owner, state.clientDraftId); await refresh(); },
  resume(id: string): Promise<void> {
    const expected = owner, epoch = generation, key = `${epoch}:${id}`;
    const pending = resumeFlights.get(key);
    if (pending) return pending;
    // Grant issuance rotates its token. Two taps must share one request, or a
    // slower first response could replace the newer valid native grant.
    let flight: Promise<void>;
    flight = (async () => {
      await this.ready();
      if (owner !== expected || generation !== epoch) return;
      const state = states.find(row => idOf(row) === id);
      if (!state || !expected || state.status === 'accepted' || isRunning(state)) return;
      const response = await api().post('/report-transfers/grant', { type: state.type, sessionId: state.sessionId });
      if (owner !== expected || generation !== epoch) return;
      const grant = validateGrant(response.data.data, expected, state.sessionId, state.type);
      await bridge()!.resume(expected, state.clientDraftId, grant);
      await refresh();
    })().finally(() => { if (resumeFlights.get(key) === flight) resumeFlights.delete(key); });
    resumeFlights.set(key, flight);
    return flight;
  },
  dismiss(id: string) { dismissed.add(id); publish(); },
  /** Explicitly release a stopped immutable upload before the editor can change it. */
  async releaseForEditing(draftId: string) {
    await this.ready();
    const continuation = (await store().listContinuations()).find(row => row.parentDraftId === draftId && row.stage !== 'prepared');
    if (continuation) throw new Error('This parent was queued with Continue. Use Pause or Resume for its upload, and open the independent next lot from Drafts.');
    const state = states.find(row => row.clientDraftId === draftId), expected = owner, epoch = generation;
    if (!state) return;
    // The transfer is finished (accepted on the server) and its draft is kept:
    // there is nothing to release, so Open just opens the draft. Asking Android
    // to forget it showed a raw "ReportTransfer.forget has been rejected" error.
    if (state.acceptedOnServer) return;
    if (resumeFlights.has(`${epoch}:${idOf(state)}`)) throw new Error('This upload is resuming. Wait for its status, then pause it before editing.');
    if (isRunning(state) || state.status === 'accepted' || !expected || !bridge()?.forget) throw new Error('Pause this upload before opening its saved draft.');
    await bridge()!.forget!(expected, draftId);
    if (owner !== expected || generation !== epoch) throw new Error('The signed-in account changed.');
    await refresh();
  },
  handoff(draft: OfflineReportDraft, title: string): ReportTransferHandoff {
    const expected = draft.ownerId, epoch = generation;
    let preparedDraft: OfflineReportDraft | null = null;
    const handoff: ReportTransferHandoff = async (prepared: PreparedReportTransfer, operation) => {
      await this.ready(); operation.assertActive();
      if (!expected || owner !== expected || generation !== epoch || store().getOwnerId() !== expected) throw new Error('The signed-in account changed. Your draft remains saved.');
      const response = await cancellableUploadRequest(operation, signal => api().post('/report-transfers/grant',
        { type: draft.type, sessionId: prepared.session.sessionId }, { signal, timeout: 30_000 }));
      operation.assertActive();
      const grant = validateGrant(response.data.data, expected, prepared.session.sessionId, draft.type);
      if (owner !== expected || generation !== epoch) throw new Error('The signed-in account changed.');
      const frozenDraft = await store().getDraft(draft.id);
      operation.assertActive();
      if (!frozenDraft || !frozenDraft.captureId || frozenDraft.captureId !== draft.captureId ||
          !frozenDraft.formData.clientSubmissionId || frozenDraft.formData.clientSubmissionId !== prepared.details.client_submission_id ||
          frozenDraft.ownerId !== expected || !Number.isSafeInteger(frozenDraft.localRevision) ||
          (preparedDraft && preparedDraft.localRevision !== frozenDraft.localRevision)) throw new Error('The saved capture changed before upload handoff. Keep this draft and retry.');
      // Enqueue resolves only after the native database commits this exact manifest.
      // Do not cancel the acknowledgement wait: an uncertain local handoff is
      // recovered by list(), never by starting a second transport.
      const files = savedTransferFiles(prepared.files, frozenDraft);
      let staged: TransferState;
      try { staged = await bridge()!.enqueue({ ownerId: expected, clientDraftId: draft.id, revision: frozenDraft.localRevision,
        captureId: frozenDraft.captureId, clientSubmissionId: frozenDraft.formData.clientSubmissionId,
        type: draft.type, sessionId: prepared.session.sessionId, title, grant, files }); }
      catch (error) {
        // A lost local acknowledgement may follow a committed native queue row.
        // Read it back; never start an alternate uploader over an uncertain handoff.
        if (owner !== expected || generation !== epoch) throw error;
        const retained = (await bridge()!.list(expected)).find(row => validState(row) && row.clientDraftId === draft.id && row.sessionId === prepared.session.sessionId);
        if (!retained) throw error;
        staged = retained;
      }
      if (owner !== expected || generation !== epoch) throw new Error('The signed-in account changed.');
      if (!operation.isActive()) { await bridge()!.pause(expected, draft.id); await refresh(); operation.assertActive(); }
      if (!validState(staged) || staged.clientDraftId !== draft.id || staged.sessionId !== prepared.session.sessionId || staged.type !== draft.type ||
          staged.captureId !== frozenDraft.captureId || staged.clientSubmissionId !== frozenDraft.formData.clientSubmissionId ||
          staged.revision !== frozenDraft.localRevision || staged.totalFiles !== files.length) throw new Error('The saved upload acknowledgement could not be verified. Reopen Drafts to check the same upload.');
      states = [...states.filter(row => row.clientDraftId !== draft.id), staged]; publish(); startPolling();
    };
    handoff.prepareFiles = async (files, operation) => {
      await this.ready(); operation.assertActive();
      if (!expected || owner !== expected || generation !== epoch) throw new Error('The signed-in account changed.');
      const current = await store().getDraft(draft.id);
      operation.assertActive();
      if (!current || current.ownerId !== expected || current.captureId !== draft.captureId ||
          current.formData.clientSubmissionId !== draft.formData.clientSubmissionId || !Number.isSafeInteger(current.localRevision)) {
        throw new Error('The saved capture changed before upload preparation. Keep this draft and retry.');
      }
      preparedDraft = current;
      // A saved edited rendition may differ in size from its original. Re-read
      // every exact persisted source before freezing the server manifest.
      return savedTransferFiles(files, current).map(file => ({ ...file, size: undefined }));
    };
    return handoff;
  },
};
export default durableReportTransfer;

function savedTransferFiles<T extends DirectUploadFile>(files: T[], draft: OfflineReportDraft): T[] {
  // The ordinary Asset/Lot service submits the selected first video per lot.
  const total = draft.lots.reduce((count, lot) => count + lot.mainImages.length + lot.extraImages.length + (lot.videoFiles?.length ? 1 : 0), 0);
  if (files.length !== total) throw new Error('The saved media no longer matches this upload. Reopen the draft before submitting.');
  return files.map(file => {
    const lot = draft.lots[file.lotIndex ?? -1];
    const saved = file.role === 'video' ? lot?.videoFiles?.[0]
      : file.role === 'extra' ? lot?.extraImages[file.imageIndex ?? -1] : lot?.mainImages[file.imageIndex ?? -1];
    if (!saved || (typeof saved !== 'string' && saved.availability === 'missing')) throw new Error('A saved original is unavailable. Keep this draft and review its photos.');
    const uri = typeof saved === 'string' ? saved : file.role === 'video' ? saved.uri : getPhotoUploadUri(saved);
    if (!/^(file|content):\/\//.test(uri)) throw new Error('This upload needs local originals on this device. Keep the draft and restore its files before submitting.');
    return { ...file, uri };
  });
}

function validateGrant(value: any, ownerId: string, sessionId: string, type: string): TransferGrant {
  if (!value || value.ownerId !== ownerId || value.sessionId !== sessionId || value.type !== type ||
      typeof value.token !== 'string' || !value.token || typeof value.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) {
    throw new Error('Upload authorization could not be verified. Your draft remains saved.');
  }
  return value;
}
