import NetInfo from '@react-native-community/netinfo';
import AutoSaveService, { OfflineReportDraft } from './autoSaveService';
import OfflineCaptureStore from './offlineCaptureStore';
import auctioneerService from './auctioneerService';
import { hasValidAuctioneerLotStructure } from '../components/forms/auctioneerFormPolicy';
import { UPLOAD_WAITING_FOR_CONNECTION } from './uploadResumePolicy';

/**
 * Checks a saved draft before each upload attempt. Nothing here waits or
 * schedules: the upload line and the open forms wait for signal themselves
 * (uploadAutoResume.ts, backgroundUploadManager.ts).
 */
export async function prepareOfflineSubmission(draft: OfflineReportDraft) {
  const owner = OfflineCaptureStore.getOwnerId();
  if (!owner || draft.ownerId !== owner) throw new Error('Sign in to the account that owns this draft.');
  // Only a reported disconnect refuses here (2026-10-02). NetInfo's
  // isInternetReachable is its own probe of a public URL and reads false on weak
  // but working signal, which refused uploads that would have gone through; the
  // forms check our own server right after this. The code lets the upload line
  // and an open form wait for signal and continue by themselves (2026-10-11);
  // the message shows only where nothing is waiting.
  const network = await NetInfo.fetch();
  if (network.isConnected === false) {
    throw Object.assign(new Error('Saved on this device. Connect to the internet, then tap Resume upload.'), { code: UPLOAD_WAITING_FOR_CONNECTION });
  }
  const current = await AutoSaveService.getDraft(draft.id);
  if (!current) throw new Error('This draft is unavailable. Reopen Drafts before submitting.');
  if (current.formData.legacyRequiresIncomingReview) throw new Error('This recovered draft needs its original Incoming assignment verified. Reopen Incoming before submitting; the local photos remain safe.');
  if (current.submissionState === 'accepted' || current.submissionState === 'submitted') {
    throw new Error('This upload was already accepted. Open Previews to review its processing status.');
  }
  const missing = current.lots.flatMap((lot) => [...lot.mainImages, ...lot.extraImages, ...(lot.videoFiles || [])])
    .filter((photo) => typeof photo !== 'string' && photo.availability === 'missing');
  if (missing.length) throw new Error(`${missing.length} original files are unavailable. Restore or replace them in the draft before submitting.`);
  const workItemId = current.formData.auctioneerWorkItemId;
  if (workItemId) {
    const setup = await auctioneerService.getSetup(workItemId);
    if (setup.reportType !== current.type || setup.contract.contractNo !== current.formData.contractNo ||
        setup.clientSubmissionId !== current.formData.clientSubmissionId ||
        !hasValidAuctioneerLotStructure(setup, current.lots.map((lot) => ({ id: lot.id, mode: lot.mode, files: [], extraFiles: [], coverIndex: 0 }))) ||
        ['sent', 'abandoned'].includes(setup.status || '')) {
      throw new Error('This Incoming assignment changed. Your local photos are safe; reopen Incoming and review the assignment before submitting.');
    }
    if (setup.reportId && !setup.canResumeUpload) {
      throw new Error('This Incoming assignment already has a report. Open Incoming or Previews to review that report; your saved photos remain on this device. Do not start a new upload for it.');
    }
  }
  if (OfflineCaptureStore.getOwnerId() !== owner) throw new Error('The signed-in account changed. Reopen this draft.');
  return current;
}
