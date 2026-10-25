import NetInfo from '@react-native-community/netinfo';
import { prepareOfflineSubmission } from './offlineSubmissionService';
import autoSave from './autoSaveService';
import store from './offlineCaptureStore';
import auctioneer from './auctioneerService';
import type { OfflineReportDraft } from './autoSaveService';
jest.mock('@react-native-community/netinfo', () => ({ __esModule: true, default: { fetch: jest.fn() } }));
jest.mock('./autoSaveService', () => ({ __esModule: true, default: { getDraft: jest.fn() } }));
jest.mock('./offlineCaptureStore', () => ({ __esModule: true, default: { getOwnerId: jest.fn(() => 'owner') } }));
jest.mock('./auctioneerService', () => ({ __esModule: true, default: { getSetup: jest.fn() } }));
const draft = { id: 'draft', ownerId: 'owner', type: 'lotListing', formData: { clientSubmissionId: 'same-id' }, lots: [], submissionState: 'local' } as unknown as OfflineReportDraft;
beforeEach(() => { jest.clearAllMocks(); jest.mocked(store.getOwnerId).mockReturnValue('owner'); jest.mocked(NetInfo.fetch).mockResolvedValue({ isConnected: true } as any); jest.mocked(autoSave.getDraft).mockResolvedValue(draft); });
// 2026-10-11: the upload line and an open form now wait for signal on this
// code; the message is only the fallback where nothing waits.
test('offline Submit preserves the draft and tells the person how to resume', async () => {
  jest.mocked(NetInfo.fetch).mockResolvedValue({ isConnected: false } as any);
  await expect(prepareOfflineSubmission(draft)).rejects.toThrow('Saved on this device. Connect to the internet, then tap Resume upload.');
  expect(autoSave.getDraft).not.toHaveBeenCalled();
});
test('no connection is marked so an open report can wait for one', async () => {
  jest.mocked(NetInfo.fetch).mockResolvedValue({ isConnected: false } as any);
  await expect(prepareOfflineSubmission(draft)).rejects.toMatchObject({ code: 'UPLOAD_WAITING_FOR_CONNECTION' });
});
// 2026-10-02: NetInfo's own reachability probe reads false on weak but working
// signal. Only a reported disconnect refuses; the forms then ask our server.
test.each([{ isConnected: true, isInternetReachable: false }, { isConnected: null, isInternetReachable: null }])('does not refuse a connection the probe doubts: %j', async (network) => {
  jest.mocked(NetInfo.fetch).mockResolvedValue(network as any);
  await expect(prepareOfflineSubmission(draft)).resolves.toMatchObject({ id: 'draft' });
});
test('cannot submit another owner or an already accepted upload', async () => {
  await expect(prepareOfflineSubmission({ ...draft, ownerId: 'other' })).rejects.toThrow('owns this draft');
  jest.mocked(autoSave.getDraft).mockResolvedValue({ ...draft, submissionState: 'accepted' });
  await expect(prepareOfflineSubmission(draft)).rejects.toThrow('already accepted');
});
test('missing originals remain counted and block incomplete submission', async () => {
  jest.mocked(autoSave.getDraft).mockResolvedValue({ ...draft, lots: [{ id: 'lot', mainImages: [{ uri: 'content://missing', availability: 'missing' }], extraImages: [], videoFiles: [], coverIndex: 0 }] } as any);
  await expect(prepareOfflineSubmission(draft)).rejects.toThrow('1 original files');
});
test('manual resume retains its submission identity', async () => {
  jest.mocked(autoSave.getDraft).mockResolvedValue({ ...draft, submissionState: 'paused' });
  expect((await prepareOfflineSubmission(draft)).formData.clientSubmissionId).toBe('same-id');
});

const assignedDraft = () => ({ ...draft, submissionState: 'ready',
  formData: { clientSubmissionId: 'same-id', contractNo: '93530', auctioneerWorkItemId: 'work-1' },
  lots: [{ id: 'lot-1', mode: 'single_lot', mainImages: [], extraImages: [], videoFiles: [], coverIndex: 0 }],
} as OfflineReportDraft);
const assignment = () => ({ workItemId: 'work-1', kind: 'unknown', reportType: 'lotListing',
  contract: { id: 'contract-1', contractNo: '93530' }, clientSubmissionId: 'same-id', lots: [], status: 'claimed',
} as any);

test('revalidates an Incoming draft before permitting a same-identity resume', async () => {
  jest.mocked(autoSave.getDraft).mockResolvedValue(assignedDraft());
  jest.mocked(auctioneer.getSetup).mockResolvedValue({ ...assignment(), reportId: 'placeholder', status: 'report_created', canResumeUpload: true });
  expect((await prepareOfflineSubmission(assignedDraft())).formData.clientSubmissionId).toBe('same-id');
  expect(auctioneer.getSetup).toHaveBeenCalledWith('work-1');
});
test('an existing server report after a lost response directs review, not another upload', async () => {
  jest.mocked(autoSave.getDraft).mockResolvedValue(assignedDraft());
  jest.mocked(auctioneer.getSetup).mockResolvedValue({ ...assignment(), reportId: 'existing-report', status: 'report_created', canResumeUpload: false });
  await expect(prepareOfflineSubmission(assignedDraft())).rejects.toThrow('already has a report');
});
test.each([{ clientSubmissionId: 'different-id' }, { contract: { contractNo: 'different-contract' } }, { status: 'abandoned' }])('changed Incoming assignment is not submitted: %j', async (change) => {
  jest.mocked(autoSave.getDraft).mockResolvedValue(assignedDraft());
  jest.mocked(auctioneer.getSetup).mockResolvedValue({ ...assignment(), ...change });
  await expect(prepareOfflineSubmission(assignedDraft())).rejects.toThrow('assignment changed');
});
test('legacy imported metadata without a verified mapping remains review-only', async () => {
  jest.mocked(autoSave.getDraft).mockResolvedValue({ ...draft, formData: { ...draft.formData, legacyRequiresIncomingReview: true } });
  await expect(prepareOfflineSubmission(draft)).rejects.toThrow('assignment verified');
  expect(auctioneer.getSetup).not.toHaveBeenCalled();
});
