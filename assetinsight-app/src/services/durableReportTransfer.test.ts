import { Platform } from 'react-native';
import durable from './durableReportTransfer';
import { createUploadOperation, pauseActiveUploads, setUploadOwner } from './uploadCancellation';
import type { PreparedReportTransfer } from './directR2UploadService';
import type { OfflineReportDraft } from './autoSaveService';

const mockNative = {
  getCapabilities: jest.fn(() => ({ version: 1, durable: true, uidt: true })),
  configure: jest.fn(async () => undefined), deactivate: jest.fn(async () => undefined),
  enqueue: jest.fn(), list: jest.fn(), pause: jest.fn(async () => undefined), resume: jest.fn(async () => undefined), forget: jest.fn(async () => undefined),
};
const mockStore = { getOwnerId: jest.fn(), getDraft: jest.fn(), listContinuations: jest.fn(async () => []), recordTransferAcceptance: jest.fn(async () => undefined) };
const mockApi = { post: jest.fn() };
jest.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => mockNative }));
jest.mock('./offlineCaptureStore', () => ({ __esModule: true, default: mockStore }));
jest.mock('./api', () => ({ __esModule: true, default: mockApi }));
jest.mock('../config/api', () => ({ API_BASE_URL: 'https://api.invalid/api' }));
jest.mock('./deviceAccessStorage', () => ({ getOrCreateDeviceKey: async () => 'installation-proof' }));
jest.mock('./deviceReinstallIdentity', () => ({ getAndroidReinstallId: async () => 'reinstall-proof' }));
jest.mock('./appVersion', () => ({ getAppVersionLabel: () => '1.0.3 (build 29)' }));

const originalPlatform = Platform.OS;
const draft: OfflineReportDraft = {
  ownerId: 'owner', id: 'draft', captureId: 'capture', localRevision: 7, type: 'asset', title: 'Contract',
  formData: { clientSubmissionId: 'submission' }, lots: [{ id: 'lot', mainImages: [{ uri: 'file:///saved/original.jpg', name: 'original.jpg', type: 'image/jpeg' }], extraImages: [], videoFiles: [], coverIndex: 0 }],
  activeLotIdx: 0, createdAt: '2026-10-08T10:00:00Z', updatedAt: '2026-10-08T10:00:00Z',
};
const plan: PreparedReportTransfer = {
  endpoint: '/asset', details: { capture_id: 'capture', client_submission_id: 'submission' },
  session: { sessionId: 'session', jobId: 'submission', files: [] },
  files: [{ fileId: 'images-0', uri: 'file:///cache/original.jpg', name: 'original.jpg', type: 'image/jpeg', size: 123, lotIndex: 0, imageIndex: 0, role: 'main' }],
};
const row = (changes: Record<string, unknown> = {}) => ({ ownerId: 'owner', clientDraftId: 'draft', captureId: 'capture', clientSubmissionId: 'submission',
  revision: 7, sessionId: 'session', type: 'asset', title: 'Contract', status: 'queued', totalFiles: 1, completedFiles: 0, percent: 0, updatedAt: '2026-10-08T10:01:00Z', ...changes });
const grant = (changes: Record<string, unknown> = {}) => ({ token: 'scoped-secret', ownerId: 'owner', type: 'asset', sessionId: 'session', expiresAt: new Date(Date.now() + 3600000).toISOString(), ...changes });
const settle = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
async function bind() { durable.setOwner('owner'); await durable.ready(); }
beforeEach(async () => {
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  jest.useFakeTimers();
  durable.setOwner(null); await settle();
  jest.clearAllMocks();
  mockNative.list.mockResolvedValue([]);
  mockNative.enqueue.mockResolvedValue(row());
  mockStore.getOwnerId.mockReturnValue('owner');
  mockStore.getDraft.mockResolvedValue(draft);
  mockStore.recordTransferAcceptance.mockResolvedValue(undefined);
  mockApi.post.mockResolvedValue({ data: { data: grant() } });
  setUploadOwner('owner');
});
afterEach(async () => { durable.setOwner(null); await settle(); jest.useRealTimers(); });
afterAll(() => Object.defineProperty(Platform, 'OS', { value: originalPlatform, configurable: true }));

it('rehydrates a saved queue without pausing the same owner or automatically resuming a held upload', async () => {
  mockNative.list.mockResolvedValue([row({ status: 'paused', completedFiles: 1, percent: 95 })]);
  await bind();
  expect(mockNative.deactivate).not.toHaveBeenCalled();
  expect(mockNative.configure).toHaveBeenCalledWith({ ownerId: 'owner', apiBaseUrl: 'https://api.invalid/api', headers: expect.objectContaining({
    'X-Device-Key': 'installation-proof', 'X-Device-Reinstall-Id': 'reinstall-proof', 'X-Activity-Source': 'android', 'X-App-Version': '1.0.3 (build 29)',
  }) });
  expect(JSON.stringify(mockNative.configure.mock.calls)).not.toMatch(/Authorization|Bearer|refreshToken/);
  expect(mockNative.resume).not.toHaveBeenCalled();
  expect(durable.getSnapshot().held).toEqual([expect.objectContaining({ draftId: 'draft', status: 'paused', completedFiles: 1, durable: true })]);
  expect(durable.isBusy('draft')).toBe(true);
});

it('stages the exact session using durable saved URIs and does not claim server acceptance', async () => {
  await bind();
  await durable.handoff(draft, 'Contract')(plan, createUploadOperation());
  expect(mockNative.enqueue).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'owner', revision: 7, captureId: 'capture', clientSubmissionId: 'submission', sessionId: 'session',
    files: [expect.objectContaining({ fileId: 'images-0', uri: 'file:///saved/original.jpg', size: 123 })] }));
  expect(mockStore.recordTransferAcceptance).not.toHaveBeenCalled();
  expect(durable.getSnapshot().queued).toHaveLength(1);
});

it('prepares the saved edited rendition for a fresh size read before reserving a server session', async () => {
  await bind();
  mockStore.getDraft.mockResolvedValue({ ...draft, lots: [{ ...draft.lots[0], mainImages: [{ uri: 'file:///saved/original.jpg', editedUri: 'file:///saved/edited.jpg', type: 'image/jpeg', name: 'edited.jpg', size: 900 }] }] });
  const handoff = durable.handoff(draft, 'Contract');
  expect(await handoff.prepareFiles!(plan.files, createUploadOperation())).toEqual([
    expect.objectContaining({ uri: 'file:///saved/edited.jpg', size: undefined, fileId: 'images-0', role: 'main' }),
  ]);
  expect(mockApi.post).not.toHaveBeenCalled();
  expect(mockNative.enqueue).not.toHaveBeenCalled();
});

it('keeps the ordinary per-lot selected-video mapping without changing retained extra originals', async () => {
  await bind();
  const saved = { ...draft, lots: [{ ...draft.lots[0], videoFiles: ['file:///saved/selected.mp4', 'file:///saved/retained.mp4'] }] };
  mockStore.getDraft.mockResolvedValue(saved);
  const files = await durable.handoff(draft, 'Contract').prepareFiles!([
    ...plan.files, { fileId: 'videos-0', uri: 'file:///cache/selected.mp4', name: 'selected.mp4', type: 'video/mp4', size: 700, lotIndex: 0, imageIndex: 0, role: 'video' },
  ], createUploadOperation());
  expect(files[1].uri).toBe('file:///saved/selected.mp4');
  expect(saved.lots[0].videoFiles).toHaveLength(2);
});

it('refuses a later local revision after its file snapshot was prepared', async () => {
  await bind(); const handoff = durable.handoff(draft, 'Contract');
  await handoff.prepareFiles!(plan.files, createUploadOperation());
  mockStore.getDraft.mockResolvedValue({ ...draft, localRevision: 8 });
  await expect(handoff(plan, createUploadOperation())).rejects.toThrow('capture changed');
  expect(mockNative.enqueue).not.toHaveBeenCalled();
});

it('recovers a lost enqueue acknowledgement from the same durable row without enqueueing twice', async () => {
  await bind();
  mockNative.enqueue.mockRejectedValueOnce(new Error('lost local response'));
  mockNative.list.mockResolvedValue([row()]);
  await durable.handoff(draft, 'Contract')(plan, createUploadOperation());
  expect(mockNative.enqueue).toHaveBeenCalledTimes(1);
  expect(durable.getSnapshot().queued[0].draftId).toBe('draft');
});

it.each([{ ownerId: 'other' }, { sessionId: 'other' }, { type: 'lotListing' }, { expiresAt: '2001-01-01T00:00:00Z' }])('rejects wrong or expired grants: %j', async mismatch => {
  await bind(); mockApi.post.mockResolvedValueOnce({ data: { data: grant(mismatch) } });
  await expect(durable.handoff(draft, 'Contract')(plan, createUploadOperation())).rejects.toThrow('authorization');
  expect(mockNative.enqueue).not.toHaveBeenCalled();
});

it('does not enqueue after the account changes while a grant is pending', async () => {
  await bind(); let resolve!: (value: any) => void;
  mockApi.post.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const pending = durable.handoff(draft, 'Contract')(plan, createUploadOperation());
  await settle(); durable.setOwner(null); mockStore.getOwnerId.mockReturnValue(null);
  resolve({ data: { data: grant() } });
  await expect(pending).rejects.toThrow('account changed');
  expect(mockNative.enqueue).not.toHaveBeenCalled();
  expect(durable.getSnapshot().queued).toEqual([]);
});

it('only records validated exact acceptance with the frozen draft revision', async () => {
  mockNative.list.mockResolvedValue([row({ status: 'accepted', reportId: 'report', completedFiles: 1, percent: 100,
    receipt: { accepted: true, reportAvailable: true, ownerId: 'owner', type: 'asset', sessionId: 'session', reportId: 'report', jobId: 'submission' } })]);
  await bind();
  expect(mockStore.recordTransferAcceptance).toHaveBeenCalledWith('draft', 7, 'capture', 'submission', 'report');
  expect(durable.getSnapshot().notices[0].kind).toBe('sent');
});

it('keeps an edited draft when the acceptance compare-and-set refuses it', async () => {
  mockNative.list.mockResolvedValue([row({ status: 'accepted', completedFiles: 1, percent: 100,
    receipt: { accepted: true, reportAvailable: true, ownerId: 'owner', type: 'asset', sessionId: 'session', reportId: 'report', jobId: 'submission' } })]);
  mockStore.recordTransferAcceptance.mockRejectedValueOnce(new Error('This draft changed after the upload was saved.'));
  await bind();
  expect(durable.getSnapshot().notices[0]).toMatchObject({ kind: 'attention', message: expect.stringContaining('draft changed') });
  // The transfer is finished, so the kept draft can be opened for review (2026-10-11:
  // holding it left the draft unopenable for good). A re-submit gets the server's
  // "earlier report accepted" answer, which the forms already handle.
  expect(durable.isBusy('draft')).toBe(false);
});

it('opens the kept draft of an accepted upload this phone could not record, without asking Android to forget it', async () => {
  mockNative.list.mockResolvedValue([row({ status: 'accepted', completedFiles: 1, percent: 100,
    receipt: { accepted: true, reportAvailable: true, ownerId: 'owner', type: 'asset', sessionId: 'session', reportId: 'report', jobId: 'submission' } })]);
  mockStore.recordTransferAcceptance.mockRejectedValueOnce(new Error('This draft changed after the upload was saved.'));
  await bind();
  // Android's own record says accepted, so forget would be refused with a raw native error.
  await expect(durable.releaseForEditing('draft')).resolves.toBeUndefined();
  expect(mockNative.forget).not.toHaveBeenCalled();
  // Nothing is left to send: the draft is not held, and Resume is not offered.
  expect(durable.isBusy('draft')).toBe(false);
  expect(durable.getSnapshot().notices[0]).toMatchObject({ kind: 'attention', canResume: false });
  expect(durable.getSnapshot().held[0]).toMatchObject({ status: 'attention', canResume: false });
});

it('requires native stopped-upload release before it lets the editor reopen', async () => {
  mockNative.list.mockResolvedValue([row({ status: 'paused' })]); await bind();
  mockNative.forget.mockImplementationOnce(async () => { mockNative.list.mockResolvedValue([]); });
  await durable.releaseForEditing('draft');
  expect(mockNative.forget).toHaveBeenCalledWith('owner', 'draft');
  expect(durable.isBusy('draft')).toBe(false);
});

it('does not forget a paused parent bound to a durable Continue request', async () => {
  mockNative.list.mockResolvedValue([row({ status: 'paused' })]); await bind();
  mockStore.listContinuations.mockResolvedValueOnce([{ parentDraftId: 'draft', stage: 'staged' }] as never[]);
  await expect(durable.releaseForEditing('draft')).rejects.toThrow('Continue');
  expect(mockNative.forget).not.toHaveBeenCalled();
});

it('coalesces repeated Resume taps into one rotating grant and one native resume', async () => {
  mockNative.list.mockResolvedValue([row({ status: 'paused' })]); await bind();
  let authorize!: (value: any) => void;
  mockApi.post.mockImplementationOnce(() => new Promise(resolve => { authorize = resolve; }));
  const first = durable.resume('durable:draft');
  const second = durable.resume('durable:draft');
  expect(first).toBe(second);
  await settle();
  expect(mockApi.post).toHaveBeenCalledTimes(1);
  authorize({ data: { data: grant() } });
  await Promise.all([first, second]);
  expect(mockNative.resume).toHaveBeenCalledTimes(1);
});

it('does not rotate authorization or reschedule an already-running native upload', async () => {
  mockNative.list.mockResolvedValue([row({ status: 'uploading' })]); await bind();
  await durable.resume('durable:draft');
  expect(mockApi.post).not.toHaveBeenCalled();
  expect(mockNative.resume).not.toHaveBeenCalled();
});

it('leaves temporary connection recovery with Android while honoring explicit Offline pauses', async () => {
  mockNative.list.mockResolvedValue([row({ status: 'uploading' })]); await bind();
  pauseActiveUploads('connection'); await settle();
  expect(mockNative.pause).not.toHaveBeenCalled();
  pauseActiveUploads(); await settle();
  expect(mockNative.pause).toHaveBeenCalledWith('owner', 'draft');
});

it('leaves React cleanup alone and revokes native authority on logout without reporting a user pause', async () => {
  mockNative.list.mockResolvedValue([row({ status: 'uploading' })]); await bind();
  pauseActiveUploads(undefined, 'lifecycle'); await settle();
  expect(mockNative.pause).not.toHaveBeenCalled();
  expect(mockNative.deactivate).not.toHaveBeenCalled();
  durable.setOwner(null); await durable.ready();
  expect(mockNative.deactivate).toHaveBeenCalledTimes(1);
  expect(mockNative.pause).not.toHaveBeenCalled();
});

it('rejects another owner’s restored row rather than displaying or resuming it', async () => {
  mockNative.list.mockResolvedValue([row({ ownerId: 'another-owner' })]);
  durable.setOwner('owner');
  await expect(durable.ready()).rejects.toThrow('could not be verified');
  expect(durable.getSnapshot()).toEqual({ active: null, queued: [], held: [], notices: [] });
  expect(durable.isBusy('draft')).toBe(true);
});
