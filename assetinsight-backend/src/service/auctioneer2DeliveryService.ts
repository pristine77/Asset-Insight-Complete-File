/**
 * Executes the resumable, checkpointed delivery state machine for an Auctioneer2 work
 * item. Each irreversible provider action is reconciled and persisted before advancing;
 * retries resume from durable lot/photo checkpoints, while uncertain create outcomes
 * stop for explicit reconciliation rather than risking duplicate upstream lots.
 */
import mongoose from "mongoose";
import AssetReport from "../models/asset.model.js";
import AuctioneerWorkItem, {
  type AuctioneerDeliveryDestination,
  type IAuctioneerDeliveryLotCheckpoint,
  type IAuctioneerSourceLot,
  type IAuctioneerWorkItem,
} from "../models/auctioneerWorkItem.model.js";
import LotListing from "../models/lotListing.model.js";
import User from "../models/user.model.js";
import { assertReportFilesReadyForWorkflow } from "./reportReleaseService.js";
import {
  AUCTIONEER2_PHOTO_MAX_BATCH_BYTES,
  AUCTIONEER2_PHOTO_MAX_FILES_PER_REQUEST,
  Auctioneer2ClientError,
  closeContractPartForUser,
  completeConditionReport,
  completeContractTask,
  getLot,
  markArrived,
  patchLot,
  pushToAssetInsight,
  submitLot,
  uploadLotPhotos,
  setLotVideo,
  type Auctioneer2Record,
} from "./auctioneer2Client.js";
import { assertAuctioneerContractCaptureRevision, assertNoQueuedContinuationUpload, beginAuctioneerContractClose, confirmAuctioneerContractClose, withAuctioneerContractOperation } from "./auctioneerContractCloseService.js";
import {
  buildAuctioneerConditionReport,
  buildAuctioneerKnownLotPatch,
  buildAuctioneerUnknownLotPayload,
  resolveAuctioneerEstimatedValue,
  resolveAuctioneerLotNumber,
} from "./auctioneer2PayloadMapper.js";
import { collectApprovedPhotoUrls, loadAuctioneerPhoto, trustedPhotoSource } from "./auctioneer2PhotoService.js";
import { createLotPhotoResolver, firstReportImageManifest } from "../utils/lotPhotoOrder.js";
import { AuctioneerDeliveryError, deliveryErrorDiagnostic } from "./auctioneer2DeliveryError.js";
import { frozenAuctioneerVideo } from "./auctioneer2VideoPolicy.js";
import { resolveScheduleAMapping } from "./auctioneerScheduleAMapping.js";
import { assertAuctioneerVideoReceipt } from "./auctioneer2VideoManifest.js";

/*
   Moved to its own module so the photo service can throw it too. It used to be
   defined here and therefore unavailable anywhere else, which is why that
   service threw bare Errors and had to be recognised by the wording of its
   messages instead of by what they are.
*/

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function isRecord(value: unknown): value is Auctioneer2Record {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getPath(record: Auctioneer2Record, path: string): unknown {
  let current: unknown = record;
  for (const segment of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function firstText(record: Auctioneer2Record, paths: string[]): string {
  for (const path of paths) {
    const value = getPath(record, path);
    if (typeof value === "string" || typeof value === "number") {
      const text = clean(value);
      if (text) return text;
    }
  }
  return "";
}

function firstBoolean(record: Auctioneer2Record, paths: string[]): boolean {
  for (const path of paths) {
    const value = getPath(record, path);
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "yes", "1"].includes(normalized)) return true;
      if (["false", "no", "0"].includes(normalized)) return false;
    }
  }
  return false;
}

function assertSuccessfulResponse(
  response: Auctioneer2Record,
  operation: string
): Auctioneer2Record {
  if (!isRecord(response) || response.success !== true) {
    throw new Auctioneer2ClientError(
      `Auctioneer 2.0 returned an invalid response while ${operation}.`,
      {
        statusCode: 502,
        code: "auctioneer2_invalid_response",
      }
    );
  }
  return response;
}

function isDeliverySaveConflict(error: unknown): boolean {
  return error instanceof mongoose.Error.DocumentNotFoundError || error instanceof mongoose.Error.VersionError;
}

function safeDeliveryError(error: unknown): string {
  const message = error instanceof Error ? clean(error.message) : "";
  if (isDeliverySaveConflict(error)) {
    return "The delivery changed while a checkpoint was being saved. Refresh its status before retrying; existing confirmed checkpoints have been preserved.";
  }
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "FILES_GENERATING") {
    return "The latest report files are still being generated. Wait for them to finish, then retry the same Auctioneer delivery.";
  }
  if (code === "FILES_UNAVAILABLE") {
    return "The latest report files are incomplete or generation failed. Open the saved preview and regenerate its files before retrying the same Auctioneer delivery.";
  }
  if (
    error instanceof Auctioneer2ClientError ||
    error instanceof AuctioneerDeliveryError ||
    message.startsWith("A report photo") ||
    message.startsWith("Auctioneer delivery accepts") ||
    message.startsWith("Unable to resolve the report photo") ||
    message.startsWith("R2_BUCKET_NAME") ||
    message.startsWith("A selected report attachment") ||
    message.startsWith("A selected Cloudinary attachment")
  ) {
    return message.slice(0, 500);
  }
  return "Auctioneer delivery failed while preparing or uploading the approved report data.";
}

function normalizeStatus(value: unknown): string {
  return clean(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function remoteLotStatus(lot: Auctioneer2Record): string {
  return normalizeStatus(
    firstText(lot, ["status", "lot.status", "newStatus", "data.status"])
  );
}

function responseStatus(response: Auctioneer2Record): string {
  return normalizeStatus(
    firstText(response, ["newStatus", "status", "lot.status", "data.status"])
  );
}

function remoteConditionReportDone(lot: Auctioneer2Record): boolean {
  return firstBoolean(lot, [
    "conditionReportDone",
    "condition_report_done",
    "lot.conditionReportDone",
    "lot.condition_report_done",
  ]);
}

/*
   ── A LOT SENT BACK FOR RE-INSPECTION IS NOT FINISHED ─────────────────────

   The Operations To-Do Board can push a lot back to Asset Insight to be looked
   at again. Such a lot usually still carries conditionReportDone from its FIRST
   report, and sits at OpToDo — exactly what a finished OpToDoBoard delivery
   looks like. Read that way, a re-inspection delivered to the To-Do Board was
   taken as already done and nothing was sent: no PATCH, no photos, and no
   complete-cr, which is the call that tells Auctioneer the job came back.

   Auctioneer now says so outright: awaitingAssetInsightReinspection is true
   while a To-Do Board job for the lot is out with Asset Insight and not yet
   finished. While it is true the lot is never treated as finished, whatever
   its status and flags say, so it gets the full send of an unfinished lot.

   Missing — an older Auctioneer — or false keeps the earlier reading exactly.
   It also stays safe across a retry: once complete-cr lands, Auctioneer
   finishes the job, the flag drops, and a retry that lost the response sees
   the lot as finished again instead of sending it twice.
*/
function remoteAwaitingReinspection(lot: Auctioneer2Record): boolean {
  return firstBoolean(lot, [
    "awaitingAssetInsightReinspection",
    "lot.awaitingAssetInsightReinspection",
  ]);
}

function isFinalRemoteState(
  remote: Auctioneer2Record,
  destination: AuctioneerDeliveryDestination
): boolean {
  if (remoteAwaitingReinspection(remote)) return false;
  const status = remoteLotStatus(remote);
  if (destination === "LottingBoard") return status === "lotting";
  return status === "optodo" && remoteConditionReportDone(remote);
}

async function persistDelivery(workItem: IAuctioneerWorkItem): Promise<void> {
  workItem.markModified("delivery");
  // The audit hook adds a revision-specific $where for this save. A delivery
  // deliberately reuses its document across checkpoints; retaining that fence
  // after a successful save makes the next save query the already-consumed
  // revision. Keep caller predicates, but do not carry the hook's transient CAS
  // into the next operation. Every save still obtains a fresh audit preimage.
  const originalWhere = workItem.$where;
  try {
    await workItem.save();
  } finally {
    workItem.$where = originalWhere;
  }
}

function approvedLots(report: any, manifest: any): any[] {
  const previewData =
    isRecord(manifest?.previewData) ? manifest.previewData : report?.preview_data;
  if (Array.isArray(previewData?.lots)) return previewData.lots;
  if (Array.isArray(report?.lots)) return report.lots;
  return [];
}

function resolveSourceLot(
  workItem: IAuctioneerWorkItem,
  lot: any,
  index: number
): IAuctioneerSourceLot | undefined {
  const sources = Array.isArray(workItem.snapshot?.lots)
    ? workItem.snapshot.lots
    : [];
  const requestedKey = clean(lot?.auctioneer_source_key);
  /*
     A split lot's own key matches no source — it is minted downstream as
     "<parent>:split:<id>" precisely so Auctioneer's (contractId, contractLotRef)
     de-duplication treats each split as its own lot rather than a replay of the
     first. Its PARENT key is the one that names a real Schedule A line, and
     resolving through it keeps the split away from the positional fallback
     below, which would otherwise hand it whichever source sits at its index.
  */
  const parentKey = clean(lot?.auctioneer_source_parent_key);
  if (parentKey) return sources.find((source) => source.sourceKey === parentKey);
  return (
    (requestedKey
      ? sources.find((source) => source.sourceKey === requestedKey)
      : undefined) ||
    (parentKey
      ? sources.find((source) => source.sourceKey === parentKey)
      : undefined) ||
    sources[index] ||
    (workItem.kind === "unknown" ? sources[0] : undefined)
  );
}

function sourceLotForMapping(source: IAuctioneerSourceLot | undefined): any {
  if (!source) return {};
  return {
    ...(source.raw && typeof source.raw === "object" ? source.raw : {}),
    ...source,
  };
}

function deterministicUnknownSourceKey(
  workItem: IAuctioneerWorkItem,
  lot: any,
  index: number
): string {
  return (
    clean(lot?.auctioneer_source_key) ||
    (index === 0 ? clean(workItem.snapshot?.lots?.[0]?.sourceKey) : "") ||
    `${String(workItem._id)}:unknown:${index + 1}`
  );
}

// Schedule A lines are a locked one-to-one mapping: index/key drift could update
// the wrong upstream lot and must fail closed. Lots SPLIT out of a line are the
// exception — they are new lots naming a known parent, so they are matched by
// that parent rather than by position, and counted separately from the lines.
// Unknown lots may be new, so they receive stable local keys that survive
// retries and anchor their delivery checkpoints.
function synchronizeCheckpoints(
  workItem: IAuctioneerWorkItem,
  lots: any[]
): IAuctioneerDeliveryLotCheckpoint[] {
  const existing = new Map(
    (workItem.delivery?.lots || []).map((checkpoint) => [
      checkpoint.sourceKey,
      checkpoint,
    ])
  );

  if (workItem.kind === "scheduleA") {
    let mappings: ReturnType<typeof resolveScheduleAMapping>;
    try {
      mappings = resolveScheduleAMapping(workItem.snapshot?.lots || [], lots.map(lot => ({
        key: lot?.auctioneer_source_key,
        parentKey: lot?.auctioneer_source_parent_key,
      })));
    } catch (error) {
      throw new AuctioneerDeliveryError(error instanceof Error ? error.message : "Invalid Schedule A mapping.");
    }
    // The delivery loop indexes report photos by checkpoint position.
    return mappings.map(({ source, key }) => {
      const previous = existing.get(key);
      if (previous && (clean(previous.sourceLotId) !== clean(source.lotId) ||
          clean(previous.sourceSubmissionId) !== clean(source.submissionId))) {
        throw new AuctioneerDeliveryError("The saved Schedule A delivery lineage has changed. Contact support before retrying.");
      }
      return previous || {
        sourceKey: key,
        sourceLotId: source.lotId,
        sourceSubmissionId: source.submissionId,
        status: "pending" as const,
      };
    });
  }

  if (lots.length === 0) {
    throw new AuctioneerDeliveryError(
      "The approved report does not contain any lots to send."
    );
  }
  return lots.map((lot, index) => {
    const sourceKey = deterministicUnknownSourceKey(workItem, lot, index);
    return (
      existing.get(sourceKey) || {
        sourceKey,
        status: "pending",
      }
    );
  });
}

function globalReportImageUrls(report: any, manifest: any): string[] {
  const previewData = manifest?.previewData || {};
  return firstReportImageManifest(
    previewData.imageUrls, previewData.image_urls, report?.imageUrls, report?.image_urls,
  );
}

function approvedPhotoUrls(report: any, manifest: any, lot: any, lotIndex: number): string[] {
  if (manifest?.photoOrderVersion === 2) {
    const saved = manifest.photoUrlsByLot?.[lotIndex];
    if (!Array.isArray(saved) || saved.some((url) => typeof url !== "string" || !url.trim())) {
      throw new AuctioneerDeliveryError("The saved delivery photo manifest is incomplete. Contact support before retrying.");
    }
    return saved;
  }
  const previewData = manifest?.previewData || {};
  const globalUrls = globalReportImageUrls(report, manifest);
  return createLotPhotoResolver(globalUrls, previewData.deleted_image_indexes, previewData.deleted_image_urls)(lot).map((photo) => photo.url);
}

// Compatibility comparison only. Old checkpoints refer to this exact derived
// order; changing it after a confirmed or ambiguous upload would skip/relabel
// photos. Never replay a partial legacy delivery against the corrected order.
function legacyApprovedPhotoUrls(report: any, manifest: any, lot: any): string[] {
  const preview = manifest?.previewData || {};
  const array = (value: unknown): any[] => Array.isArray(value) ? value : [];
  const globals = [...new Set([...array(report?.imageUrls), ...array(preview.imageUrls), ...array(preview.image_urls)].map(clean).filter(Boolean))];
  const deletedUrls = new Set([...array(preview.deleted_image_urls), ...array(lot?.deleted_image_urls)].map(clean).filter(Boolean));
  const deletedIndexes = new Set(array(preview.deleted_image_indexes).map(Number).filter(Number.isInteger));
  const indexed = [...array(lot?.image_indexes), ...array(lot?.extra_image_indexes)]
    .map(Number).filter((index) => Number.isInteger(index) && index >= 0 && !deletedIndexes.has(index) && globals[index])
    .map((index) => globals[index]);
  const nested = array(lot?.items).flatMap((item) => [item?.image_url, ...array(item?.image_urls)]).map(clean).filter(Boolean);
  return [...new Set([...collectApprovedPhotoUrls(lot), ...indexed, ...nested])].filter((url) => !deletedUrls.has(url));
}

function remotePhotoNames(remote: Auctioneer2Record): string[] {
  const photos = Array.isArray(remote.photos)
    ? remote.photos
    : Array.isArray(getPath(remote, "lot.photos"))
      ? (getPath(remote, "lot.photos") as unknown[])
      : [];
  return photos
    .map((photo) => {
      if (typeof photo === "string") return photo;
      if (!isRecord(photo)) return "";
      return firstText(photo, ["filename", "fileName", "name", "url"]);
    })
    .map((value) => clean(value).toLowerCase())
    .filter(Boolean);
}

function uploadedRangeFromStep(step: unknown): number {
  const match = /^photos_uploaded:(\d+)$/.exec(clean(step));
  return match ? Number(match[1]) : 0;
}

function inFlightPhotoRange(step: unknown): { start: number; end: number } | null {
  const match = /^uploading_photos:(\d+):(\d+)$/.exec(clean(step));
  if (!match) return null;
  return { start: Number(match[1]), end: Number(match[2]) };
}

function remoteContainsPhotoRange(
  remote: Auctioneer2Record,
  lotIndex: number,
  start: number,
  end: number
): boolean {
  const names = remotePhotoNames(remote);
  for (let index = start; index < end; index += 1) {
    const prefix = `lot-${String(lotIndex + 1).padStart(3, "0")}-photo-${String(
      index + 1
    ).padStart(3, "0")}`;
    if (!names.some((name) => name.includes(prefix))) return false;
  }
  return end > start;
}

async function uploadApprovedPhotos(input: {
  workItem: IAuctioneerWorkItem;
  checkpoint: IAuctioneerDeliveryLotCheckpoint;
  report: any;
  manifest: any;
  lot: any;
  lotId: string;
  lotIndex: number;
}): Promise<void> {
  const { workItem, checkpoint, report, manifest, lot, lotId, lotIndex } = input;
  if (checkpoint.photosUploadedAt) return;

  const urls = approvedPhotoUrls(report, manifest, lot, lotIndex);
  if (urls.length === 0) {
    checkpoint.photosUploadedAt = new Date();
    checkpoint.step = "photos_uploaded:0";
    await persistDelivery(workItem);
    return;
  }

  let offset = uploadedRangeFromStep(checkpoint.step);
  // Persisting "uploading" before the provider call leaves an ambiguous window on crash.
  // Deterministic filenames let a retry inspect the remote lot and advance without
  // uploading a confirmed batch twice.
  const inFlight = inFlightPhotoRange(checkpoint.step);
  if (inFlight) {
    const remote = await getLot(lotId);
    if (
      remoteContainsPhotoRange(
        remote,
        lotIndex,
        inFlight.start,
        inFlight.end
      )
    ) {
      offset = inFlight.end;
      checkpoint.step = `photos_uploaded:${offset}`;
      await persistDelivery(workItem);
    } else {
      offset = inFlight.start;
    }
  }

  while (offset < urls.length) {
    // Load only the next bounded JSON/Base64 batch. The provider limit is based
    // on decoded bytes, so the worker must partition by both image count and
    // binary size before the client expands the buffers into Base64 strings.
    const photos = [];
    let end = offset;
    let decodedBatchBytes = 0;
    while (
      end < urls.length &&
      photos.length < AUCTIONEER2_PHOTO_MAX_FILES_PER_REQUEST
    ) {
      const photo = await loadAuctioneerPhoto(urls[end], lotIndex, end);
      if (
        photos.length > 0 &&
        decodedBatchBytes + photo.buffer.byteLength >
          AUCTIONEER2_PHOTO_MAX_BATCH_BYTES
      ) {
        break;
      }
      photos.push({ ...photo, order: end });
      decodedBatchBytes += photo.buffer.byteLength;
      end += 1;
    }

    if (photos.length === 0 || end <= offset) {
      throw new AuctioneerDeliveryError(
        "Unable to construct a valid Auctioneer photo upload batch."
      );
    }
    checkpoint.status = "processing";
    checkpoint.step = `uploading_photos:${offset}:${end}`;
    checkpoint.lastError = undefined;
    await persistDelivery(workItem);

    assertSuccessfulResponse(
      await uploadLotPhotos(
        lotId,
        photos.map(({ buffer, filename, contentType, order }) => ({
          buffer,
          filename,
          contentType,
          order,
        }))
      ),
      "uploading lot photos"
    );
    offset = end;
    checkpoint.step = `photos_uploaded:${offset}`;
    await persistDelivery(workItem);
  }

  checkpoint.photosUploadedAt = new Date();
  await persistDelivery(workItem);
}

function completeCrBody(input: {
  lot: any;
  destination: AuctioneerDeliveryDestination;
  opTaskDescription?: string;
  completedBy: string;
  submissionGuid?: string;
}) {
  const lotNumber = resolveAuctioneerLotNumber(input.lot);
  return {
    ...(lotNumber ? { lotNumber } : {}),
    estimatedValue: resolveAuctioneerEstimatedValue(input.lot),
    conditionReport: buildAuctioneerConditionReport(input.lot),
    destination: input.destination,
    ...(input.opTaskDescription
      ? { opTaskDescription: input.opTaskDescription }
      : {}),
    completedBy: input.completedBy,
    ...(input.submissionGuid ? { submissionGuid: input.submissionGuid } : {}),
  };
}

async function reconcileCompletedLotNumber(
  lotId: string,
  lot: any,
  remote: Auctioneer2Record
): Promise<void> {
  const lotNumber = resolveAuctioneerLotNumber(lot);
  const numberPaths = ["lotNumber", "lot_number", "lot.lotNumber", "lot.lot_number"];
  const remoteNumber = firstText(remote, numberPaths);
  if (!lotNumber || lotNumber === remoteNumber) return;

  // A prior completion (including an older worker) may have moved the CR but
  // left its number unset. Update only that field; never replay photos or CR.
  // A lost response is safe to retry because assigning the same number is a no-op.
  const response = assertSuccessfulResponse(
    await patchLot(lotId, { lotNumber }),
    "returning the completed CR lot number"
  );
  if (
    Array.isArray(response.updatedFields) &&
    response.updatedFields.includes("lotNumber")
  ) return;
  const verified = await getLot(lotId);
  if (firstText(verified, numberPaths) !== lotNumber) {
    throw new AuctioneerDeliveryError(
      "Auctioneer did not confirm the lot number for the completed CR. Retry sending or contact support."
    );
  }
}

async function deliverScheduleALot(input: {
  workItem: IAuctioneerWorkItem;
  checkpoint: IAuctioneerDeliveryLotCheckpoint;
  report: any;
  manifest: any;
  lot: any;
  source: IAuctioneerSourceLot;
  lotIndex: number;
  destination: AuctioneerDeliveryDestination;
  opTaskDescription?: string;
  completedBy: string;
}): Promise<void> {
  const {
    workItem,
    checkpoint,
    report,
    manifest,
    lot,
    source,
    lotIndex,
    destination,
    opTaskDescription,
    completedBy,
  } = input;
  const lotId = clean(checkpoint.sourceLotId || source.lotId);
  if (!lotId) {
    throw new AuctioneerDeliveryError(
      "A locked Schedule A lot is missing its Auctioneer lot ID."
    );
  }

  if (!checkpoint.conditionReportCompletedAt) {
    // The provider may have committed a previous completion whose response was lost.
    // Remote final state is stronger evidence than the missing local timestamp.
    const remote = await getLot(lotId);
    if (isFinalRemoteState(remote, destination)) {
      await reconcileCompletedLotNumber(lotId, lot, remote);
      checkpoint.conditionReportCompletedAt = new Date();
      checkpoint.status = "sent";
      checkpoint.step = "sent";
      checkpoint.lastError = undefined;
      await persistDelivery(workItem);
      return;
    }
  }

  if (!checkpoint.patchedAt) {
    checkpoint.status = "processing";
    checkpoint.step = "patching";
    await persistDelivery(workItem);
    const patch = buildAuctioneerKnownLotPatch(
      lot,
      sourceLotForMapping(source),
      { useSourceFallbacks: false }
    );
    if (Object.keys(patch).length > 0) {
      assertSuccessfulResponse(
        await patchLot(lotId, patch),
        "updating a Schedule A lot"
      );
    }
    checkpoint.patchedAt = new Date();
    checkpoint.step = "patched";
    await persistDelivery(workItem);
  }

  await uploadApprovedPhotos({
    workItem,
    checkpoint,
    report,
    manifest,
    lot,
    lotId,
    lotIndex,
  });
  await uploadApprovedVideo({ workItem, checkpoint, report, manifest, lot, lotId, lotIndex });

  if (!checkpoint.conditionReportCompletedAt) {
    checkpoint.status = "processing";
    checkpoint.step = "completing_condition_report";
    await persistDelivery(workItem);
    assertSuccessfulResponse(
      await completeConditionReport(
        lotId,
        completeCrBody({
          lot,
          destination,
          opTaskDescription,
          completedBy,
          submissionGuid: checkpoint.sourceSubmissionId || source.submissionId,
        })
      ),
      "completing a Schedule A condition report"
    );
    checkpoint.conditionReportCompletedAt = new Date();
  }

  checkpoint.status = "sent";
  checkpoint.step = "sent";
  checkpoint.lastError = undefined;
  await persistDelivery(workItem);
}

async function requireUnknownLotReconciliation(
  workItem: IAuctioneerWorkItem,
  checkpoint: IAuctioneerDeliveryLotCheckpoint,
  reason: string
): Promise<never> {
  checkpoint.status = "needs_reconciliation";
  checkpoint.lastError = reason;
  workItem.delivery.status = "needs_reconciliation";
  workItem.delivery.failedAt = new Date();
  workItem.delivery.lastError = reason;
  workItem.delivery.reconciliation = {
    required: true,
    sourceKey: checkpoint.sourceKey,
    reason,
    requestedAt: new Date(),
  };
  await persistDelivery(workItem);
  throw new AuctioneerDeliveryError(reason);
}

async function deliverUnknownLot(input: {
  workItem: IAuctioneerWorkItem;
  checkpoint: IAuctioneerDeliveryLotCheckpoint;
  report: any;
  manifest: any;
  lot: any;
  source?: IAuctioneerSourceLot;
  lotIndex: number;
  destination: AuctioneerDeliveryDestination;
  opTaskDescription?: string;
  completedBy: string;
}): Promise<void> {
  const {
    workItem,
    checkpoint,
    report,
    manifest,
    lot,
    source,
    lotIndex,
    destination,
    opTaskDescription,
    completedBy,
  } = input;

  let lotId = clean(checkpoint.createdLotId);
  if (!lotId) {
    if (checkpoint.step === "submitting") {
      await requireUnknownLotReconciliation(
        workItem,
        checkpoint,
        "The Unknown Lot submission outcome is uncertain. Reconcile the upstream lot before retrying."
      );
    }
    const eventId = clean(workItem.contract.eventId);
    if (!eventId) {
      throw new AuctioneerDeliveryError(
        "The Auctioneer contract is missing the event ID required to create an Unknown Lot."
      );
    }

    checkpoint.status = "processing";
    checkpoint.step = "submitting";
    checkpoint.lastError = undefined;
    await persistDelivery(workItem);
    let response: Auctioneer2Record;
    try {
      response = assertSuccessfulResponse(
        await submitLot(
          buildAuctioneerUnknownLotPayload({
            lot,
            sourceLot: sourceLotForMapping(source),
            contractId: workItem.contract.id,
            eventId,
            contractLotRef: `${workItem.clientSubmissionId}:${lotIndex + 1}`,
            /*
               Present only for a lot split out of a Schedule A line. It names
               the PARENT LOT in Auctioneer — source.lotId, the same id the
               patch path uses — and Auctioneer copies that lot's commission
               onto both the new Schedule A line and the new lot, so the
               consignor is charged the rate they signed for.

               Absent for a genuinely new Unknown lot, which has no line to
               inherit from and takes the contract's own terms.
            */
            ...(clean((lot as any)?.auctioneer_source_parent_key) && source?.lotId
              ? { scheduleAParentRef: source.lotId }
              : {}),
            destination,
            opTaskDescription,
            submittedBy: completedBy,
          })
        ),
        "creating an Unknown Lot"
      );
    } catch (error) {
      if (
        error instanceof Auctioneer2ClientError &&
        error.ambiguousWrite
      ) {
        await requireUnknownLotReconciliation(
          workItem,
          checkpoint,
          "Auctioneer did not confirm whether the Unknown Lot was created. Reconcile it before retrying."
        );
      }
      checkpoint.step = "pending";
      await persistDelivery(workItem);
      throw error;
    }

    lotId = firstText(response, [
      "rowGuid",
      "row_guid",
      "lotRowGuid",
      "lot_row_guid",
      "lot.rowGuid",
      "lot.row_guid",
      "lot.id",
      "lotId",
      "data.rowGuid",
      "data.row_guid",
      "data.lotRowGuid",
      "data.lot_row_guid",
      "data.lot.rowGuid",
      "data.lot.row_guid",
      "data.lot.id",
      "data.lotId",
    ]);
    const submissionId = firstText(response, [
      "submissionId",
      "submissionGuid",
      "data.submissionId",
    ]);
    if (!lotId) {
      await requireUnknownLotReconciliation(
        workItem,
        checkpoint,
        "Auctioneer accepted the Unknown Lot request without returning a lot ID. Reconcile it before retrying."
      );
    }
    checkpoint.createdLotId = lotId;
    checkpoint.createdSubmissionId = submissionId || undefined;
    checkpoint.status = "processing";
    checkpoint.step = "submitted";
    await persistDelivery(workItem);
  }

  await uploadApprovedPhotos({
    workItem,
    checkpoint,
    report,
    manifest,
    lot,
    lotId,
    lotIndex,
  });
  await uploadApprovedVideo({ workItem, checkpoint, report, manifest, lot, lotId, lotIndex });

  let remote = await getLot(lotId);
  if (isFinalRemoteState(remote, destination)) {
    await reconcileCompletedLotNumber(lotId, lot, remote);
    checkpoint.conditionReportCompletedAt =
      checkpoint.conditionReportCompletedAt || new Date();
    checkpoint.status = "sent";
    checkpoint.step = "sent";
    checkpoint.lastError = undefined;
    await persistDelivery(workItem);
    return;
  }

  let status = remoteLotStatus(remote);
  if (status === "awaitingarrival") {
    checkpoint.status = "processing";
    checkpoint.step = "marking_arrived";
    await persistDelivery(workItem);
    const response = assertSuccessfulResponse(
      await markArrived(lotId, { arrivedBy: completedBy }),
      "marking an Unknown Lot as arrived"
    );
    status = responseStatus(response);
    if (status !== "arrived") {
      remote = await getLot(lotId);
      status = remoteLotStatus(remote);
    }
    if (status !== "arrived") {
      throw new AuctioneerDeliveryError(
        "Auctioneer returned an unexpected state after marking the Unknown Lot as arrived."
      );
    }
    checkpoint.arrivedAt = new Date();
    checkpoint.step = "arrived";
    await persistDelivery(workItem);
  }

  if (status === "arrived") {
    checkpoint.status = "processing";
    checkpoint.step = "pushing_to_asset_insight";
    await persistDelivery(workItem);
    const response = assertSuccessfulResponse(
      await pushToAssetInsight(lotId, { pushedBy: completedBy }),
      "pushing an Unknown Lot to Asset Insight"
    );
    const returnedSubmissionId = firstText(response, [
      "submissionId",
      "submissionGuid",
      "data.submissionId",
    ]);
    if (returnedSubmissionId) {
      checkpoint.createdSubmissionId = returnedSubmissionId;
    }
    status = responseStatus(response);
    if (status !== "optodo") {
      remote = await getLot(lotId);
      status = remoteLotStatus(remote);
    }
    if (status !== "optodo") {
      throw new AuctioneerDeliveryError(
        "Auctioneer returned an unexpected state after pushing the Unknown Lot to Asset Insight."
      );
    }
    checkpoint.pushedAt = new Date();
    checkpoint.step = "pushed";
    await persistDelivery(workItem);
  }

  if (status !== "optodo") {
    throw new AuctioneerDeliveryError(
      `Auctioneer stopped the Unknown Lot workflow in an unexpected state (${status || "unknown"}).`
    );
  }

  if (!checkpoint.conditionReportCompletedAt) {
    checkpoint.status = "processing";
    checkpoint.step = "completing_condition_report";
    await persistDelivery(workItem);
    const response = assertSuccessfulResponse(
      await completeConditionReport(
        lotId,
        completeCrBody({
          lot,
          destination,
          opTaskDescription,
          completedBy,
          submissionGuid: checkpoint.createdSubmissionId,
        })
      ),
      "completing an Unknown Lot condition report"
    );
    const finalStatus = responseStatus(response);
    if (
      (destination === "LottingBoard" && finalStatus && finalStatus !== "lotting") ||
      (destination === "OpToDoBoard" && finalStatus && finalStatus !== "optodo")
    ) {
      throw new AuctioneerDeliveryError(
        "Auctioneer returned an unexpected state after completing the Unknown Lot condition report."
      );
    }
    checkpoint.conditionReportCompletedAt = new Date();
  }

  checkpoint.status = "sent";
  checkpoint.step = "sent";
  checkpoint.lastError = undefined;
  await persistDelivery(workItem);
}

async function uploadApprovedVideo(input: {
  workItem: IAuctioneerWorkItem; checkpoint: IAuctioneerDeliveryLotCheckpoint;
  report: any; manifest: any; lot: any; lotId: string; lotIndex: number;
}): Promise<void> {
  const { workItem, checkpoint, report, manifest, lot, lotId, lotIndex } = input;
  if (checkpoint.videoUploadedAt) return;
  let url: string | null;
  try { url = frozenAuctioneerVideo(manifest, lot, lotIndex); }
  catch { throw new AuctioneerDeliveryError("The saved lot video manifest is invalid. Ask support to review this delivery before retrying."); }
  if (!url) return;
  const receiptId = manifest.videoReceiptIdsByLot?.[lotIndex];
  if (receiptId) await assertAuctioneerVideoReceipt(report, workItem.selectedReportType, receiptId, url);
  checkpoint.step = "setting_video";
  await persistDelivery(workItem);
  // Photos are checkpointed separately; same-link retries are idempotent upstream.
  try { assertSuccessfulResponse(await setLotVideo(lotId, url), "setting the lot video"); }
  catch (error) {
    if (error instanceof Auctioneer2ClientError && (error.upstreamStatus === 400 || error.code === "auctioneer2_invalid_video")) {
      throw new AuctioneerDeliveryError("Auctioneer rejected the lot video link. Photos already accepted are preserved. Ask the auction team to verify YouTube video support, then retry the same delivery.");
    }
    throw error;
  }
  checkpoint.videoUploadedAt = new Date();
  checkpoint.step = "video_uploaded";
  await persistDelivery(workItem);
}

async function loadLinkedReport(workItem: IAuctioneerWorkItem): Promise<any> {
  if (!workItem.linkedReportId) return null;
  return workItem.selectedReportType === "asset"
    ? AssetReport.findById(workItem.linkedReportId).select("+youtube_submission").lean()
    : LotListing.findById(workItem.linkedReportId).select("+youtube_submission").lean();
}

async function completedByFor(workItem: IAuctioneerWorkItem): Promise<string> {
  const user = await User.findById(workItem.claimedBy)
    .select("username email")
    .lean();
  return (
    clean((user as any)?.username) ||
    clean((user as any)?.email) ||
    `Asset Insight user ${String(workItem.claimedBy)}`
  );
}

/*
   ── CLOSING THE CONTRACT AFTER A DELIVERY ─────────────────────────────────

   Runs once every lot of the delivery is checkpointed as sent, and only when
   the user asked for it ("I've finished this contract — close my part").

   Work assigned to a user closes THAT USER'S PART, never the contract: the
   call names them (completedByUserId = the work item's assignmentUserId, their
   Asset Insight id), and Auctioneer completes the contract only once every
   assigned user has closed theirs. Closing for user-assigned work used to be
   refused outright, because an unnamed close could sign off other people's
   lots; naming the user is what makes it safe.

   Older work with no assignment has nobody to name and closes the contract
   itself, exactly as before.

   Retry safety: contractCompletedAt is the checkpoint and is written only
   after Auctioneer confirms. A crash between the two repeats the call on the
   next attempt, which Auctioneer answers with the first outcome and changes
   nothing. A failure leaves the delivery failed with every lot still marked
   sent, so the same retry goes straight back to this step.
*/
async function closeContractAfterDelivery(
  workItem: IAuctioneerWorkItem,
  completedBy: string
): Promise<void> {
  const assignedUserId = workItem.assignmentUserId
    ? String(workItem.assignmentUserId)
    : "";
  if (!assignedUserId) {
    assertSuccessfulResponse(
      await completeContractTask(workItem.contract.id, { completedBy }),
      "completing the contract task"
    );
    workItem.delivery.contractCompletedAt = new Date();
    await persistDelivery(workItem);
    return;
  }
  // The person closing is the assigned user. A work item claimed by somebody
  // else would close that other person's part under this one's delivery.
  if (assignedUserId !== String(workItem.claimedBy)) {
    throw new AuctioneerDeliveryError(
      "Every lot was delivered, but this work is assigned to another user, so only they can close their part of the contract."
    );
  }

  await withAuctioneerContractOperation(workItem.contract.id, assignedUserId, async (lease) => {
    await assertAuctioneerContractCaptureRevision(workItem.contract.id, assignedUserId, workItem.contractAccessRevision);
    await assertNoQueuedContinuationUpload(workItem.contract.id, assignedUserId);
    const outstanding = await AuctioneerWorkItem.exists({
      _id: { $ne: workItem._id }, "contract.id": workItem.contract.id,
      claimedBy: workItem.claimedBy,
      ...(workItem.contractAccessRevision !== undefined ? { contractAccessRevision: workItem.contractAccessRevision } : {}),
      "delivery.status": { $in: ["queued", "sending", "failed", "needs_reconciliation"] },
      // Two deliveries may both ask to close this user's part. A peer that
      // has sent every lot only awaits the same idempotent close; treating it
      // as unfinished media would leave both retries blocking one another.
      $or: [
        { "delivery.status": "needs_reconciliation" },
        { "delivery.completeContract": { $ne: true } },
        { "delivery.lots.0": { $exists: false } },
        { "delivery.lots": { $elemMatch: { status: { $ne: "sent" } } } },
      ],
    });
    if (outstanding) throw new AuctioneerDeliveryError(
      "Every lot in this delivery was sent, but another delivery for this contract is unfinished. Finish or retry that delivery before closing your part."
    );
    await lease.assertOwned();
    await beginAuctioneerContractClose(workItem.contract.id, assignedUserId);
    let outcome: Awaited<ReturnType<typeof closeContractPartForUser>>;
    try {
      outcome = await closeContractPartForUser(workItem.contract.id, {
        completedBy,
        completedByUserId: assignedUserId,
      });
    } catch (error) {
      const reason =
        error instanceof Auctioneer2ClientError
          ? clean(error.message)
          : "Auctioneer could not be asked to close it.";
      throw new AuctioneerDeliveryError(
        `Every lot was delivered, but Auctioneer did not confirm closing your part of the contract. ${reason} Retry the same delivery to close it; lots already sent are not sent again.`
      );
    }

    const closedAt = new Date();
    await lease.assertOwned();
    await confirmAuctioneerContractClose(workItem.contract.id, assignedUserId, outcome, closedAt);
    workItem.delivery.contractCompletedAt = closedAt;
    workItem.delivery.contractClose = {
      userId: assignedUserId,
      closedAt,
      taskCompleted: outcome.taskCompleted,
      ...(outcome.userStatus ? { userStatus: outcome.userStatus } : {}),
      via: "delivery",
    };
    await persistDelivery(workItem);
  });
}

/**
 * Executes a persisted delivery manifest. Every successful upstream step is
 * checkpointed before the next call, so an explicit retry resumes only the
 * incomplete work. Unknown Lot creation is deliberately never retried when
 * the transport outcome is ambiguous.
 */
export async function runAuctioneerDeliveryJob(
  workItemId: string
): Promise<void> {
  const workItem = await AuctioneerWorkItem.findById(workItemId);
  if (!workItem) {
    throw new AuctioneerDeliveryError("Auctioneer delivery work item not found.");
  }
  if (workItem.delivery.status === "sent") return;
  if (workItem.delivery.status === "needs_reconciliation") {
    throw new AuctioneerDeliveryError(
      "Auctioneer delivery requires reconciliation before it can continue."
    );
  }
  if (!["queued", "sending"].includes(workItem.delivery.status)) {
    throw new AuctioneerDeliveryError(
      "Auctioneer delivery is not queued for processing."
    );
  }

  let activeCheckpoint: IAuctioneerDeliveryLotCheckpoint | undefined;
  try {
    if (workItem.assignmentUserId) await assertAuctioneerContractCaptureRevision(
      workItem.contract.id, String(workItem.assignmentUserId), workItem.contractAccessRevision);
    workItem.delivery.status = "sending";
    workItem.delivery.startedAt = workItem.delivery.startedAt || new Date();
    workItem.delivery.failedAt = undefined;
    workItem.delivery.lastError = undefined;
    await persistDelivery(workItem);

    const report = await loadLinkedReport(workItem);
    if (!report) {
      throw new AuctioneerDeliveryError(
        "The linked Asset Insight report could not be found."
      );
    }
    if (
      workItem.selectedReportType === "asset" &&
      (clean(report.status).toLowerCase() !== "approved" ||
        clean(report.release_status).toLowerCase() !== "released")
    ) {
      throw new AuctioneerDeliveryError(
        "The linked Asset Listing is no longer approved and released."
      );
    }
    assertReportFilesReadyForWorkflow(
      workItem.selectedReportType === "asset" ? "asset" : "lotListing",
      report
    );

    const manifest = (workItem.delivery.manifest || {}) as any;
    const destination =
      manifest.destination || workItem.delivery.destination;
    if (destination !== "LottingBoard" && destination !== "OpToDoBoard") {
      throw new AuctioneerDeliveryError(
        "The Auctioneer delivery destination is missing or invalid."
      );
    }
    const opTaskDescription = clean(
      manifest.opTaskDescription || workItem.delivery.opTaskDescription
    );
    if (destination === "OpToDoBoard" && !opTaskDescription) {
      throw new AuctioneerDeliveryError(
        "An OpToDoBoard delivery requires a note."
      );
    }
    const lots = approvedLots(report, manifest);
    // Synchronize and persist the complete checkpoint set before the first outbound
    // action so every later attempt has the same lot ordering and source mapping.
    workItem.delivery.lots = synchronizeCheckpoints(workItem, lots);
    if (manifest.photoOrderVersion !== 2) {
      for (let index = 0; index < lots.length; index += 1) {
        const checkpoint = workItem.delivery.lots[index];
        if (checkpoint.status === "sent") continue;
        const photoUploadStarted = checkpoint.photosUploadedAt || uploadedRangeFromStep(checkpoint.step) > 0 || inFlightPhotoRange(checkpoint.step);
        if (photoUploadStarted && JSON.stringify(legacyApprovedPhotoUrls(report, manifest, lots[index])) !== JSON.stringify(approvedPhotoUrls(report, manifest, lots[index], index))) {
          throw new AuctioneerDeliveryError(`Photo delivery for lot ${index + 1} already started with a different saved photo order. Contact support to review the existing auction photos before retrying; no photos have been resent.`);
        }
      }
    }
    // Validate sources before upstream writes; never silently drop frozen photos.
    for (let index = 0; index < lots.length; index += 1) {
      const checkpoint = workItem.delivery.lots[index];
      if (checkpoint.status === "sent" || checkpoint.photosUploadedAt) continue;
      activeCheckpoint = checkpoint;
      const urls = approvedPhotoUrls(report, manifest, lots[index], index);
      for (let photoIndex = 0; photoIndex < urls.length; photoIndex += 1) {
        try { trustedPhotoSource(urls[photoIndex]); }
        catch (error) {
          if (error instanceof AuctioneerDeliveryError) throw new AuctioneerDeliveryError(`Lot ${index + 1}, photo ${photoIndex + 1}: ${error.message}`);
          throw error;
        }
      }
    }
    await persistDelivery(workItem);
    const completedBy = await completedByFor(workItem);

    for (let index = 0; index < lots.length; index += 1) {
      const checkpoint = workItem.delivery.lots[index];
      activeCheckpoint = checkpoint;
      if (checkpoint.status === "sent") continue;
      checkpoint.status = "processing";
      checkpoint.lastError = undefined;
      await persistDelivery(workItem);

      const source = resolveSourceLot(workItem, lots[index], index);
      /*
         A lot split out of a Schedule A line takes the CREATE path even though
         its work item is of kind scheduleA. The Schedule A path patches the lot
         that already exists for that line and completes its condition report —
         correct for the line itself, and wrong for its splits, which would all
         patch the same lot with the last one winning and nothing reporting it.
      */
      const splitParentKey = clean((lots[index] as any)?.auctioneer_source_parent_key);
      if (workItem.kind === "scheduleA" && !splitParentKey) {
        if (!source) {
          throw new AuctioneerDeliveryError(
            "A locked Schedule A source lot could not be resolved."
          );
        }
        await deliverScheduleALot({
          workItem,
          checkpoint,
          report,
          manifest,
          lot: lots[index],
          source,
          lotIndex: index,
          destination,
          opTaskDescription: opTaskDescription || undefined,
          completedBy,
        });
      } else {
        await deliverUnknownLot({
          workItem,
          checkpoint,
          report,
          manifest,
          lot: lots[index],
          source,
          lotIndex: index,
          destination,
          opTaskDescription: opTaskDescription || undefined,
          completedBy,
        });
      }
    }

    const completeContract =
      manifest.completeContract === true ||
      workItem.delivery.completeContract === true;
    if (completeContract && !workItem.delivery.contractCompletedAt) {
      // Every lot is checkpointed as sent by now and nothing below resends one,
      // so a failure from here is the contract close, not the last lot.
      activeCheckpoint = undefined;
      await closeContractAfterDelivery(workItem, completedBy);
    }

    // Clear the active uniqueness key only after all lot and optional contract actions
    // are durably checkpointed. Until then, the source contract cannot be reclaimed.
    workItem.delivery.status = "sent";
    workItem.delivery.completedAt = new Date();
    workItem.delivery.failedAt = undefined;
    workItem.delivery.lastError = undefined;
    workItem.delivery.reconciliation = { required: false };
    workItem.status = "sent";
    workItem.activeContractKey = undefined;
    await persistDelivery(workItem);
  } catch (error) {
    console.error("[Auctioneer2Delivery] delivery failed", {
      workItemId: String(workItem._id),
      reportId: String(workItem.linkedReportId || ""),
      contractId: clean(workItem.contract?.id),
      contractNo: clean(workItem.contract?.contractNo),
      checkpoint: activeCheckpoint ? { sourceKey: activeCheckpoint.sourceKey, step: activeCheckpoint.step, status: activeCheckpoint.status } : null,
      message: safeDeliveryError(error),
      ...deliveryErrorDiagnostic(error),
    });
    const message = safeDeliveryError(error);
    const needsReconciliation =
      clean((workItem.delivery as any).status) === "needs_reconciliation";
    // A failed CAS means this document is stale. Saving a failure from it with
    // a fresh audit revision could erase another worker's confirmed checkpoints.
    // Stop immediately; never refresh-and-overwrite or blindly replay a write.
    if (!needsReconciliation && !isDeliverySaveConflict(error)) {
      if (activeCheckpoint && activeCheckpoint.status !== "sent") {
        activeCheckpoint.status = "failed";
        activeCheckpoint.lastError = message;
      }
      workItem.delivery.status = "failed";
      workItem.delivery.failedAt = new Date();
      workItem.delivery.lastError = message;
      // Preserve the original provider failure. A secondary MongoDB outage is important
      // operationally but must not replace the actionable delivery error returned to the job.
      await persistDelivery(workItem).catch(() => undefined);
    }
    throw new Error(message);
  }
}
