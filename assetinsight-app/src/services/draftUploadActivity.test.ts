import { draftUploadReason, observeDraftUpload } from './draftUploadActivity';
import store from './offlineCaptureStore';
import type { OfflineReportDraft } from './autoSaveService';
jest.mock('./offlineCaptureStore', () => ({ __esModule: true, default: {getOwnerId:jest.fn(),beginDraftUpload:jest.fn(),updateDraftUpload:jest.fn()} }));
const draft = {ownerId:'a',captureId:'capture-a'} as OfflineReportDraft;
beforeEach(() => {jest.resetAllMocks(); jest.mocked(store.getOwnerId).mockReturnValue('a'); jest.mocked(store.beginDraftUpload).mockResolvedValue(77);});
it.each([
  [{code:'ERR_CANCELED', pauseReason:'connection'}, 'connection_lost'],
  [{code:'ERR_CANCELED', pauseReason:'offline_mode'}, 'offline_mode'],
  [{code:'ERR_CANCELED', request:{}}, 'unknown'],
  [{code:'UPLOAD_STALLED'}, 'no_progress'],
  [{code:'DRAFT_ORIGINAL_UNAVAILABLE'}, 'original_unavailable'],
  [{code:'DRAFT_RECEIPTS_INCOMPLETE'}, 'receipts_incomplete'],
  [{response:{status:503}}, 'server_error'],
  [{response:{status:429}}, 'rate_limited'],
  [{response:{status:401}}, 'authentication_required'],
  [new Error('arbitrary private path'), 'unknown'],
])('classifies only observed causes', (error, expected) => expect(draftUploadReason(error)).toBe(expected));
it('journals the receipt and the original error without converting failure to success',async()=>{
  const error={response:{status:503}};const checkpoint={verified:493,total:1109,cloudId:'cloud'};
  const progress=jest.fn();
  await expect(observeDraftUpload(draft,async report=>{await report(checkpoint);throw error;},progress)).rejects.toBe(error);
  expect(progress).toHaveBeenCalledWith(checkpoint);
  expect(store.updateDraftUpload).toHaveBeenLastCalledWith('a',77,'server_error');
});
it('preserves the transfer result when diagnostics are unavailable',async()=>{
  jest.mocked(store.updateDraftUpload).mockRejectedValue(new Error('database locked'));
  await expect(observeDraftUpload(draft,async report=>{await report({cloudId:'c',verified:1,total:1});return 'ok';})).resolves.toBe('ok');
});
