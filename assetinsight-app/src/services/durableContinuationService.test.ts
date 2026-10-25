import type { DurableContinuationIntent } from './durableContinuationTypes';
import type { OfflineReportDraft } from './autoSaveService';
import type { AuctioneerWorkItemSetup } from './auctioneerService';
import { createUploadOperation } from './uploadCancellation';

let mockOwner: string | null = 'owner';
let mockIntent: DurableContinuationIntent | undefined;
const mockDrafts = new Map<string, any>();
const mockBase = Object.assign(jest.fn(async () => undefined), { prepareFiles: jest.fn(async files => files) });
const mockNative = { handoff: jest.fn(() => mockBase), inspect: jest.fn() };
const mockAuctioneer = { continueUpload: jest.fn() };
const mockStore = {
  getOwnerId: () => mockOwner,
  listContinuations: jest.fn(async () => mockIntent ? [mockIntent] : []),
  getDraft: jest.fn(async id => mockDrafts.get(id)),
  prepareContinuation: jest.fn(async value => { mockIntent = value; return value; }),
  updateContinuation: jest.fn(async (_id, change) => { mockIntent = change(mockIntent!); return mockIntent; }),
  createCloudDraft: jest.fn(async value => { if (mockDrafts.has(value.id)) throw new Error('exists'); mockDrafts.set(value.id, value); return value; }),
};
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID() }));
jest.mock('./offlineCaptureStore', () => ({ __esModule: true, default: mockStore }));
jest.mock('./durableReportTransfer', () => ({ __esModule: true, default: mockNative }));
jest.mock('./auctioneerService', () => ({ ...jest.requireActual('./auctioneerService'), __esModule: true, default: mockAuctioneer }));
jest.mock('./api', () => ({ __esModule: true, default: {} }));
const continuation = require('./durableContinuationService').default as typeof import('./durableContinuationService').default;

const setup: AuctioneerWorkItemSetup = { workItemId: 'parent-work', clientSubmissionId: 'parent-submission', cycleKey: 'cycle', kind: 'unknown',
  reportType: 'asset', status: 'claimed', contract: { id: 'contract', contractNo: '900', eventId: 'event', customerName: '', eventTitle: '', location: '' }, lots: [] };
const parent: OfflineReportDraft = { id: 'parent-draft', ownerId: 'owner', captureId: 'parent-capture', localRevision: 7, type: 'asset', title: '900',
  formData: { clientSubmissionId: 'parent-submission', auctioneerWorkItemId: 'parent-work', auctioneerSnapshot: setup,
    contractNo: '900', ownerName: '', bankPhotosEnabled: false, selectedValuationMethods: ['FML'], supersedesClientSubmissionId: 'not-carried' },
  lots: [{ id: 'parent-lot', mainImages: ['file:///original.jpg'], extraImages: [], videoFiles: [], coverIndex: 0 }], activeLotIdx: 0,
  createdAt: '2026-10-08T10:00:00Z', updatedAt: '2026-10-08T10:00:00Z' };
const row = () => ({ ownerId: 'owner', clientDraftId: parent.id, captureId: parent.captureId, clientSubmissionId: 'parent-submission', revision: 7, sessionId: 'session', type: 'asset', status: 'queued' });
const response = () => ({ reservation: { id: 'reservation', status: 'reserved', ownerId: 'owner', parentWorkItemId: 'parent-work',
  parentSessionId: 'session', parentClientSubmissionId: 'parent-submission', parentCaptureId: 'parent-capture', successorWorkItemId: 'child-work' },
  setup: { ...setup, workItemId: 'child-work', clientSubmissionId: 'child-submission', cycleKey: 'child-cycle' } });
async function stage() {
  const handoff = continuation.handoff(parent, '900', setup), operation = createUploadOperation();
  await handoff.prepareFiles!([], operation);
  await handoff({ session: { sessionId: 'session' } } as any, operation);
  return mockIntent!;
}
beforeEach(() => {
  jest.clearAllMocks(); mockOwner = 'owner'; mockIntent = undefined; mockDrafts.clear(); mockDrafts.set(parent.id, structuredClone(parent));
  mockBase.mockResolvedValue(undefined); mockNative.inspect.mockResolvedValue(row()); mockAuctioneer.continueUpload.mockImplementation(async () => response());
});

it('journals the final parent before native enqueue, saves a separate empty successor before return, and never writes the parent', async () => {
  mockBase.mockImplementationOnce(async () => { expect(mockIntent).toMatchObject({ stage: 'staging', sessionId: 'session', parentRevision: 7 }); });
  const intent = await stage();
  const result = await continuation.complete(intent.id);
  expect(result).toEqual({ draftId: intent.successorDraftId, setup: response().setup });
  const child = mockDrafts.get(intent.successorDraftId);
  expect(child).toMatchObject({ captureId: intent.successorCaptureId, submissionState: 'local', lots: [], formData: {
    ownerName: '', bankPhotosEnabled: false, selectedValuationMethods: ['FML'], clientSubmissionId: 'child-submission', auctioneerWorkItemId: 'child-work',
  } });
  expect(child.formData.supersedesClientSubmissionId).toBeUndefined();
  expect(child.captureId).not.toBe(parent.captureId); expect(child.id).not.toBe(parent.id);
  expect(mockDrafts.get(parent.id)).toEqual(parent); expect(mockIntent!.stage).toBe('ready');
  expect(mockAuctioneer.continueUpload).toHaveBeenCalledWith('parent-work', 'session');
});

it('does not reserve or submit when the durable enqueue never committed', async () => {
  mockBase.mockRejectedValueOnce(new Error('storage failed'));
  await expect(stage()).rejects.toThrow('storage failed');
  mockNative.inspect.mockResolvedValue(undefined);
  expect(await continuation.complete(mockIntent!.id)).toMatchObject({ parentNotStaged: true, draftId: parent.id });
  expect(mockIntent!.stage).toBe('prepared'); expect(mockAuctioneer.continueUpload).not.toHaveBeenCalled();
  expect(mockBase).toHaveBeenCalledTimes(1); expect(mockStore.createCloudDraft).not.toHaveBeenCalled();
});

it('recovers an enqueue acknowledgement loss from the exact native row without submitting again', async () => {
  mockBase.mockRejectedValueOnce(new Error('lost local acknowledgement'));
  await expect(stage()).rejects.toThrow();
  await continuation.complete(mockIntent!.id);
  expect(mockBase).toHaveBeenCalledTimes(1); expect(mockAuctioneer.continueUpload).toHaveBeenCalledTimes(1);
});

it('retains ambiguous staging when native status cannot be read', async () => {
  const intent = await stage(); mockNative.inspect.mockRejectedValueOnce(new Error('status unavailable'));
  await expect(continuation.complete(intent.id)).rejects.toThrow('status unavailable');
  expect(mockIntent!.stage).toBe('staged'); expect(mockAuctioneer.continueUpload).not.toHaveBeenCalled();
});

it('retries a lost reservation response using the same parent session, without upload or token rotation', async () => {
  const intent = await stage(); mockAuctioneer.continueUpload.mockRejectedValueOnce(new Error('lost network response'));
  await expect(continuation.complete(intent.id)).rejects.toThrow();
  await continuation.complete(intent.id);
  expect(mockAuctioneer.continueUpload.mock.calls).toEqual([['parent-work', 'session'], ['parent-work', 'session']]);
  expect(mockBase).toHaveBeenCalledTimes(1); expect(mockStore.createCloudDraft).toHaveBeenCalledTimes(1);
});

it('uses the frozen native identity when parent acceptance advanced its local revision', async () => {
  const intent = await stage(); mockDrafts.set(parent.id, { ...parent, localRevision: 8, submissionState: 'accepted' });
  mockNative.inspect.mockResolvedValue({ ...row(), status: 'accepted' });
  await continuation.complete(intent.id);
  expect(mockDrafts.get(parent.id).localRevision).toBe(8); expect(mockIntent!.parentRevision).toBe(7);
});

it('preserves a previously saved successor including later edits and media on receipt replay', async () => {
  const intent = await stage(); await continuation.complete(intent.id);
  const child = mockDrafts.get(intent.successorDraftId); child.formData.ownerName = 'Child edit'; child.lots = [{ id: 'new-lot', mainImages: ['file:///new.jpg'] }];
  await continuation.complete(intent.id);
  expect(mockStore.createCloudDraft).toHaveBeenCalledTimes(1);
  expect(mockDrafts.get(intent.successorDraftId)).toBe(child);
  expect(child.formData.ownerName).toBe('Child edit'); expect(child.lots[0].mainImages).toEqual(['file:///new.jpg']);
});

it('retains a reserved successor after local creation failure and creates that same draft on retry', async () => {
  const intent = await stage(); mockStore.createCloudDraft.mockRejectedValueOnce(new Error('disk unavailable'));
  await expect(continuation.complete(intent.id)).rejects.toThrow('disk unavailable');
  expect(mockIntent).toMatchObject({ stage: 'reserved', reservation: { id: 'reservation' }, successorDraftId: intent.successorDraftId });
  await continuation.complete(intent.id);
  expect(mockStore.createCloudDraft.mock.calls.map(([value]) => value.id)).toEqual([intent.successorDraftId, intent.successorDraftId]);
});

it('coalesces repeated next-lot taps', async () => {
  const intent = await stage(); let resolve!: (value: any) => void;
  mockAuctioneer.continueUpload.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const first = continuation.complete(intent.id), second = continuation.complete(intent.id); expect(first).toBe(second);
  for (let i = 0; i < 8; i++) await Promise.resolve(); resolve(response()); await Promise.all([first, second]);
  expect(mockAuctioneer.continueUpload).toHaveBeenCalledTimes(1); expect(mockStore.createCloudDraft).toHaveBeenCalledTimes(1);
});

it('does not save or render a successor after an owner change during reservation', async () => {
  const intent = await stage(); mockAuctioneer.continueUpload.mockImplementationOnce(async () => { mockOwner = 'other'; return response(); });
  await expect(continuation.complete(intent.id)).rejects.toThrow('account changed'); expect(mockStore.createCloudDraft).not.toHaveBeenCalled();
});

it.each(['ownerId', 'parentWorkItemId', 'parentSessionId', 'parentClientSubmissionId', 'parentCaptureId', 'successorWorkItemId'])('rejects a foreign reservation %s', async field => {
  const intent = await stage(); const next: any = response(); next.reservation[field] = 'foreign'; mockAuctioneer.continueUpload.mockResolvedValueOnce(next);
  await expect(continuation.complete(intent.id)).rejects.toThrow('different Continue'); expect(mockStore.createCloudDraft).not.toHaveBeenCalled();
});

it('retains a used successor receipt without allocating or seeding another child', async () => {
  const intent = await stage(); mockAuctioneer.continueUpload.mockResolvedValueOnce({ ...response(), setup: { ...response().setup, status: 'report_created', reportId: 'existing-child-report' } });
  await expect(continuation.complete(intent.id)).rejects.toThrow('not a fresh lot');
  expect(mockIntent!.reservation!.successorWorkItemId).toBe('child-work'); expect(mockStore.createCloudDraft).not.toHaveBeenCalled();
});

it('blocks historical parent acceptance instead of treating retained edits as submitted', async () => {
  const intent = await stage(); mockNative.inspect.mockResolvedValue({ ...row(), status: 'needs_attention', receipt: { reusedAcceptance: true } });
  await expect(continuation.complete(intent.id)).rejects.toThrow('earlier report'); expect(mockAuctioneer.continueUpload).not.toHaveBeenCalled();
});
