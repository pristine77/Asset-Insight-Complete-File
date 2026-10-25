import crypto from "node:crypto";
import LotListing from "../models/lotListing.model.js";
import {
  copyR2Object,
  deleteFromR2,
  uploadBufferToR2,
} from "../utils/r2Storage/r2Upload.js";

const LOT_LISTING_ARTIFACT_PUBLISH_LEASE_MS = 60 * 1_000;
const LOT_LISTING_ARTIFACT_PUBLISH_HEARTBEAT_MS = 10 * 1_000;

export type LotListingArtifactBuffer = {
  buffer: Buffer;
  contentType: string;
  key: string;
};

export type LotListingArtifactPublicationResult =
  | { published: true; listing: any }
  | {
      published: false;
      reason:
        | "generation-changed"
        | "execution-changed"
        | "publish-in-progress"
        | "already-published"
        | "source-changed";
      listing: any | null;
      retryAfterMs?: number;
    };

class LotListingArtifactPublicationLeaseLostError extends Error {
  constructor() {
    super("Lot Listing artifact publication lease was lost");
    this.name = "LotListingArtifactPublicationLeaseLostError";
  }
}

export function lotListingArtifactPublicationAvailableCondition(
  at = new Date()
): Record<string, unknown> {
  return {
    $or: [
      { artifact_publish_token: { $exists: false } },
      { artifact_publish_token: null },
      { artifact_publish_expires_at: { $exists: false } },
      { artifact_publish_expires_at: { $lte: at } },
    ],
  };
}

export function isLotListingArtifactPublicationLive(
  listing: any,
  at = Date.now()
): boolean {
  const expiresAt = new Date(listing?.artifact_publish_expires_at as any).getTime();
  return Boolean(
    String(listing?.artifact_publish_token || "").trim() &&
      Number.isFinite(expiresAt) &&
      expiresAt > at
  );
}

function sleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Upload complete artifacts to attempt-scoped staging keys, then copy them to
 * immutable attempt-scoped public keys while holding a short report-owned
 * lease. The report's logical generation and execution tokens fence both the
 * publication claim and final Mongo transition. Only the atomic URL update
 * exposes a completed set, so an expired worker cannot replace the winner.
 */
export async function stageAndPublishLotListingArtifacts(input: {
  reportId: string;
  generationToken: string;
  executionToken?: string;
  assertOwned?: () => Promise<void>;
  artifacts: LotListingArtifactBuffer[];
  finalizeSet: Record<string, unknown>;
  finalizeUnset?: string[];
  claimFilter?: Record<string, unknown>;
  waitForPublishLeaseMs?: number;
}): Promise<LotListingArtifactPublicationResult> {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) throw new Error("R2_BUCKET_NAME is required to save Lot Listing files");
  const reportId = String(input.reportId || "").trim();
  const generationToken = String(input.generationToken || "").trim();
  const executionToken = String(input.executionToken || "").trim();
  if (!reportId || !generationToken) {
    throw new Error("A report ID and generation token are required to publish Lot Listing files");
  }

  const stagingPrefix = `lot-listings/.staging/${reportId}/${generationToken}/${crypto.randomUUID()}`;
  const staged = input.artifacts.map((artifact, index) => ({
    ...artifact,
    stagingKey: `${stagingPrefix}/${index}-${artifact.key.split("/").pop()}`,
  }));

  const publicationToken = crypto.randomUUID();
  const waitDeadline = Date.now() + Math.max(0, input.waitForPublishLeaseMs || 0);
  let claimed: any = null;
  try {
    await input.assertOwned?.();
    await Promise.all(
      staged.map((artifact) =>
        uploadBufferToR2(
          artifact.buffer,
          artifact.contentType,
          bucket,
          artifact.stagingKey
        )
      )
    );

    while (!claimed) {
      const now = new Date();
      claimed = await LotListing.findOneAndUpdate(
        {
          _id: reportId,
          job_id: generationToken,
          ...(executionToken
            ? { job_execution_token: executionToken }
            : {}),
          status: "processing",
          job_status: "processing",
          ...(input.claimFilter || {}),
          ...lotListingArtifactPublicationAvailableCondition(now),
        },
        {
          $set: {
            artifact_publish_token: publicationToken,
            artifact_publish_generation_token: generationToken,
            artifact_publish_expires_at: new Date(
              now.getTime() + LOT_LISTING_ARTIFACT_PUBLISH_LEASE_MS
            ),
            // A process death after the first immutable-key copy must remain
            // visible until a retry republishes the complete artifact set.
            artifact_repair_required: true,
          },
        },
        { returnDocument: "after" }
      );
      if (claimed) break;

      const current: any = await LotListing.findById(reportId)
        .select("+job_execution_token")
        .lean();
      if (!current || String(current.job_id || "") !== generationToken) {
        return { published: false, reason: "generation-changed", listing: current };
      }
      if (current.job_status === "done") {
        return { published: false, reason: "already-published", listing: current };
      }
      if (
        executionToken &&
        String(current.job_execution_token || "") !== executionToken
      ) {
        return { published: false, reason: "execution-changed", listing: current };
      }
      if (isLotListingArtifactPublicationLive(current)) {
        const retryAfterMs = Math.max(
          100,
          new Date(current.artifact_publish_expires_at).getTime() - Date.now()
        );
        if (Date.now() < waitDeadline) {
          await sleep(Math.min(1_000, retryAfterMs, waitDeadline - Date.now()));
          continue;
        }
        return {
          published: false,
          reason: "publish-in-progress",
          listing: current,
          retryAfterMs,
        };
      }
      return { published: false, reason: "source-changed", listing: current };
    }

    let heartbeatError: unknown;
    let renewalInFlight: Promise<void> | null = null;
    const renew = async () => {
      if (heartbeatError) throw heartbeatError;
      await input.assertOwned?.();
      const renewal = await LotListing.updateOne(
        {
          _id: reportId,
          job_id: generationToken,
          ...(executionToken
            ? { job_execution_token: executionToken }
            : {}),
          artifact_publish_token: publicationToken,
          artifact_publish_generation_token: generationToken,
        },
        {
          $set: {
            artifact_publish_expires_at: new Date(
              Date.now() + LOT_LISTING_ARTIFACT_PUBLISH_LEASE_MS
            ),
          },
        }
      );
      if (renewal.matchedCount !== 1) {
        throw new LotListingArtifactPublicationLeaseLostError();
      }
    };
    const heartbeat = setInterval(() => {
      if (renewalInFlight || heartbeatError) return;
      renewalInFlight = renew()
        .catch((error) => {
          heartbeatError = error;
        })
        .finally(() => {
          renewalInFlight = null;
        });
    }, LOT_LISTING_ARTIFACT_PUBLISH_HEARTBEAT_MS);
    heartbeat.unref?.();

    try {
      for (const artifact of staged) {
        await renew();
        await copyR2Object(bucket, artifact.stagingKey, artifact.key);
      }
      await renew();
      if (renewalInFlight) await renewalInFlight;
      if (heartbeatError) throw heartbeatError;

      const finalized = await LotListing.findOneAndUpdate(
        {
          _id: reportId,
          job_id: generationToken,
          ...(executionToken
            ? { job_execution_token: executionToken }
            : {}),
          status: "processing",
          ...(input.claimFilter || { job_status: "processing" }),
          artifact_publish_token: publicationToken,
          artifact_publish_generation_token: generationToken,
        },
        {
          $set: input.finalizeSet,
          $unset: {
            artifact_publish_token: 1,
            artifact_publish_generation_token: 1,
            artifact_publish_expires_at: 1,
            artifact_repair_required: 1,
            ...Object.fromEntries(
              (input.finalizeUnset || []).map((field) => [field, 1])
            ),
          },
        },
        { returnDocument: "after" }
      );
      if (!finalized) throw new LotListingArtifactPublicationLeaseLostError();
      return { published: true, listing: finalized };
    } catch (error) {
      await LotListing.updateOne(
        {
          _id: reportId,
          job_id: generationToken,
          ...(executionToken
            ? { job_execution_token: executionToken }
            : {}),
          artifact_publish_token: publicationToken,
          artifact_publish_generation_token: generationToken,
        },
        {
          $set: { artifact_repair_required: true },
          $unset: {
            artifact_publish_token: 1,
            artifact_publish_generation_token: 1,
            artifact_publish_expires_at: 1,
          },
        }
      ).catch(() => undefined);
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  } finally {
    await Promise.all(
      staged.map((artifact) =>
        deleteFromR2(bucket, artifact.stagingKey).catch((error) => {
          // Attempt-scoped staging bytes are unreachable from the report. A
          // cleanup outage must not turn an atomically published report into a
          // failed queue attempt; lifecycle cleanup can remove the orphan.
          console.warn("[LotListing] Failed to clean artifact staging object", {
            reportId,
            generationToken,
            stagingKey: artifact.stagingKey,
            error: error instanceof Error ? error.message : String(error),
          });
        })
      )
    );
  }
}
