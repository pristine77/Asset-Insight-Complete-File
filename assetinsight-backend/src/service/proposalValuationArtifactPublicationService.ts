import crypto from "node:crypto";
import AssetReport from "../models/asset.model.js";

// Keep crash recovery comfortably inside the durable report worker's 3-minute
// lease. Healthy server-side copies renew this short lease every ten seconds.
const ARTIFACT_PUBLISH_LEASE_MS = 60 * 1_000;
const ARTIFACT_PUBLISH_HEARTBEAT_MS = 10 * 1_000;

function revisionCondition(revision: number): Record<string, unknown> {
  if (revision === 0) {
    return {
      $or: [
        { proposal_valuation_revision: 0 },
        { proposal_valuation_revision: { $exists: false } },
        { proposal_valuation_revision: null },
      ],
    };
  }
  return { proposal_valuation_revision: revision };
}

function publishLeaseAvailableCondition(at: Date): Record<string, unknown> {
  return {
    $or: [
      { proposal_valuation_artifact_publish_token: { $exists: false } },
      { proposal_valuation_artifact_publish_token: null },
      { proposal_valuation_artifact_publish_expires_at: { $lte: at } },
    ],
  };
}

/**
 * PV draft writes use the same Mongo condition as artifact publication. While
 * the short publication lease is live, a new revision cannot commit halfway
 * through immutable-object publication and let an older worker publish stale
 * URL pointers over the newer revision.
 */
export function proposalValuationWritableRevisionCondition(
  revision: number,
  at = new Date()
): Record<string, unknown> {
  return {
    $and: [
      revisionCondition(revision),
      publishLeaseAvailableCondition(at),
    ],
  };
}

export type ProposalValuationArtifactPublicationResult<T> =
  | { published: true; value: T }
  | {
      published: false;
      reason: "revision-changed" | "publish-in-progress" | "source-changed";
      currentRevision: number;
      retryAfterMs?: number;
    };

class ProposalValuationArtifactLeaseLostError extends Error {
  constructor() {
    super("Proposal Valuation artifact publication lease was lost");
    this.name = "ProposalValuationArtifactLeaseLostError";
  }
}

function numericRevision(value: unknown): number {
  const revision = Number(value);
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

/**
 * Publish immutable artifact URL pointers for exactly one PV revision.
 *
 * Callers should upload buffers to unique staging keys before entering this
 * lease, then use the callback only for the bounded artifact upload/copy. The
 * lease is revision guarded and all supported PV mutation paths honor it.
 */
export async function publishProposalValuationArtifactsForRevision<T>(input: {
  reportId: string;
  revision: number;
  previewFiles?: Record<string, string>;
  previewFileUpdates?: Record<string, string>;
  finalizeSet?: Record<string, unknown>;
  claimFilter?: Record<string, unknown>;
  publish: (lease: { renew: () => Promise<void> }) => Promise<T>;
}): Promise<ProposalValuationArtifactPublicationResult<T>> {
  const token = crypto.randomUUID();
  const startedAt = new Date();
  const expiresAt = new Date(startedAt.getTime() + ARTIFACT_PUBLISH_LEASE_MS);
  const claimed = await AssetReport.findOneAndUpdate(
    {
      _id: input.reportId,
      ...(input.claimFilter || {}),
      $and: [
        revisionCondition(input.revision),
        publishLeaseAvailableCondition(startedAt),
      ],
    },
    {
      $set: {
        proposal_valuation_artifact_publish_token: token,
        proposal_valuation_artifact_publish_revision: input.revision,
        proposal_valuation_artifact_publish_expires_at: expiresAt,
      },
    },
    { new: true }
  )
    .select("proposal_valuation_revision")
    .lean();

  if (!claimed) {
    const current = await AssetReport.findById(input.reportId)
      .select(
        "proposal_valuation_revision proposal_valuation_artifact_publish_token proposal_valuation_artifact_publish_expires_at"
      )
      .lean();
    const currentRevision = numericRevision(
      (current as any)?.proposal_valuation_revision
    );
    const leaseExpiresAt = (current as any)
      ?.proposal_valuation_artifact_publish_expires_at;
    const hasLiveLease = Boolean(
      (current as any)?.proposal_valuation_artifact_publish_token &&
        leaseExpiresAt &&
        new Date(leaseExpiresAt).getTime() > Date.now()
    );
    return {
      published: false,
      reason:
        currentRevision !== input.revision
          ? "revision-changed"
          : hasLiveLease
            ? "publish-in-progress"
            : input.claimFilter
              ? "source-changed"
              : "revision-changed",
      currentRevision,
      ...(hasLiveLease
        ? {
            retryAfterMs: Math.max(
              100,
              new Date(leaseExpiresAt).getTime() - Date.now()
            ),
          }
        : {}),
    };
  }

  let heartbeatError: unknown;
  let renewalInFlight: Promise<void> | null = null;
  const renew = async () => {
    if (heartbeatError) throw heartbeatError;
    const renewal = await AssetReport.updateOne(
      {
        _id: input.reportId,
        proposal_valuation_artifact_publish_token: token,
        ...(input.claimFilter || {}),
        ...revisionCondition(input.revision),
      },
      {
        $set: {
          proposal_valuation_artifact_publish_expires_at: new Date(
            Date.now() + ARTIFACT_PUBLISH_LEASE_MS
          ),
        },
      }
    );
    if (renewal.matchedCount !== 1) {
      throw new ProposalValuationArtifactLeaseLostError();
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
  }, ARTIFACT_PUBLISH_HEARTBEAT_MS);
  heartbeat.unref?.();

  try {
    const value = await input.publish({ renew });
    if (renewalInFlight) await renewalInFlight;
    if (heartbeatError) throw heartbeatError;
    const previewFileSet = Object.fromEntries(
      Object.entries(input.previewFileUpdates || {}).map(([field, value]) => [
        `preview_files.${field}`,
        value,
      ])
    );
    const finalized = await AssetReport.updateOne(
      {
        _id: input.reportId,
        proposal_valuation_artifact_publish_token: token,
        ...(input.claimFilter || {}),
        ...revisionCondition(input.revision),
      },
      {
        $set: {
          proposal_valuation_published_revision: input.revision,
          proposal_valuation_artifacts_published_at: new Date(),
          ...(input.previewFiles ? { preview_files: input.previewFiles } : {}),
          ...previewFileSet,
          ...(input.finalizeSet || {}),
        },
        $unset: {
          proposal_valuation_artifact_publish_token: 1,
          proposal_valuation_artifact_publish_revision: 1,
          proposal_valuation_artifact_publish_expires_at: 1,
          proposal_valuation_artifact_repair_required: 1,
          proposal_valuation_artifact_repair_revision: 1,
        },
      }
    );
    if (finalized.matchedCount !== 1) {
      throw new ProposalValuationArtifactLeaseLostError();
    }
    return { published: true, value };
  } catch (error) {
    const cleanup = await AssetReport.updateOne(
      {
        _id: input.reportId,
        proposal_valuation_artifact_publish_token: token,
        ...(input.claimFilter || {}),
      },
      {
        $set: {
          files_regeneration_pending: true,
        },
        $unset: {
          proposal_valuation_artifact_publish_token: 1,
          proposal_valuation_artifact_publish_revision: 1,
          proposal_valuation_artifact_publish_expires_at: 1,
          // Legacy releases used a blocking repair marker around mutable
          // object copies. Artifact destinations are immutable now, so a
          // failed attempt must retain old URLs without locking PV forever.
          proposal_valuation_artifact_repair_required: 1,
          proposal_valuation_artifact_repair_revision: 1,
        },
      }
    ).catch(() => undefined);
    // Request-scoped CR/Excel publishers do not otherwise have a durable retry.
    // Best-effort queueing is safe: active workers coalesce this into one
    // follow-up. Old URLs remain authoritative if queueing is unavailable.
    if (cleanup?.matchedCount === 1) {
      try {
        const { queueAssetScheduleSheetRegeneration } = await import(
          "./assetScheduleSheetRegenerationService.js"
        );
        await queueAssetScheduleSheetRegeneration(
          input.reportId,
          input.revision
        );
      } catch {
        // Old published URLs remain valid until another generation succeeds.
      }
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}
