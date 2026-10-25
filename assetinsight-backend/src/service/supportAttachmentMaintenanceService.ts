import SupportAttachment from "../models/supportAttachment.model.js";
import {
  deleteFromR2Strict,
  isCurrentR2StorageTarget,
  resolvePersistedR2StorageTarget,
} from "../utils/r2Storage/r2Upload.js";

const DEFAULT_INTERVAL_MS = 15 * 60_000;
const DEFAULT_READY_ORPHAN_GRACE_MS = 24 * 60 * 60_000;
const DEFAULT_INCOMPLETE_GRACE_MS = 60 * 60_000;
const DEFAULT_BATCH_SIZE = 100;

function positiveInteger(value: unknown, fallback: number, minimum = 1): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

export type SupportAttachmentCleanupResult = {
  scanned: number;
  deleted: number;
  failed: number;
  skipped: number;
};

/**
 * Reconcile abandoned direct uploads without racing a late message send.
 *
 * Each candidate is atomically moved to `deleting` while it is still unclaimed.
 * Message creation only accepts `ready`, so after that state transition either
 * cleanup owns the object or a message already owns it—never both.
 */
export async function cleanupAbandonedSupportAttachments(options: {
  now?: Date;
  batchSize?: number;
  readyOrphanGraceMs?: number;
  incompleteGraceMs?: number;
} = {}): Promise<SupportAttachmentCleanupResult> {
  const now = options.now || new Date();
  const batchSize = positiveInteger(options.batchSize, DEFAULT_BATCH_SIZE);
  const readyCutoff = new Date(
    now.getTime() -
      positiveInteger(
        options.readyOrphanGraceMs ?? process.env.SUPPORT_ATTACHMENT_ORPHAN_GRACE_MS,
        DEFAULT_READY_ORPHAN_GRACE_MS,
        60_000
      )
  );
  const incompleteCutoff = new Date(
    now.getTime() -
      positiveInteger(
        options.incompleteGraceMs ?? process.env.SUPPORT_ATTACHMENT_INCOMPLETE_GRACE_MS,
        DEFAULT_INCOMPLETE_GRACE_MS,
        60_000
      )
  );

  const candidates: any[] = await SupportAttachment.find({
    message: null,
    $or: [
      { status: "ready", completedAt: { $lte: readyCutoff } },
      { status: "pending", uploadExpiresAt: { $lte: incompleteCutoff } },
      { status: "rejected", updatedAt: { $lte: incompleteCutoff } },
      // A process may stop after claiming but before deleting. Reclaim old
      // deleting rows so a single crash cannot leak the object indefinitely.
      { status: "deleting", cleanupStartedAt: { $lte: incompleteCutoff } },
    ],
  })
    .sort({ updatedAt: 1, _id: 1 })
    .limit(batchSize)
    .select("status key r2Bucket r2PublicBaseUrl cleanupPreviousStatus")
    .lean();

  const result: SupportAttachmentCleanupResult = {
    scanned: candidates.length,
    deleted: 0,
    failed: 0,
    skipped: 0,
  };
  for (const candidate of candidates) {
    const previousStatus =
      candidate.status === "deleting"
        ? candidate.cleanupPreviousStatus || "pending"
        : candidate.status;
    const claimed: any = await SupportAttachment.findOneAndUpdate(
      {
        _id: candidate._id,
        status: candidate.status,
        message: null,
      },
      {
        $set: {
          status: "deleting",
          cleanupStartedAt: now,
          cleanupPreviousStatus: previousStatus,
          cleanupError: null,
        },
        $inc: { cleanupAttempts: 1 },
      },
      { returnDocument: "after" }
    ).lean();
    if (!claimed) {
      result.skipped += 1;
      continue;
    }

    try {
      // S3/R2 DELETE is idempotent even when a pending client never completed
      // its PUT, so absent objects follow the same successful cleanup path.
      const storage = resolvePersistedR2StorageTarget({
        r2Bucket: claimed.r2Bucket,
        r2PublicBaseUrl: claimed.r2PublicBaseUrl,
      });
      if (isCurrentR2StorageTarget(storage)) {
        await deleteFromR2Strict(storage.bucketName, claimed.key);
      }
      await SupportAttachment.deleteOne({ _id: claimed._id, status: "deleting", message: null });
      result.deleted += 1;
    } catch (error: any) {
      result.failed += 1;
      await SupportAttachment.updateOne(
        { _id: claimed._id, status: "deleting", message: null },
        {
          $set: {
            status: previousStatus,
            cleanupError: String(error?.message || error || "R2 deletion failed").slice(0, 1000),
          },
          $unset: { cleanupStartedAt: "", cleanupPreviousStatus: "" },
        }
      );
    }
  }
  return result;
}

let maintenanceRunning = false;

export function startSupportAttachmentMaintenance(): void {
  if (String(process.env.SUPPORT_ATTACHMENT_CLEANUP_ENABLED || "true").toLowerCase() === "false") {
    return;
  }
  const intervalMs = positiveInteger(
    process.env.SUPPORT_ATTACHMENT_CLEANUP_INTERVAL_MS,
    DEFAULT_INTERVAL_MS,
    60_000
  );
  const run = async () => {
    if (maintenanceRunning) return;
    maintenanceRunning = true;
    try {
      const result = await cleanupAbandonedSupportAttachments();
      if (result.deleted || result.failed) {
        console.log("[SupportAttachmentCleanup] completed", result);
      }
    } catch (error) {
      console.error("[SupportAttachmentCleanup] failed", error);
    } finally {
      maintenanceRunning = false;
    }
  };

  const initialRun = setTimeout(() => void run(), 30_000);
  initialRun.unref?.();
  const interval = setInterval(() => void run(), intervalMs);
  interval.unref?.();
}
