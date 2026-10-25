/**
 * Owns draft-media identity, ordering, storage paths, and client-safe serialization.
 * Stable client file ids make upload retries idempotent, while storage keys remain
 * server-controlled so an untrusted filename cannot escape its draft namespace.
 */
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import ReportDraft from "../models/reportDraft.model.js";
import {
  createR2PresignedPutUrl,
  deleteFromR2,
  getCurrentR2StorageTarget,
  getR2PublicUrl,
  headR2Object,
  isR2ObjectNotFoundError,
  resolvePersistedR2StorageTarget,
  uploadFilePathToR2,
} from "../utils/r2Storage/r2Upload.js";

export const MAX_DRAFT_MEDIA = 5000;
const MAX_TARGET_BATCH = 250;
const directBrowserUploadsEnabled =
  String(process.env.R2_BROWSER_DIRECT_UPLOADS_ENABLED || "").toLowerCase() === "true";

export type DraftMediaSlot = "main" | "extra" | "video";

export type NormalizedDraftMedia = {
  clientFileId: string;
  localKey: string;
  mediaId: string;
  lotId: string;
  slot: DraftMediaSlot;
  index: number;
  captureOrder: number;
  originalOrder: number;
  name: string;
  mimeType: string;
  size: number;
  lastModified: number;
  verifiedSize?: number;
  r2Key?: string;
  r2Bucket?: string;
  r2PublicBaseUrl?: string;
  uploadedAt?: Date;
};

const finiteOrder = (value: unknown, fallback: number) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
};

export function normalizeDraftMediaManifest(value: unknown): NormalizedDraftMedia[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_DRAFT_MEDIA) {
    throw Object.assign(new Error(`Draft media manifest cannot exceed ${MAX_DRAFT_MEDIA} entries.`), {
      statusCode: 413,
    });
  }

  const seen = new Set<string>();
  return value.map((item: any, position) => {
    const clientFileId = String(
      item?.clientFileId || item?.mediaId || item?.localKey || `media-${position}`
    )
      .trim()
      .slice(0, 200);
    if (!clientFileId || seen.has(clientFileId)) {
      throw Object.assign(new Error("Every draft media item must have a unique clientFileId."), {
        statusCode: 400,
      });
    }
    seen.add(clientFileId);
    const index = finiteOrder(item?.index, position);
    return {
      clientFileId,
      localKey: String(item?.localKey || clientFileId).slice(0, 240),
      mediaId: String(item?.mediaId || clientFileId).slice(0, 200),
      lotId: String(item?.lotId || "").trim().slice(0, 200),
      slot: (["main", "extra", "video"].includes(String(item?.slot))
        ? String(item.slot)
        : "main") as DraftMediaSlot,
      index,
      captureOrder: finiteOrder(item?.captureOrder, index),
      originalOrder: finiteOrder(item?.originalOrder, position),
      name: String(item?.name || `media-${position + 1}`).slice(0, 300),
      mimeType: String(item?.mimeType || "application/octet-stream").slice(0, 120),
      size: finiteOrder(item?.size, 0),
      lastModified: finiteOrder(item?.lastModified, 0),
    };
  });
}

export function mergeDraftMediaManifest(
  incoming: NormalizedDraftMedia[],
  existingValue: unknown
): NormalizedDraftMedia[] {
  const existing = new Map(
    (Array.isArray(existingValue) ? existingValue : []).map((item: any) => [
      String(item?.clientFileId || item?.mediaId || item?.localKey || ""),
      item,
    ])
  );
  return incoming.map((item) => {
    const stored: any = existing.get(item.clientFileId);
    if (!stored) return item;
    return {
      ...item,
      ...(stored.r2Key ? { r2Key: String(stored.r2Key) } : {}),
      ...(stored.r2Bucket ? { r2Bucket: String(stored.r2Bucket) } : {}),
      ...(stored.r2PublicBaseUrl
        ? { r2PublicBaseUrl: String(stored.r2PublicBaseUrl) }
        : {}),
      ...(stored.uploadedAt ? { uploadedAt: new Date(stored.uploadedAt) } : {}),
      ...(Number.isFinite(Number(stored.verifiedSize))
        ? { verifiedSize: Number(stored.verifiedSize) }
        : {}),
    };
  });
}

export function draftMediaClientValue(item: any) {
  const raw = typeof item?.toObject === "function" ? item.toObject() : item;
  const storageTarget = resolvePersistedR2StorageTarget(raw);
  return {
    ...raw,
    ...(raw?.r2Key && raw?.uploadedAt
      ? { url: getR2PublicUrl(String(raw.r2Key), storageTarget) }
      : {}),
  };
}

export function sortDraftMedia(items: any[]) {
  const slotRank: Record<string, number> = { main: 0, extra: 1, video: 2 };
  return [...items].sort((a, b) => {
    // originalOrder is the canonical client manifest position. Sorting by a
    // mutable lot label (for example lot-10 before lot-2) can move photos into
    // the wrong visual sequence when a draft is restored.
    const original =
      finiteOrder(a?.originalOrder, Number.MAX_SAFE_INTEGER) -
      finiteOrder(b?.originalOrder, Number.MAX_SAFE_INTEGER);
    if (original) return original;
    const lot = String(a?.lotId || "").localeCompare(String(b?.lotId || ""), undefined, {
      numeric: true,
      sensitivity: "base",
    });
    if (lot) return lot;
    const slot = (slotRank[String(a?.slot)] ?? 9) - (slotRank[String(b?.slot)] ?? 9);
    if (slot) return slot;
    return (
      finiteOrder(a?.captureOrder, finiteOrder(a?.index, 0)) -
        finiteOrder(b?.captureOrder, finiteOrder(b?.index, 0)) ||
      finiteOrder(a?.index, 0) - finiteOrder(b?.index, 0)
    );
  });
}

function requireCurrentStorageTarget() {
  const storageTarget = getCurrentR2StorageTarget();
  if (!storageTarget.bucketName) {
    throw Object.assign(new Error("R2 draft storage is not configured."), { statusCode: 503 });
  }
  return storageTarget;
}

const draftMediaStorageIdentity = (item: any): string => {
  const storageTarget = resolvePersistedR2StorageTarget(item);
  return `${storageTarget.generation}:${storageTarget.bucketName}:${String(item?.r2Key || "")}`;
};

async function deleteCurrentDraftMediaObject(item: any): Promise<void> {
  const key = String(item?.r2Key || "").trim();
  if (!key) return;
  const storageTarget = resolvePersistedR2StorageTarget(item);
  if (storageTarget.generation !== "current") return;
  await deleteFromR2(storageTarget.bucketName, key);
}

function safeName(value: string) {
  const extension = path.extname(value || "").replace(/[^a-zA-Z0-9.]/g, "").slice(0, 12);
  const base = path
    .basename(value || "media", path.extname(value || ""))
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return `${base || "media"}${extension}`;
}

export function buildDraftMediaKey(draft: any, item: NormalizedDraftMedia) {
  const digest = crypto.createHash("sha256").update(item.clientFileId).digest("hex").slice(0, 24);
  return `report-drafts/${String(draft.user)}/${String(draft._id)}/${digest}-${safeName(item.name)}`;
}

function buildFreshDraftMediaKey(draft: any, item: NormalizedDraftMedia) {
  const digest = crypto.createHash("sha256").update(item.clientFileId).digest("hex").slice(0, 24);
  // A key that has been removed from the manifest may already be queued for
  // physical deletion. Never reuse it for a later upload: immutable upload
  // generations make a delayed delete incapable of removing newly saved bytes.
  const generation = crypto.randomUUID().replace(/-/g, "");
  return `report-drafts/${String(draft.user)}/${String(draft._id)}/${digest}-${generation}-${safeName(item.name)}`;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  work: (item: T, index: number) => Promise<R>
) {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await work(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

const MAX_MEDIA_MUTATION_ATTEMPTS = 12;

type DraftMediaMutation<T> = {
  media: any[];
  storageMode?: "r2_media";
  value: T;
};

function plainMedia(value: unknown): any[] {
  return (Array.isArray(value) ? value : []).map((item: any) =>
    typeof item?.toObject === "function"
      ? item.toObject({ depopulate: true, versionKey: false, virtuals: false })
      : { ...(item || {}) }
  );
}

function mediaRevisionFilter(revision: number): Record<string, unknown> {
  return revision > 0
    ? { mediaRevision: revision }
    : {
        $or: [
          { mediaRevision: 0 },
          { mediaRevision: null },
          { mediaRevision: { $exists: false } },
        ],
      };
}

function isPersistedReportDraft(draft: any): boolean {
  return Boolean(
    draft?._id &&
      draft?.constructor?.modelName === ReportDraft.modelName &&
      draft?.isNew === false
  );
}

async function commitDraftMediaMutation<T>(
  draft: any,
  build: (current: any) => Promise<DraftMediaMutation<T>> | DraftMediaMutation<T>
): Promise<{ draft: any; value: T }> {
  // Small unit tests and migration helpers use document-like values without a
  // Mongo identity. Keep that seam while every HTTP path uses the fenced CAS.
  if (!isPersistedReportDraft(draft)) {
    const mutation = await build(draft);
    if (mutation.media.length > MAX_DRAFT_MEDIA) {
      throw Object.assign(
        new Error(`Draft media manifest cannot exceed ${MAX_DRAFT_MEDIA} entries.`),
        { statusCode: 413 }
      );
    }
    draft.media = mutation.media;
    if (mutation.storageMode) draft.storageMode = mutation.storageMode;
    await draft.save();
    return { draft, value: mutation.value };
  }

  const ownerId = draft.user?._id || draft.user;
  for (let attempt = 0; attempt < MAX_MEDIA_MUTATION_ATTEMPTS; attempt += 1) {
    const current: any = await ReportDraft.findOne({
      _id: draft._id,
      user: ownerId,
      promotedAt: null,
      promotionToken: null,
    }).select("+mediaRevision");
    if (!current) {
      throw Object.assign(
        new Error("This draft was deleted or moved while its media was changing."),
        { code: "DRAFT_MEDIA_NOT_MUTABLE", statusCode: 409 }
      );
    }

    const expectedRevision = Math.max(0, Number(current.mediaRevision) || 0);
    const mutation = await build(current);
    if (mutation.media.length > MAX_DRAFT_MEDIA) {
      throw Object.assign(
        new Error(`Draft media manifest cannot exceed ${MAX_DRAFT_MEDIA} entries.`),
        { statusCode: 413 }
      );
    }
    const updated: any = await ReportDraft.findOneAndUpdate(
      {
        _id: current._id,
        user: ownerId,
        promotedAt: null,
        promotionToken: null,
        ...mediaRevisionFilter(expectedRevision),
      },
      {
        $set: {
          media: mutation.media,
          ...(mutation.storageMode ? { storageMode: mutation.storageMode } : {}),
          mediaRevision: expectedRevision + 1,
        },
      },
      { new: true, runValidators: true }
    ).select("+mediaRevision");
    if (updated) return { draft: updated, value: mutation.value };
  }

  throw Object.assign(
    new Error("Draft media changed repeatedly in another request. Retry this save."),
    { code: "DRAFT_MEDIA_CONFLICT", statusCode: 409 }
  );
}

export async function createDraftMediaTargets(draft: any, value: unknown) {
  const manifest = normalizeDraftMediaManifest(value);
  if (manifest.length > MAX_TARGET_BATCH) {
    throw Object.assign(
      new Error(`Request upload targets in batches of ${MAX_TARGET_BATCH} or fewer.`),
      { statusCode: 413 }
    );
  }
  const committed = await commitDraftMediaMutation(draft, async (current) => {
    const currentMedia = plainMedia(current.media);
    const merged = mergeDraftMediaManifest(manifest, currentMedia);
    const existingById = new Map(
      currentMedia.map((item: any) => [String(item.clientFileId), item])
    );
    const targets = await mapWithConcurrency(merged, 8, async (item) => {
      const stored: any = existingById.get(item.clientFileId);
      let storageTarget = stored?.r2Key
        ? resolvePersistedR2StorageTarget(stored)
        : requireCurrentStorageTarget();
      if (stored?.r2Key) {
        try {
          const head = await headR2Object(
            storageTarget.bucketName,
            String(stored.r2Key)
          );
          if (!item.size || Number(head.size || 0) === item.size) {
            return {
              clientFileId: item.clientFileId,
              r2Key: String(stored.r2Key),
              r2Bucket: storageTarget.bucketName,
              r2PublicBaseUrl: storageTarget.publicBaseUrl,
              url: getR2PublicUrl(String(stored.r2Key), storageTarget),
              alreadyUploaded: true,
            };
          }
        } catch (error) {
          if (!isR2ObjectNotFoundError(error)) throw error;
          // Definitively missing objects rotate to the writable generation below.
        }
        // Never repair a missing or mismatched legacy object in place. A fresh
        // upload must go to current storage so old bucket objects stay immutable.
        if (storageTarget.generation === "legacy") {
          storageTarget = requireCurrentStorageTarget();
        }
      }
      // Reaching this point means there is no verified reusable object. Even
      // in the current bucket, never overwrite or reuse the prior key: an
      // in-flight delete/failed upload may still target that immutable
      // generation.
      const r2Key = buildFreshDraftMediaKey(current, item);
      return {
        clientFileId: item.clientFileId,
        r2Key,
        r2Bucket: storageTarget.bucketName,
        r2PublicBaseUrl: storageTarget.publicBaseUrl,
        // Direct PUT is opt-in because a presigned URL is unusable unless the
        // bucket has a matching browser CORS rule. The multipart proxy streams
        // to the same R2 key and is the reliable default for every deployment.
        ...(directBrowserUploadsEnabled
          ? {
              uploadUrl: await createR2PresignedPutUrl(
                storageTarget.bucketName,
                r2Key,
                item.mimeType
              ),
            }
          : {}),
        alreadyUploaded: false,
      };
    });

    const targetById = new Map<string, (typeof targets)[number]>(
      targets.map((target) => [target.clientFileId, target])
    );
    const currentById = new Map<string, any>(
      currentMedia.map((item: any) => [String(item.clientFileId), item])
    );
    for (const item of merged) {
      const target = targetById.get(item.clientFileId)!;
      currentById.set(item.clientFileId, {
        ...item,
        r2Key: target.r2Key,
        r2Bucket: target.r2Bucket,
        r2PublicBaseUrl: target.r2PublicBaseUrl,
        ...(target.alreadyUploaded
          ? {
              uploadedAt: currentById.get(item.clientFileId)?.uploadedAt || new Date(),
              verifiedSize:
                currentById.get(item.clientFileId)?.verifiedSize ?? item.size,
            }
          : { uploadedAt: undefined, verifiedSize: undefined }),
      });
    }
    return {
      media: Array.from(currentById.values()),
      storageMode: "r2_media" as const,
      value: targets,
    };
  });
  return committed.value;
}

export async function confirmDraftMedia(draft: any, clientFileIds: unknown) {
  const ids = Array.isArray(clientFileIds)
    ? [...new Set(clientFileIds.map((value) => String(value || "").trim()).filter(Boolean))]
    : [];
  if (!ids.length || ids.length > MAX_TARGET_BATCH) {
    throw Object.assign(
      new Error(`Confirm between 1 and ${MAX_TARGET_BATCH} draft media items per request.`),
      { statusCode: 400 }
    );
  }
  const idSet = new Set(ids);
  const committed = await commitDraftMediaMutation(draft, async (current) => {
    const currentMedia = plainMedia(current.media);
    const selected = currentMedia.filter((item: any) =>
      idSet.has(String(item.clientFileId))
    );
    if (selected.length !== ids.length) {
      throw Object.assign(new Error("One or more draft media items do not belong to this draft."), {
        statusCode: 400,
      });
    }
    const verified = await mapWithConcurrency(selected, 6, async (item: any) => {
      if (!item.r2Key) throw new Error(`No upload target exists for ${item.name || "media"}.`);
      const storageTarget = resolvePersistedR2StorageTarget(item);
      const head = await headR2Object(
        storageTarget.bucketName,
        String(item.r2Key)
      );
      const expectedSize = Number(item.size || 0);
      const actualSize = Number(head.size || 0);
      if (expectedSize && actualSize !== expectedSize) {
        throw new Error(`Uploaded size does not match ${item.name || "media"}.`);
      }
      return { id: String(item.clientFileId), actualSize };
    });
    const verifiedById = new Map(verified.map((item) => [item.id, item.actualSize]));
    return {
      media: currentMedia.map((item: any) =>
        verifiedById.has(String(item.clientFileId))
          ? {
              ...item,
              verifiedSize: verifiedById.get(String(item.clientFileId)),
              uploadedAt: new Date(),
            }
          : item
      ),
      storageMode: "r2_media" as const,
      value: undefined,
    };
  });
  return sortDraftMedia(plainMedia(committed.draft.media).map(draftMediaClientValue));
}

export async function uploadMultipartDraftMedia(
  draft: any,
  files: Express.Multer.File[],
  metadataValue: unknown,
  replace: boolean
) {
  const metadata = normalizeDraftMediaManifest(metadataValue);
  if (!files.length || files.length !== metadata.length) {
    throw Object.assign(new Error("Every uploaded draft file requires matching metadata."), {
      statusCode: 400,
    });
  }
  const currentStorageTarget = requireCurrentStorageTarget();
  const uploadedForCleanup: any[] = [];
  let committed = false;
  try {
    // Multipart retries use immutable object generations. Reusing a removed
    // key lets a concurrent/deferred delete erase the new bytes, and overwriting
    // an existing key before the whole batch succeeds corrupts the last valid
    // draft. A losing pre-commit request can safely delete only its fresh keys.
    const uploadResults = await mapWithConcurrency(files, 3, async (file, index) => {
      const item = metadata[index];
      const r2Key = buildFreshDraftMediaKey(draft, item);
      try {
        await uploadFilePathToR2(
          file.path,
          item.mimeType || file.mimetype || "application/octet-stream",
          currentStorageTarget.bucketName,
          r2Key,
          file.size,
          { preventOverwrite: true }
        );
        const uploadedItem = {
          ...item,
          size: file.size || item.size,
          verifiedSize: file.size || item.size,
          r2Key,
          r2Bucket: currentStorageTarget.bucketName,
          r2PublicBaseUrl: currentStorageTarget.publicBaseUrl,
          uploadedAt: new Date(),
        };
        uploadedForCleanup.push(uploadedItem);
        return { item: uploadedItem };
      } catch (error) {
        return { error };
      } finally {
        await fs.rm(file.path, { force: true }).catch(() => undefined);
      }
    });
    const failedUpload = uploadResults.find((result) => result.error);
    if (failedUpload?.error) throw failedUpload.error;
    const uploaded = uploadResults.map((result) => result.item!);

    const mutation = await commitDraftMediaMutation(draft, (current) => {
      const oldMedia = plainMedia(current.media).filter((item: any) =>
        String(item?.r2Key || "").trim()
      );
      const next = replace
        ? uploaded
        : (() => {
            // Mobile clients upload large drafts in bounded batches. Preserve
            // every concurrently committed row and replace only this batch.
            const byId = new Map<string, any>();
            for (const item of plainMedia(current.media)) {
              byId.set(String(item.clientFileId), item);
            }
            for (const item of uploaded) byId.set(item.clientFileId, item);
            return Array.from(byId.values());
          })();
      const retained = new Set(
        next
          .filter((item) => String(item?.r2Key || "").trim())
          .map(draftMediaStorageIdentity)
      );
      return {
        media: next,
        storageMode: "r2_media" as const,
        value: {
          removed: oldMedia.filter(
            (item: any) => !retained.has(draftMediaStorageIdentity(item))
          ),
        },
      };
    });
    committed = true;
    await deleteDraftMediaObjects(mutation.value.removed);
    return sortDraftMedia(
      plainMedia(mutation.draft.media).map(draftMediaClientValue)
    );
  } catch (error) {
    if (!committed) await deleteDraftMediaObjects(uploadedForCleanup);
    throw error;
  }
}

export async function deleteDraftMediaObjects(media: any[]) {
  const byIdentity = new Map<string, any>();
  for (const item of media || []) {
    if (!String(item?.r2Key || "").trim()) continue;
    byIdentity.set(draftMediaStorageIdentity(item), item);
  }
  await mapWithConcurrency(
    [...byIdentity.values()],
    6,
    deleteCurrentDraftMediaObject
  );
}

export async function deleteSelectedDraftMedia(draft: any, idsValue: unknown) {
  const ids = new Set(
    (Array.isArray(idsValue) ? idsValue : []).map((value) => String(value || "").trim()).filter(Boolean)
  );
  if (!ids.size) throw Object.assign(new Error("clientFileIds is required."), { statusCode: 400 });
  const mutation = await commitDraftMediaMutation(draft, (current) => {
    const currentMedia = plainMedia(current.media);
    return {
      media: currentMedia.filter((item: any) => !ids.has(String(item.clientFileId))),
      value: {
        removed: currentMedia.filter((item: any) => ids.has(String(item.clientFileId))),
      },
    };
  });
  await deleteDraftMediaObjects(mutation.value.removed);
  return sortDraftMedia(
    plainMedia(mutation.draft.media).map(draftMediaClientValue)
  );
}
