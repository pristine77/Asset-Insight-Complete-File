import type { AuctioneerReportType, AuctioneerWorkItemSetup } from './auctioneerService';
import type { ContinuationDetails } from '../components/forms/continuationDetails';

export type UploadContinuationReservation = {
  id: string; status: 'reserved'; ownerId: string; parentWorkItemId: string;
  parentSessionId: string; parentClientSubmissionId: string; parentCaptureId: string;
  successorWorkItemId: string;
};
export type DurableContinuationIntent = {
  id: string; ownerId: string; type: AuctioneerReportType;
  parentDraftId: string; parentRevision: number; parentCaptureId: string;
  parentClientSubmissionId: string; parentWorkItemId: string;
  parentSetup: AuctioneerWorkItemSetup; details: ContinuationDetails;
  successorDraftId: string; successorCaptureId: string;
  stage: 'prepared' | 'staging' | 'staged' | 'reserved' | 'ready';
  sessionId?: string; reservation?: UploadContinuationReservation; setup?: AuctioneerWorkItemSetup;
  createdAt: string; updatedAt: string;
};
