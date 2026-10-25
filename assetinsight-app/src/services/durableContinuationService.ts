import { randomUUID } from 'expo-crypto';
import OfflineCaptureStore from './offlineCaptureStore';
import durableReportTransfer from './durableReportTransfer';
import auctioneerService, { validateAuctioneerSuccessor, type AuctioneerWorkItemSetup } from './auctioneerService';
import type { OfflineReportDraft } from './autoSaveService';
import type { ReportTransferHandoff } from './directR2UploadService';
import { captureContinuationDetails } from '../components/forms/continuationDetails';
import type { DurableContinuationIntent } from './durableContinuationTypes';

export type ContinuationResult = { draftId: string; setup: AuctioneerWorkItemSetup } | { parentNotStaged: true; draftId: string; setup: AuctioneerWorkItemSetup };
const flights = new Map<string, Promise<ContinuationResult>>();
const assertOwner = (expected: string) => { if (OfflineCaptureStore.getOwnerId() !== expected) throw new Error('The signed-in account changed.'); };
const read = async (id: string) => {
  const intent = (await OfflineCaptureStore.listContinuations()).find(row => row.id === id);
  if (!intent) throw new Error('This saved Continue request is unavailable.');
  return intent;
};
const exactParent = (intent: DurableContinuationIntent, row: NonNullable<Awaited<ReturnType<typeof durableReportTransfer.inspect>>>) =>
  row.ownerId === intent.ownerId && row.clientDraftId === intent.parentDraftId && row.captureId === intent.parentCaptureId &&
  row.clientSubmissionId === intent.parentClientSubmissionId && row.revision === intent.parentRevision && row.sessionId === intent.sessionId && row.type === intent.type;

/** Continuation metadata never writes the frozen parent's revision or media. */
const durableContinuationService = {
  list: () => OfflineCaptureStore.listContinuations(),
  async forParent(draftId: string) { return (await this.list()).find(row => row.parentDraftId === draftId); },
  async successorDraft(workItemId: string) {
    const intent = (await this.list()).find(row => row.setup?.workItemId === workItemId);
    if (!intent) return undefined;
    const draft = await OfflineCaptureStore.getDraft(intent.successorDraftId);
    return draft?.captureId === intent.successorCaptureId && draft.formData.auctioneerWorkItemId === workItemId ? draft.id : undefined;
  },
  handoff(draft: OfflineReportDraft, title: string, setup: AuctioneerWorkItemSetup): ReportTransferHandoff {
    const base = durableReportTransfer.handoff(draft, title);
    let intent: DurableContinuationIntent | undefined;
    const handoff: ReportTransferHandoff = async (prepared, operation) => {
      if (!intent) throw new Error('Save the Continue request before queuing its upload.');
      operation.assertActive(); assertOwner(intent.ownerId);
      intent = await OfflineCaptureStore.updateContinuation(intent.id, current => ({ ...current, sessionId: prepared.session.sessionId, stage: 'staging' }));
      operation.assertActive();
      await base(prepared, operation);
      assertOwner(intent.ownerId);
      const row = await durableReportTransfer.inspect(intent.parentDraftId);
      if (!row || !exactParent(intent, row)) throw new Error('The parent upload could not be confirmed. Retry this Continue request from Drafts.');
      intent = await OfflineCaptureStore.updateContinuation(intent.id, current => ({ ...current, stage: 'staged' }));
    };
    handoff.prepareFiles = async (files, operation) => {
      const savedFiles = await base.prepareFiles!(files, operation);
      const current = await OfflineCaptureStore.getDraft(draft.id);
      operation.assertActive();
      if (!current?.ownerId || !current.captureId || !current.localRevision || current.formData.auctioneerWorkItemId !== setup.workItemId ||
          current.formData.clientSubmissionId !== setup.clientSubmissionId) throw new Error('The saved parent no longer matches this assignment.');
      const now = new Date().toISOString();
      intent = await OfflineCaptureStore.prepareContinuation({ id: randomUUID(), ownerId: current.ownerId, type: setup.reportType,
        parentDraftId: current.id, parentRevision: current.localRevision, parentCaptureId: current.captureId,
        parentClientSubmissionId: current.formData.clientSubmissionId!, parentWorkItemId: setup.workItemId,
        parentSetup: setup, details: captureContinuationDetails(current.formData) || {}, successorDraftId: randomUUID(), successorCaptureId: randomUUID(),
        stage: 'prepared', createdAt: now, updatedAt: now });
      operation.assertActive(); return savedFiles;
    };
    return handoff;
  },
  complete(id: string): Promise<ContinuationResult> {
    const owner = OfflineCaptureStore.getOwnerId();
    if (!owner) return Promise.reject(new Error('Sign in to the owner account before continuing.'));
    const key = `${owner}:${id}`, pending = flights.get(key);
    if (pending) return pending;
    let flight: Promise<ContinuationResult>;
    flight = (async (): Promise<ContinuationResult> => {
      let intent = await read(id); assertOwner(owner);
      if (!intent.reservation) {
        const row = await durableReportTransfer.inspect(intent.parentDraftId); assertOwner(owner);
        if (!row) {
          // No automatic enqueue. An explicit retry opens the same saved parent
          // for its normal Submit flow; it never invents a successful handoff.
          await OfflineCaptureStore.updateContinuation(id, current => ({ ...current, stage: 'prepared', sessionId: undefined }));
          return { parentNotStaged: true, draftId: intent.parentDraftId, setup: intent.parentSetup };
        }
        if (!intent.sessionId || !exactParent(intent, row)) throw new Error('The saved parent upload does not match this Continue request. Keep its originals and review Drafts.');
        if (row.receipt?.reusedAcceptance === true || row.receipt?.alreadyQueued === true) throw new Error('The server returned an earlier report for the parent. Review Previews and the retained draft before starting its next lot.');
      }
      const response = await auctioneerService.continueUpload(intent.parentWorkItemId, intent.sessionId!); assertOwner(owner);
      const r = response.reservation, next = response.setup;
      if (r.ownerId !== owner || r.parentWorkItemId !== intent.parentWorkItemId || r.parentSessionId !== intent.sessionId ||
          r.parentClientSubmissionId !== intent.parentClientSubmissionId || r.parentCaptureId !== intent.parentCaptureId || r.successorWorkItemId !== next.workItemId ||
          (intent.reservation && (r.id !== intent.reservation.id || r.successorWorkItemId !== intent.reservation.successorWorkItemId))) {
        throw new Error('The server returned a different Continue reservation. No new form was opened.');
      }
      // Store even a now-used successor: retries must never allocate a replacement.
      intent = await OfflineCaptureStore.updateContinuation(id, current => ({ ...current, stage: 'reserved', reservation: r, setup: next }));
      validateAuctioneerSuccessor(intent.parentSetup, next);
      assertOwner(owner);
      let successor = await OfflineCaptureStore.getDraft(intent.successorDraftId); assertOwner(owner);
      if (!successor) {
        const now = new Date().toISOString();
        try {
          successor = await OfflineCaptureStore.createCloudDraft({ id: intent.successorDraftId, captureId: intent.successorCaptureId, ownerId: owner,
            type: intent.type, title: next.contract.contractNo, contractNo: next.contract.contractNo, captureMode: 'online', submissionState: 'local',
            formData: { ...intent.details, contractNo: next.contract.contractNo, clientSubmissionId: next.clientSubmissionId,
              auctioneerWorkItemId: next.workItemId, auctioneerSnapshot: next, captureMode: 'online', manualSubmissionRequired: false },
            lots: [], activeLotIdx: 0, createdAt: now, updatedAt: now }, owner);
        } catch (error) {
          assertOwner(owner); successor = await OfflineCaptureStore.getDraft(intent.successorDraftId);
          if (!successor) throw error;
        }
      }
      assertOwner(owner);
      if (successor.ownerId !== owner || successor.captureId !== intent.successorCaptureId || successor.type !== intent.type ||
          successor.formData.auctioneerWorkItemId !== next.workItemId || successor.formData.clientSubmissionId !== next.clientSubmissionId ||
          ['accepted', 'submitted', 'discarded'].includes(successor.submissionState || '')) throw new Error('The saved next lot has changed or is no longer editable. Open Drafts or Incoming to review it.');
      await OfflineCaptureStore.updateContinuation(id, current => ({ ...current, stage: 'ready' })); assertOwner(owner);
      return { draftId: successor.id, setup: next };
    })().finally(() => { if (flights.get(key) === flight) flights.delete(key); });
    flights.set(key, flight); return flight;
  },
};
export default durableContinuationService;
