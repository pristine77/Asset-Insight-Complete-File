import { sha256Buffer } from "../utils/sha256Buffer.js";
import { uploadBufferToR2 } from "../utils/r2Storage/r2Upload.js";
import {
  publishProposalValuationArtifactsForRevision,
  type ProposalValuationArtifactPublicationResult,
} from "./proposalValuationArtifactPublicationService.js";

export type AssetArtifactBuffer = {
  buffer: Buffer;
  contentType: string;
  key: string;
};

function safeObjectKeySegment(value: unknown, fallback: string): string {
  const segment = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return segment || fallback;
}

/**
 * Asset artifacts are immutable. Different bytes can never share the public
 * object key, while an exact retry reuses the same content-addressed object.
 * This is the storage-side fence for the small race between a lease check and
 * an R2 write: a stale attempt may leave an unreferenced object, but it cannot
 * overwrite bytes already published by the accepted attempt.
 */
export async function buildImmutableAssetArtifactKey(input: {
  reportId: string;
  revision: number;
  baseKey: string;
  buffer: Buffer;
}): Promise<string> {
  const reportId = safeObjectKeySegment(input.reportId, "report");
  const revision = Math.max(0, Math.trunc(Number(input.revision) || 0));
  const filename = safeObjectKeySegment(
    input.baseKey.split("/").pop(),
    "artifact.bin"
  );
  const digest = await sha256Buffer(input.buffer);
  return `previews/asset-generations/${reportId}/revision-${revision}/${digest}-${filename}`;
}

export async function waitForAssetArtifactPublication<T>(input: {
  attempt: () => Promise<ProposalValuationArtifactPublicationResult<T>>;
  maxWaitMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}): Promise<ProposalValuationArtifactPublicationResult<T>> {
  const waitDeadline = Date.now() + Math.max(0, input.maxWaitMs || 0);
  const sleep =
    input.sleep ||
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  while (true) {
    const publication = await input.attempt();
    if (
      publication.published ||
      publication.reason !== "publish-in-progress" ||
      Date.now() >= waitDeadline
    ) {
      return publication;
    }
    const remaining = waitDeadline - Date.now();
    const delay = Math.min(
      remaining,
      Math.max(100, Math.min(publication.retryAfterMs || 1_000, 1_000))
    );
    await sleep(delay);
  }
}

/** Upload immutable buffers, then revision-lease their atomic Mongo publication. */
export async function stageAndPublishAssetArtifactBuffers(input: {
  reportId: string;
  revision: number;
  artifacts: AssetArtifactBuffer[];
  previewFiles?: Record<string, string>;
  previewFileUpdates?: Record<string, string>;
  finalizeSet?: Record<string, unknown>;
  claimFilter?: Record<string, unknown>;
  /** Durable execution-attempt fence checked before every storage write. */
  assertOwned?: () => Promise<void>;
  /** Durable workers can wait through a crashed publisher's short lease. */
  waitForPublishLeaseMs?: number;
}): Promise<ProposalValuationArtifactPublicationResult<void>> {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) throw new Error("R2_BUCKET_NAME is required to save Asset files");

  await input.assertOwned?.();
  await Promise.all(
    input.artifacts.map(async (artifact) => {
      await input.assertOwned?.();
      await uploadBufferToR2(
        artifact.buffer,
        artifact.contentType,
        bucket,
        artifact.key,
        { multipart: true }
      );
      await input.assertOwned?.();
    })
  );
  return waitForAssetArtifactPublication({
    maxWaitMs: input.waitForPublishLeaseMs,
    attempt: async () => {
      await input.assertOwned?.();
      return publishProposalValuationArtifactsForRevision({
        reportId: input.reportId,
        revision: input.revision,
        previewFiles: input.previewFiles,
        previewFileUpdates: input.previewFileUpdates,
        finalizeSet: input.finalizeSet,
        claimFilter: input.claimFilter,
        // Bytes are already immutable and complete. The short lease now only
        // serializes the final URL-map publication with Proposal Valuation edits.
        publish: async ({ renew }) => {
          await input.assertOwned?.();
          await renew();
          await input.assertOwned?.();
        },
      });
    },
  });
}
