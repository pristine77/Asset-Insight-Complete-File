import { randomUUID } from "node:crypto";
import ReportUploadSession from "../models/reportUploadSession.model.js";
import AuctioneerWorkItem from "../models/auctioneerWorkItem.model.js";
import { withAuctioneerContractOperation } from "../service/auctioneerContractCloseService.js";
import type { ReportSubmissionAdmissionLease } from "../service/reportSubmissionAdmissionService.js";
import { getPositiveIntEnv, mapWithConcurrency } from "./concurrency.js";
import {
  deleteFromR2Strict,
  getCurrentR2StorageTarget,
  resolvePersistedR2StorageTarget,
} from "./r2Storage/r2Upload.js";

type CleanupResult = {
  sessions: number;
  objects: number;
  failedObjects: number;
};

/**
 * Release only excluded divider originals after the report handoff is durable.
 * The confirmed grouping and manifest are immutable at queued/processed, so a
 * reclaimed cleanup can safely repeat an object delete after a lost response.
 * No request depends on this best-effort maintenance projection finishing.
 */
export async function cleanupCompletedSmartUploadDividers(): Promise<CleanupResult> {
  const result: CleanupResult = { sessions: 0, objects: 0, failedObjects: 0 };
  if (!getCurrentR2StorageTarget().bucketName) return result;
  const reclaimBefore = new Date(Date.now() -
    getPositiveIntEnv("SMART_UPLOAD_CLEANUP_CLAIM_MINUTES", 60) * 60_000);
  const maxSessions = getPositiveIntEnv("SMART_UPLOAD_CLEANUP_MAX_SESSIONS", 10);
  // Keep deletion bounded even if a historical operator setting is excessive.
  const concurrency = Math.min(8, getPositiveIntEnv("SMART_UPLOAD_DELETE_CONCURRENCY", 8));
  for (let index = 0; index < maxSessions; index += 1) {
    const claimToken = randomUUID();
    const eligible = {
      smartUpload: true,
      status: { $in: ["queued", "processed"] },
      reportId: { $type: "string" as const, $ne: "" },
      "smartGrouping.status": "confirmed",
      // Numbered start photos are report evidence, never excluded separators.
      "smartGrouping.method": { $ne: "lot_number" },
      "smartGrouping.groups.0": { $exists: true },
      "smartGrouping.dividerFileIds.0": { $exists: true },
      cleanupStartedAt: { $exists: false },
      dividerCleanupCompletedAt: { $exists: false },
    };
    const session = await ReportUploadSession.findOneAndUpdate(
      {
        ...eligible,
        $or: [
          { dividerCleanupClaimedAt: { $exists: false } },
          { dividerCleanupClaimedAt: { $lte: reclaimBefore } },
        ],
      },
      { $set: { dividerCleanupClaimToken: claimToken, dividerCleanupClaimedAt: new Date() } },
      { returnDocument: "after", sort: { queuedAt: 1, _id: 1 } }
    );
    if (!session) break;

    const storageTarget = resolvePersistedR2StorageTarget(session);
    const dividerIds = new Set((session.smartGrouping?.dividerFileIds || []).map(String));
    const groupedIds = new Set((session.smartGrouping?.groups || []).flatMap((group) => group.fileIds.map(String)));
    // Protect all report media, including malformed legacy manifests that reuse
    // an object key under a different file ID or include a divider in a group.
    const protectedKeys = new Set(session.files
      .filter((file) => file.fieldname !== "images" || !dividerIds.has(file.fileId) || groupedIds.has(file.fileId))
      .map((file) => file.key));
    const prefix = `uploads/report-sessions/${session.type}/${String(session._id)}/`;
    const dividerKeys = Array.from(new Set(session.files
      .filter((file) => file.fieldname === "images" && dividerIds.has(file.fileId) &&
        !groupedIds.has(file.fileId) && !protectedKeys.has(file.key) && file.key.startsWith(prefix))
      .map((file) => file.key)));
    let failedObjects = 0;
    // Missing snapshots and former buckets resolve to legacy and stay read-only.
    if (storageTarget.generation === "current") {
      await mapWithConcurrency(dividerKeys, concurrency, async (key) => {
        try {
          await deleteFromR2Strict(storageTarget.bucketName, key);
          result.objects += 1;
        } catch {
          failedObjects += 1;
          result.failedObjects += 1;
        }
      });
    }
    const owned = { ...eligible, _id: session._id, dividerCleanupClaimToken: claimToken };
    if (failedObjects) {
      await ReportUploadSession.updateOne(owned, {
        $set: { dividerCleanupLastError: `Divider cleanup could not remove ${failedObjects} object(s). It will retry automatically.` },
      });
    } else {
      const completed = await ReportUploadSession.updateOne(owned, {
        $set: { dividerCleanupCompletedAt: new Date() },
        $unset: { dividerCleanupClaimToken: 1, dividerCleanupClaimedAt: 1, dividerCleanupLastError: 1 },
      });
      if (completed.modifiedCount) result.sessions += 1;
    }
  }
  return result;
}

/**
 * Claims and removes abandoned or superseded upload sessions without touching
 * queued or processed reports. cleanupStartedAt makes the operation retryable
 * if a worker exits after claiming a session but before all R2 objects are
 * removed. Manual upload sessions are included because replacement uploads use
 * the same durable cleanup claim as Smart Upload.
 */
export async function cleanupAbandonedSmartUploadSessions(): Promise<CleanupResult> {
  const result: CleanupResult = { sessions: 0, objects: 0, failedObjects: 0 };
  const now = Date.now();
  const staleBefore = new Date(
    now -
      getPositiveIntEnv("SMART_UPLOAD_ABANDONED_HOURS", 168) *
        60 *
        60 *
        1000
  );
  const reclaimBefore = new Date(
    now -
      getPositiveIntEnv("SMART_UPLOAD_CLEANUP_CLAIM_MINUTES", 60) *
        60 *
        1000
  );
  const maxSessions = getPositiveIntEnv(
    "SMART_UPLOAD_CLEANUP_MAX_SESSIONS",
    10
  );
  const deleteConcurrency = getPositiveIntEnv(
    "SMART_UPLOAD_DELETE_CONCURRENCY",
    8
  );
  const currentStorageTarget = getCurrentR2StorageTarget();
  if (!currentStorageTarget.bucketName) return result;

  for (let index = 0; index < maxSessions; index += 1) {
    const session = await ReportUploadSession.findOneAndUpdate(
      {
        status: { $in: ["created", "uploading", "completed", "failed"] },
        continuationFreeze: { $exists: false },
        "smartGrouping.status": { $ne: "classifying" },
        $or: [
          {
            updatedAt: { $lt: staleBefore },
            cleanupStartedAt: { $exists: false },
          },
          {
            cleanupStartedAt: { $lte: reclaimBefore },
            $or: [
              { cleanupNotBefore: { $exists: false } },
              { cleanupNotBefore: { $lte: new Date(now) } },
            ],
          },
        ],
      },
      {
        $set: { cleanupStartedAt: new Date() },
      },
      { returnDocument: "after", sort: { updatedAt: 1 } }
    );
    if (!session) break;

    const incomingWorkItemId = String(session.details?.auctioneer_work_item_id || "");
    const validIncomingId = /^[a-f\d]{24}$/i.test(incomingWorkItemId);
    const cleanClaimedSession = async (lease?: ReportSubmissionAdmissionLease) => {
      // The session cleanup claim can precede a concurrent parent pin. Serialize
      // incoming deletion with that pin and recheck before touching originals.
      if (validIncomingId && await AuctioneerWorkItem.exists({ _id: incomingWorkItemId, claimedBy: session.user,
        "queuedContinuation.sessionId": String(session._id) })) {
        await ReportUploadSession.updateOne({ _id: session._id, cleanupStartedAt: session.cleanupStartedAt }, { $unset: { cleanupStartedAt: 1 } });
        return;
      }
      await lease?.assertOwned();
      // Do not release admission for a pinned upload when abandoning our stale
      // cleanup claim. Only actual cleanup releases it; never restore a claim
      // which another session might subsequently have acquired.
      const admitted = await ReportUploadSession.updateOne(
        { _id: session._id, cleanupStartedAt: session.cleanupStartedAt },
        { $unset: { activeContractClaim: 1 } },
      );
      if (admitted.matchedCount !== 1) return;
      const storageTarget = resolvePersistedR2StorageTarget(session);
      let failedObjects = 0;
      if (storageTarget.generation === "current") {
        await mapWithConcurrency(
          session.files,
          deleteConcurrency,
          async (file) => {
            try {
              await lease?.assertOwned();
              await deleteFromR2Strict(storageTarget.bucketName, file.key);
              result.objects += 1;
            } catch {
              failedObjects += 1;
              result.failedObjects += 1;
            }
          }
        );
      }

      if (failedObjects === 0) {
        await lease?.assertOwned();
        await ReportUploadSession.deleteOne({
          _id: session._id,
          cleanupStartedAt: session.cleanupStartedAt,
        });
        result.sessions += 1;
      } else {
        await ReportUploadSession.updateOne(
          { _id: session._id },
          {
            $set: {
              lastError: `Smart Upload cleanup could not remove ${failedObjects} object(s).`,
            },
          },
        );
      }
    };
    const incoming = validIncomingId ? await AuctioneerWorkItem.findOne({
      _id: incomingWorkItemId, claimedBy: session.user,
    }).select("contract.id").lean() : null;
    if (incoming) await withAuctioneerContractOperation(incoming.contract.id, String(session.user), cleanClaimedSession);
    else await cleanClaimedSession();
  }
  return result;
}

export function startSmartUploadSessionMaintenance() {
  if (process.env.SMART_UPLOAD_CLEANUP_ENABLED === "false") return;
  const intervalMs =
    getPositiveIntEnv("SMART_UPLOAD_CLEANUP_INTERVAL_MINUTES", 360) *
    60 *
    1000;
  const run = async () => {
    try {
      const result = await cleanupAbandonedSmartUploadSessions();
      if (result.sessions || result.failedObjects) {
        console.log("[SmartUploadCleanup]", result);
      }
      const dividers = await cleanupCompletedSmartUploadDividers();
      if (dividers.sessions || dividers.failedObjects) {
        console.log("[SmartUploadDividerCleanup]", dividers);
      }
    } catch (error) {
      console.error("[SmartUploadCleanup] failed:", error);
    }
  };
  setTimeout(run, 5 * 60 * 1000).unref?.();
  setInterval(run, intervalMs).unref?.();
}
