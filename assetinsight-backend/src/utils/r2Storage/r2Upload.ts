import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { config } from "dotenv";

config();

const IMMUTABLE_LEGACY_R2_BUCKET_NAME = "sellsnap";
const IMMUTABLE_LEGACY_R2_PUBLIC_URL = "https://images.sellsnap.store";

export type R2StorageGeneration = "current" | "legacy";

export type R2StorageTarget = {
  bucketName: string;
  publicBaseUrl: string;
  generation: R2StorageGeneration;
};

export type R2ObjectLocation = R2StorageTarget & {
  key: string;
};

const trimPublicBaseUrl = (value: string): string => value.trim().replace(/\/+$/, "");

const normalizePublicBaseUrl = (value: string, variableName: string): string => {
  const trimmed = trimPublicBaseUrl(value);
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${variableName} must be a valid HTTPS URL.`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `${variableName} must be an HTTPS public base URL without credentials, a query, or a fragment.`
    );
  }
  // A trailing DNS root dot addresses the same host. Canonicalize it so the
  // protected legacy origin cannot be relabeled through an equivalent spelling.
  parsed.hostname = parsed.hostname.replace(/\.+$/, "");
  const pathname = parsed.pathname.replace(/\/+$/, "");
  return `${parsed.origin}${pathname === "/" ? "" : pathname}`;
};

const publicNamespacesOverlap = (first: string, second: string): boolean => {
  const firstUrl = new URL(`${first}/`);
  const secondUrl = new URL(`${second}/`);
  if (firstUrl.origin !== secondUrl.origin) return false;
  const firstPath = firstUrl.pathname.replace(/\/+$/, "");
  const secondPath = secondUrl.pathname.replace(/\/+$/, "");
  return (
    firstPath === secondPath ||
    firstPath === "" ||
    secondPath === "" ||
    firstPath.startsWith(`${secondPath}/`) ||
    secondPath.startsWith(`${firstPath}/`)
  );
};

/**
 * Resolve and validate both storage generations as one atomic configuration.
 * Overlapping namespaces are rejected because URL-based cleanup could otherwise
 * classify a legacy object as current and delete the same key in the new bucket.
 */
export const assertValidR2StorageConfiguration = (): {
  current: R2StorageTarget;
  legacy: R2StorageTarget;
} => {
  const primaryBucket = String(process.env.R2_BUCKET_NAME || "").trim();
  const aliasBucket = String(process.env.R2_BUCKET || "").trim();
  if (!primaryBucket) throw new Error("R2_BUCKET_NAME is required.");
  if (aliasBucket && primaryBucket !== aliasBucket) {
    throw new Error("R2_BUCKET_NAME and R2_BUCKET must identify the same bucket.");
  }
  const bucketName = primaryBucket;

  const primaryPublicUrl = String(process.env.R2_PUBLIC_URL || "").trim();
  const aliasPublicUrl = String(process.env.R2_CUSTOM_DOMAIN || "").trim();
  if (!primaryPublicUrl) throw new Error("R2_PUBLIC_URL is required.");
  const normalizedPrimary = primaryPublicUrl
    ? normalizePublicBaseUrl(primaryPublicUrl, "R2_PUBLIC_URL")
    : "";
  const normalizedAlias = aliasPublicUrl
    ? normalizePublicBaseUrl(aliasPublicUrl, "R2_CUSTOM_DOMAIN")
    : "";
  if (normalizedPrimary && normalizedAlias && normalizedPrimary !== normalizedAlias) {
    throw new Error(
      "R2_PUBLIC_URL and R2_CUSTOM_DOMAIN conflict; remove or update the stale alias."
    );
  }

  const current: R2StorageTarget = {
    bucketName,
    publicBaseUrl: normalizedPrimary,
    generation: "current",
  };
  const legacyBucketName = String(process.env.R2_LEGACY_BUCKET_NAME || "").trim();
  const legacyPublicUrl = String(process.env.R2_LEGACY_PUBLIC_URL || "").trim();
  if (!legacyBucketName) throw new Error("R2_LEGACY_BUCKET_NAME is required.");
  if (!legacyPublicUrl) throw new Error("R2_LEGACY_PUBLIC_URL is required.");
  const legacy: R2StorageTarget = {
    bucketName: legacyBucketName,
    publicBaseUrl: normalizePublicBaseUrl(
      legacyPublicUrl,
      "R2_LEGACY_PUBLIC_URL"
    ),
    generation: "legacy",
  };

  if (current.bucketName === legacy.bucketName) {
    throw new Error("Current and legacy R2 buckets must be different.");
  }
  if (publicNamespacesOverlap(current.publicBaseUrl, legacy.publicBaseUrl)) {
    throw new Error("Current and legacy R2 public URL namespaces must not overlap.");
  }
  if (current.bucketName === IMMUTABLE_LEGACY_R2_BUCKET_NAME) {
    throw new Error(
      `${IMMUTABLE_LEGACY_R2_BUCKET_NAME} is permanently legacy and cannot be configured as current storage.`
    );
  }
  if (
    publicNamespacesOverlap(
      current.publicBaseUrl,
      IMMUTABLE_LEGACY_R2_PUBLIC_URL
    )
  ) {
    throw new Error(
      `${IMMUTABLE_LEGACY_R2_PUBLIC_URL} is permanently legacy and cannot be configured as the current public URL.`
    );
  }
  return { current, legacy };
};

export const getCurrentR2StorageTarget = (): R2StorageTarget =>
  assertValidR2StorageConfiguration().current;

export const getLegacyR2StorageTarget = (): R2StorageTarget =>
  assertValidR2StorageConfiguration().legacy;

// Configure the R2 (S3-compatible) client
const s3 = new S3Client({
  region: process.env.R2_REGION ?? "auto",
  endpoint: process.env.R2_ENDPOINT!,
  forcePathStyle: true, // Required for Cloudflare R2 compatibility
  // R2 does not require request checksums for presigned PUTs. Disabling the
  // SDK's optional checksum query parameters keeps browser preflights simple
  // and avoids compatibility issues between SDK and presigner versions.
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
});

const MAX_R2_OBJECT_KEY_BYTES = 1024;

const assertPersistedR2ObjectKey = (key: string): string => {
  if (
    !key ||
    Buffer.byteLength(key, "utf8") > MAX_R2_OBJECT_KEY_BYTES ||
    /[\u0000-\u001f\u007f]/.test(key)
  ) {
    throw new Error(
      `R2 object key must be non-empty, control-free, and no more than ${MAX_R2_OBJECT_KEY_BYTES} UTF-8 bytes.`
    );
  }
  return key;
};

const assertCanonicalR2ObjectKey = (key: string): string => {
  assertPersistedR2ObjectKey(key);
  const segments = key.split("/");
  if (
    key.startsWith("/") ||
    key.endsWith("/") ||
    segments.some(
      (segment) => !segment || segment === "." || segment === ".." || segment.includes("\\")
    )
  ) {
    throw new Error("R2 object key must be a canonical relative path.");
  }
  return key;
};

const buildR2PublicUrl = (key: string, target: R2StorageTarget): string => {
  const trimmedBase = trimPublicBaseUrl(target.publicBaseUrl);
  if (target.generation === "legacy") {
    // Preserve the pre-cutover URL contract for historical opaque S3 keys.
    // SDK reads use the exact persisted key; this URL is intentionally not
    // canonicalized or rewritten because existing clients may already store it.
    const persistedKey = assertPersistedR2ObjectKey(key).replace(/^\/+/, "");
    return `${trimmedBase}/${persistedKey}`;
  }

  const canonicalKey = assertCanonicalR2ObjectKey(key);
  return `${trimmedBase}/${canonicalKey
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`;
};

async function streamToBuffer(stream: any, maxBytes?: number): Promise<Buffer> {
  const assertWithinLimit = (size: number) => {
    if (maxBytes !== undefined && size > maxBytes) {
      throw new Error(`R2 object exceeds the ${maxBytes}-byte read limit`);
    }
  };
  if (
    stream instanceof Readable ||
    (stream && typeof stream[Symbol.asyncIterator] === "function")
  ) {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      assertWithinLimit(totalBytes);
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }

  if (stream && typeof stream.transformToByteArray === "function") {
    const buffer = Buffer.from(await stream.transformToByteArray());
    assertWithinLimit(buffer.length);
    return buffer;
  }

  if (stream && typeof stream.arrayBuffer === "function") {
    const buffer = Buffer.from(await stream.arrayBuffer());
    assertWithinLimit(buffer.length);
    return buffer;
  }

  return Buffer.alloc(0);
}

const getCurrentR2StorageTargetForWrite = (bucketName: string): R2StorageTarget => {
  if (bucketName === IMMUTABLE_LEGACY_R2_BUCKET_NAME) {
    throw new Error("The immutable legacy R2 bucket is read-only.");
  }
  const { current, legacy } = assertValidR2StorageConfiguration();
  if (bucketName === legacy.bucketName) {
    throw new Error("Legacy R2 storage is read-only.");
  }
  if (bucketName !== current.bucketName) {
    throw new Error("R2 writes are allowed only in the active current bucket.");
  }
  return current;
};

/**
 * Resolve persisted key-only storage metadata. New records must snapshot the
 * current target. Records created before the storage cutover have no snapshot,
 * so they deliberately resolve to the legacy, read-only generation.
 */
export const resolvePersistedR2StorageTarget = (
  value?: { r2Bucket?: unknown; r2PublicBaseUrl?: unknown } | null
): R2StorageTarget => {
  const current = getCurrentR2StorageTarget();
  const legacy = getLegacyR2StorageTarget();
  const bucketName = String(value?.r2Bucket || "").trim();
  const publicBaseUrl = trimPublicBaseUrl(String(value?.r2PublicBaseUrl || ""));

  if (!bucketName && !publicBaseUrl) return legacy;

  if (
    bucketName === current.bucketName &&
    (!publicBaseUrl || publicBaseUrl === current.publicBaseUrl)
  ) {
    return current;
  }
  if (
    bucketName === legacy.bucketName &&
    (!publicBaseUrl || publicBaseUrl === legacy.publicBaseUrl)
  ) {
    return legacy;
  }
  throw new Error("Persisted R2 storage target is not an allowed storage generation");
};

export const getR2PublicUrl = (
  key: string,
  target: R2StorageTarget = getCurrentR2StorageTarget()
): string => {
  const resolvedTarget = resolvePersistedR2StorageTarget({
    r2Bucket: target.bucketName,
    r2PublicBaseUrl: target.publicBaseUrl,
  });
  if (resolvedTarget.generation !== target.generation) {
    throw new Error("R2 public URL target generation does not match its storage target.");
  }
  return buildR2PublicUrl(key, resolvedTarget);
};

const parseR2ObjectLocation = (
  value: string,
  target: R2StorageTarget
): R2ObjectLocation | null => {
  try {
    if (value !== value.trim()) return null;
    const parsed = new URL(value);
    const base = new URL(`${target.publicBaseUrl}/`);
    if (
      parsed.protocol !== "https:" ||
      parsed.origin !== base.origin ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }

    const rawPath =
      value.match(/^[a-z][a-z\d+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i)?.[1] || "/";
    const decodedRawPath = decodeURIComponent(rawPath);
    if (
      decodedRawPath.includes("\\") ||
      decodedRawPath.split("/").some((part) => part === "..")
    ) {
      return null;
    }

    const basePath = base.pathname.replace(/\/+$/, "");
    if (basePath && !parsed.pathname.startsWith(`${basePath}/`)) return null;
    const encodedKey = parsed.pathname.slice(basePath.length).replace(/^\/+/, "");
    const encodedSegments = encodedKey.split("/");
    const decodedSegments = encodedSegments.map((segment) => decodeURIComponent(segment));
    if (
      !encodedKey ||
      decodedSegments.some(
        (segment) =>
          !segment ||
          segment === "." ||
          segment === ".." ||
          segment.includes("/") ||
          segment.includes("\\")
      )
    ) {
      return null;
    }
    const key = decodedSegments.join("/");
    return { ...target, key };
  } catch {
    return null;
  }
};

/** Resolve only the two owned R2 origins. Unknown hosts are never treated as R2. */
export const resolveR2ObjectLocationFromUrl = (value: string): R2ObjectLocation | null =>
  parseR2ObjectLocation(value, getCurrentR2StorageTarget()) ||
  parseR2ObjectLocation(value, getLegacyR2StorageTarget());

/**
 * Resolve an object only when it belongs to the active writable generation.
 * Destructive callers must use this helper so a legacy URL can never delete a
 * same-named object from the new bucket.
 */
export const resolveCurrentR2ObjectLocationFromUrl = (
  value: string
): R2ObjectLocation | null =>
  parseR2ObjectLocation(value, getCurrentR2StorageTarget());

export const isCurrentR2StorageTarget = (
  target: Pick<R2StorageTarget, "bucketName" | "publicBaseUrl">
): boolean => {
  const current = getCurrentR2StorageTarget();
  return (
    target.bucketName === current.bucketName &&
    trimPublicBaseUrl(target.publicBaseUrl) === current.publicBaseUrl
  );
};

const isLegacyReadOnlyBucket = (bucketName: string): boolean => {
  if (bucketName === IMMUTABLE_LEGACY_R2_BUCKET_NAME) return true;
  const legacy = getLegacyR2StorageTarget();
  return bucketName === legacy.bucketName;
};

/**
 * Historical R2 keys are opaque S3 identifiers. Pre-cutover callers did not
 * enforce canonical URL path syntax, so legacy reads must preserve those keys
 * byte-for-byte even when they contain backslashes, repeated slashes, or dot
 * segments. Current-generation keys remain canonical by construction.
 */
export const validateR2ObjectKeyForRead = (
  bucketName: string,
  key: string
): string =>
  isLegacyReadOnlyBucket(bucketName)
    ? assertPersistedR2ObjectKey(key)
    : assertCanonicalR2ObjectKey(key);

type R2WriteOptions = {
  /** Opt in only for immutable direct publication, never staged copy paths. */
  multipart?: boolean;
  /** Reject a PUT when the key already exists instead of replacing it. */
  preventOverwrite?: boolean;
  /** Optional exact-length binding for restricted native upload capabilities. */
  contentLength?: number;
};

const parsePositiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const R2_WRITE_MAX_ATTEMPTS = Math.min(
  10,
  parsePositiveInteger(process.env.R2_WRITE_MAX_ATTEMPTS, 5)
);
const R2_WRITE_RETRY_BASE_MS = Math.min(
  5_000,
  parsePositiveInteger(process.env.R2_WRITE_RETRY_BASE_MS, 400)
);
const R2_TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const R2_TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "INTERNALERROR",
  "INTERNAL_ERROR",
  "REQUESTTIMEOUT",
  "REQUEST_TIMEOUT",
  "SLOWDOWN",
  "SERVICEUNAVAILABLE",
  "THROTTLING",
  "THROTTLINGEXCEPTION",
]);

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const getR2ErrorStatus = (error: any): number | undefined => {
  const status = Number(error?.$metadata?.httpStatusCode ?? error?.statusCode ?? error?.status);
  return Number.isFinite(status) && status > 0 ? status : undefined;
};

export const isR2ObjectNotFoundError = (error: any): boolean => {
  if (getR2ErrorStatus(error) === 404) return true;
  const code = String(error?.code || error?.name || "")
    .replace(/[\s-]+/g, "")
    .toUpperCase();
  return code === "NOSUCHKEY" || code === "NOTFOUND";
};

/** Exported for focused policy tests without making the configured S3 client public. */
export const isRetryableR2WriteError = (error: any): boolean => {
  const status = getR2ErrorStatus(error);
  if (status && R2_TRANSIENT_HTTP_STATUSES.has(status)) return true;
  const code = String(error?.code || error?.name || "")
    .replace(/[\s-]+/g, "")
    .toUpperCase();
  return R2_TRANSIENT_ERROR_CODES.has(code);
};

const r2ObjectMatchesSize = async (
  bucketName: string,
  key: string,
  expectedSize: number
): Promise<boolean> => {
  try {
    const head = await headR2Object(bucketName, key);
    return Number(head.size) === expectedSize;
  } catch {
    return false;
  }
};

type R2PutBody = {
  body: Buffer | Readable;
  dispose?: () => void;
};

const R2_STREAM_PART_SIZE_BYTES = 8 * 1024 * 1024;
const R2_STREAM_QUEUE_SIZE = 2;
export const R2_BUFFER_MULTIPART_THRESHOLD_BYTES = 64 * 1024 * 1024;

function* bufferUploadChunks(buffer: Buffer): Generator<Buffer> {
  for (let offset = 0; offset < buffer.length; offset += R2_STREAM_PART_SIZE_BYTES) {
    yield buffer.subarray(offset, Math.min(offset + R2_STREAM_PART_SIZE_BYTES, buffer.length));
  }
}

/** Bounded signing inputs; publish only after every part and completion succeed. */
async function putBufferMultipart(input: {
  bucketName: string; key: string; contentType: string; buffer: Buffer;
}): Promise<void> {
  const created = await s3.send(new CreateMultipartUploadCommand({
    Bucket: input.bucketName, Key: input.key, ContentType: input.contentType,
  }));
  const uploadId = created.UploadId;
  if (!uploadId) throw new Error("R2 did not return a multipart upload identifier");
  try {
    const parts: Array<{ ETag: string; PartNumber: number }> = [];
    const batchBytes = R2_STREAM_PART_SIZE_BYTES * R2_STREAM_QUEUE_SIZE;
    for (let offset = 0; offset < input.buffer.length; offset += batchBytes) {
      const pending: Array<Promise<{ ETag: string; PartNumber: number }>> = [];
      for (let slot = 0; slot < R2_STREAM_QUEUE_SIZE; slot += 1) {
        const start = offset + slot * R2_STREAM_PART_SIZE_BYTES;
        if (start >= input.buffer.length) break;
        const body = input.buffer.subarray(start, Math.min(start + R2_STREAM_PART_SIZE_BYTES, input.buffer.length));
        const partNumber = Math.floor(start / R2_STREAM_PART_SIZE_BYTES) + 1;
        pending.push((async () => {
          const result = await s3.send(new UploadPartCommand({
            Bucket: input.bucketName, Key: input.key, UploadId: uploadId,
            PartNumber: partNumber, Body: body, ContentLength: body.length,
          }));
          if (!result.ETag) throw new Error("R2 did not confirm an uploaded part");
          return { ETag: result.ETag, PartNumber: partNumber };
        })());
      }
      // Settle siblings before aborting, so no late part can outlive cleanup.
      const settled = await Promise.allSettled(pending);
      const failure = settled.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      for (const result of settled) if (result.status === "fulfilled") parts.push(result.value);
    }
    await s3.send(new CompleteMultipartUploadCommand({
      Bucket: input.bucketName, Key: input.key, UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }));
  } catch (error) {
    // Complete can also fail after R2 committed. Abort is best-effort; the
    // existing retry wrapper reconciles transient/ambiguous outcomes with HEAD.
    try {
      await s3.send(new AbortMultipartUploadCommand({ Bucket: input.bucketName, Key: input.key, UploadId: uploadId }));
    } catch {
      console.warn("[R2] Could not confirm multipart cleanup", { key: input.key });
    }
    throw error;
  }
}

/**
 * R2 can transiently return InternalError after accepting a PUT. Node streams
 * are one-use bodies, so the AWS SDK cannot safely replay them by itself. Each
 * attempt below creates a fresh body and verifies ambiguous writes with HEAD.
 */
const putR2ObjectWithRetry = async (input: {
  bucketName: string;
  key: string;
  contentType: string;
  expectedSize: number;
  preventOverwrite: boolean;
  multipart?: boolean;
  createBody: () => R2PutBody;
}): Promise<void> => {
  getCurrentR2StorageTargetForWrite(input.bucketName);
  assertCanonicalR2ObjectKey(input.key);
  let lastError: unknown;

  for (let attempt = 1; attempt <= R2_WRITE_MAX_ATTEMPTS; attempt += 1) {
    const uploadBody = input.createBody();
    const multipart = input.multipart === true && !input.preventOverwrite;
    const boundedBody = Buffer.isBuffer(uploadBody.body) && uploadBody.body.length >= R2_BUFFER_MULTIPART_THRESHOLD_BYTES && !multipart
      ? Readable.from(bufferUploadChunks(uploadBody.body), { objectMode: false })
      : undefined;
    try {
      if (multipart && Buffer.isBuffer(uploadBody.body) && uploadBody.body.length >= R2_BUFFER_MULTIPART_THRESHOLD_BYTES) {
        await putBufferMultipart({ ...input, buffer: uploadBody.body });
      } else await s3.send(
        new PutObjectCommand({
          Bucket: input.bucketName,
          Key: input.key,
          Body: boundedBody || uploadBody.body,
          ContentType: input.contentType,
          ContentLength: input.expectedSize,
          ...(input.preventOverwrite ? { IfNoneMatch: "*" } : {}),
        })
      );
      return;
    } catch (error) {
      lastError = error;
    } finally {
      boundedBody?.destroy();
      uploadBody.dispose?.();
    }

    const retryable = isRetryableR2WriteError(lastError);
    // A transient response can be lost after R2 committed the complete object.
    // Never use this verification to hide authorization or validation errors.
    if (
      retryable &&
      (await r2ObjectMatchesSize(input.bucketName, input.key, input.expectedSize))
    ) {
      return;
    }

    if (!retryable || attempt >= R2_WRITE_MAX_ATTEMPTS) {
      throw lastError;
    }

    const exponentialDelay = Math.min(
      8_000,
      R2_WRITE_RETRY_BASE_MS * 2 ** (attempt - 1)
    );
    const jitter = Math.floor(Math.random() * Math.max(50, exponentialDelay * 0.2));
    console.warn("[R2] Retrying transient object write", {
      key: input.key,
      attempt: attempt + 1,
      maxAttempts: R2_WRITE_MAX_ATTEMPTS,
      status: getR2ErrorStatus(lastError),
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    await sleep(exponentialDelay + jitter);
  }

  throw lastError;
};

export type R2StreamingUpload = {
  /** Resolves only after R2 has durably completed the single or multipart PUT. */
  done: () => Promise<void>;
  /** Cancels in-flight requests and removes multipart parts when possible. */
  abort: () => Promise<void>;
};

/**
 * Start a bounded, backpressured upload from an incoming Node stream.
 *
 * `Upload` switches between a regular PUT and multipart upload without ever
 * materializing the complete object. Two 8 MiB parts cap SDK buffering at
 * roughly 16 MiB per active request while still allowing useful R2 parallelism.
 * The caller owns metadata validation and must await `done()` before publishing
 * the object URL.
 */
export const createR2StreamingUpload = (input: {
  bucketName: string;
  key: string;
  body: Readable;
  contentType: string;
  contentLength: number;
}): R2StreamingUpload => {
  getCurrentR2StorageTargetForWrite(input.bucketName);
  assertCanonicalR2ObjectKey(input.key);
  const abortController = new AbortController();
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: input.bucketName,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      ContentLength: input.contentLength,
    },
    abortController,
    queueSize: R2_STREAM_QUEUE_SIZE,
    partSize: R2_STREAM_PART_SIZE_BYTES,
    leavePartsOnError: false,
  });

  return {
    done: async () => {
      await upload.done();
    },
    abort: async () => {
      abortController.abort();
      await upload.abort();
    },
  };
};

export const createR2PresignedPutUrl = async (
  bucketName: string,
  key: string,
  contentType: string,
  // Large mobile reports can take longer than an hour on a weak connection.
  // The session remains authenticated and object keys stay scoped to that session.
  expiresInSeconds = 4 * 60 * 60,
  options: R2WriteOptions = {}
): Promise<string> => {
  getCurrentR2StorageTargetForWrite(bucketName);
  return signR2Put(bucketName, key, contentType, expiresInSeconds, options);
};

const signR2Put = async (bucketName: string, key: string, contentType: string, expiresInSeconds: number, options: R2WriteOptions): Promise<string> => {
  assertCanonicalR2ObjectKey(key);
  if (options.contentLength !== undefined && (!Number.isSafeInteger(options.contentLength) || options.contentLength < 1)) {
    throw new Error("A presigned original must have a positive byte length.");
  }
  return getSignedUrl(
    s3 as any,
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      ContentType: contentType,
      ...(options.preventOverwrite ? { IfNoneMatch: "*" } : {}),
      ...(options.contentLength !== undefined ? { ContentLength: options.contentLength } : {}),
    }),
    { expiresIn: expiresInSeconds }
  );
};

/** Backup originals must never use either publicly served report bucket. */
export function getCaptureBackupR2Bucket(): string {
  const bucket = String(process.env.CAPTURE_BACKUP_R2_BUCKET || "").trim();
  const { current, legacy } = assertValidR2StorageConfiguration();
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) || [current.bucketName, legacy.bucketName, IMMUTABLE_LEGACY_R2_BUCKET_NAME].includes(bucket)) {
    throw new Error("A separate private CAPTURE_BACKUP_R2_BUCKET must be configured.");
  }
  return bucket;
}
function assertCaptureBackupTarget(bucket: string, key: string) {
  if (bucket !== getCaptureBackupR2Bucket() || !/^capture-backups\/[a-f\d]{24}\/[a-f\d]{24}\/[a-f\d]{64}$/.test(key)) {
    throw new Error("The original is outside configured private capture backup storage.");
  }
}
export async function createCaptureBackupPresignedPutUrl(bucket: string, key: string, mimeType: string, size: number, expiresInSeconds: number) {
  assertCaptureBackupTarget(bucket, key);
  return signR2Put(bucket, key, mimeType, expiresInSeconds, { preventOverwrite: true, contentLength: size });
}
export async function headCaptureBackupObject(bucket: string, key: string) {
  assertCaptureBackupTarget(bucket, key);
  return headR2Object(bucket, key, { timeoutMs: 15000 });
}
export async function streamCaptureBackupObject(bucket: string, key: string, options: { ifMatch?: string } = {}) {
  assertCaptureBackupTarget(bucket, key);
  return getR2ObjectStream(bucket, key, { ...options, timeoutMs: 60000 });
}

export const headR2Object = async (
  bucketName: string,
  key: string,
  options: {
    /**
     * Abort the HEAD after this long. Without it a request whose socket stalls
     * waits indefinitely; upload completion checks every photo of a report and
     * shares a 120 s window with the mobile app and the proxy, so it passes a
     * bound. Omitted, the call behaves exactly as before.
     */
    timeoutMs?: number;
  } = {}
): Promise<{
  size?: number;
  contentType?: string;
  lastModified?: Date;
  etag?: string;
}> => {
  validateR2ObjectKeyForRead(bucketName, key);
  const result = await s3.send(
    new HeadObjectCommand({
      Bucket: bucketName,
      Key: key,
    }),
    options.timeoutMs && options.timeoutMs > 0
      ? { abortSignal: AbortSignal.timeout(options.timeoutMs) }
      : undefined
  );
  return {
    size: result.ContentLength,
    contentType: result.ContentType,
    lastModified: result.LastModified,
    etag: result.ETag,
  };
};

export const readR2ObjectBuffer = async (
  bucketName: string,
  key: string,
  maxBytes?: number
): Promise<Buffer> => {
  validateR2ObjectKeyForRead(bucketName, key);
  const result = await s3.send(
    new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    })
  );
  if (
    maxBytes !== undefined &&
    Number.isFinite(Number(result.ContentLength)) &&
    Number(result.ContentLength) > maxBytes
  ) {
    // Abort before buffering or decoding attacker-controlled oversized input.
    (result.Body as any)?.destroy?.();
    throw new Error(`R2 object exceeds the ${maxBytes}-byte read limit`);
  }
  return streamToBuffer(result.Body, maxBytes);
};

/** Bounded, version-checked video chunks; no full original copy or JS video blob. */
export const readR2ObjectRange = async (
  bucketName: string, key: string, offset: number, length: number, etag: string
): Promise<Buffer> => {
  if (!bucketName || resolvePersistedR2StorageTarget({ r2Bucket: bucketName }).bucketName !== bucketName) {
    throw new Error("The video source is not in an allowed storage generation.");
  }
  validateR2ObjectKeyForRead(bucketName, key);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) ||
    length < 1 || length > 8 * 1024 * 1024 || !Number.isSafeInteger(offset + length - 1) || !etag) throw new Error("Invalid video source range.");
  const result = await s3.send(new GetObjectCommand({
    Bucket: bucketName, Key: key, Range: `bytes=${offset}-${offset + length - 1}`, IfMatch: etag,
  }), { abortSignal: AbortSignal.timeout(60_000) });
  if (result.ContentLength !== length || result.ETag !== etag) {
    (result.Body as any)?.destroy?.();
    throw new Error("The saved video source changed. Review the report before retrying.");
  }
  const bytes = await streamToBuffer(result.Body, length);
  if (bytes.length !== length) throw new Error("The saved video source was incomplete.");
  return bytes;
};

export type R2ObjectStream = {
  stream: Readable;
  contentType?: string;
  contentLength?: number;
  etag?: string;
};

/**
 * Return an R2 object as a Node stream. Authenticated API routes use this for
 * private draft restoration so browser clients never depend on public-domain
 * CORS headers and large photos are not buffered in application memory.
 */
export const getR2ObjectStream = async (
  bucketName: string,
  key: string,
  options: { timeoutMs?: number; ifMatch?: string } = {}
): Promise<R2ObjectStream> => {
  validateR2ObjectKeyForRead(bucketName, key);
  const result = await s3.send(
    new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
      ...(options.ifMatch ? { IfMatch: options.ifMatch } : {}),
    }),
    options.timeoutMs ? { abortSignal: AbortSignal.timeout(options.timeoutMs) } : undefined
  );
  const body: any = result.Body;
  let stream: Readable;
  if (body instanceof Readable) stream = body;
  else if (body && typeof body[Symbol.asyncIterator] === "function") {
    stream = Readable.from(body);
  } else if (body && typeof body.transformToByteArray === "function") {
    stream = Readable.from(Buffer.from(await body.transformToByteArray()));
  } else {
    throw new Error("R2 returned an unreadable object stream");
  }
  return {
    stream,
    contentType: result.ContentType,
    contentLength: result.ContentLength,
    etag: result.ETag,
  };
};

/**
 * Stream a durable R2 source object to a local worker file without buffering
 * the object in Node memory. CRM imports use this before row streaming.
 */
export const downloadR2ObjectToFile = async (
  bucketName: string,
  key: string,
  destinationPath: string
): Promise<void> => {
  const { stream } = await getR2ObjectStream(bucketName, key);
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  await pipeline(stream, fs.createWriteStream(destinationPath));
};

/**
 * Hash an R2 object as a stream so large APK files never need to be buffered in
 * application memory during release finalization.
 */
export const sha256R2Object = async (
  bucketName: string,
  key: string
): Promise<string> => {
  validateR2ObjectKeyForRead(bucketName, key);
  const result = await s3.send(
    new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    })
  );
  const hash = crypto.createHash("sha256");
  const body: any = result.Body;

  if (body && typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) {
      hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
  } else if (body && typeof body.transformToByteArray === "function") {
    hash.update(Buffer.from(await body.transformToByteArray()));
  } else {
    throw new Error("R2 returned an unreadable APK object stream");
  }

  return hash.digest("hex");
};

/**
 * Function to upload a file to Cloudflare R2.
 * @param file The file to be uploaded (from multer)
 * @param bucketName The R2 bucket name
 * @returns A promise with the uploaded file's URL.
 */
export const uploadToR2 = async (
  file: Express.Multer.File,
  bucketName: string,
  fileName: string
): Promise<string> => {
  // Read file content (support both diskStorage and memoryStorage)
  let fileContent: Buffer;
  let usedPath: string | null = null;
  const anyFile = file as any;

  if (anyFile?.buffer && Buffer.isBuffer(anyFile.buffer)) {
    // Memory storage path
    fileContent = anyFile.buffer as Buffer;
  } else {
    // Disk storage: resolve possible locations robustly
    const candidates: string[] = [];
    if (typeof (file as any)?.path === "string") {
      candidates.push((file as any).path);
    }
    if (typeof (file as any)?.destination === "string" && typeof file.filename === "string") {
      const dest = (file as any).destination as string;
      const joined = path.isAbsolute(dest)
        ? path.join(dest, file.filename)
        : path.resolve(process.cwd(), dest, file.filename);
      candidates.push(joined);
    }
    if (typeof file.filename === "string") {
      candidates.push(path.resolve(process.cwd(), "uploads", file.filename));
      candidates.push(path.resolve(process.cwd(), "server", "uploads", file.filename));
    }

    let found: string | undefined;
    for (const p of candidates) {
      try {
        if (p && fs.existsSync(p)) {
          found = p;
          break;
        }
      } catch {}
    }
    if (!found) {
      throw new Error(
        `Local upload temp file not found; tried: ${candidates.filter(Boolean).join(" | ")}`
      );
    }
    usedPath = found;
    fileContent = fs.readFileSync(found);
  }

  try {
    const storageTarget = getCurrentR2StorageTargetForWrite(bucketName);
    assertCanonicalR2ObjectKey(fileName);
    await s3.send(
      new PutObjectCommand({
        Bucket: bucketName,
        Key: fileName,
        Body: fileContent,
        ContentType: file.mimetype,
      })
    );
    // Clean up the temporary file from disk
    try {
      if (usedPath) fs.unlinkSync(usedPath);
    } catch {}
    return getR2PublicUrl(fileName, storageTarget);
  } catch (error: any) {
    // Clean up the temporary file in case of an error
    try {
      if (usedPath) fs.unlinkSync(usedPath);
    } catch {}
    throw new Error(`Error uploading to R2: ${error.message}`);
  }
};

/**
 * Upload a raw Buffer directly to R2 with a provided content type.
 */
export const uploadBufferToR2 = async (
  buffer: Buffer,
  contentType: string,
  bucketName: string,
  fileName: string,
  options: R2WriteOptions = {}
): Promise<string> => {
  const storageTarget = getCurrentR2StorageTargetForWrite(bucketName);
  await putR2ObjectWithRetry({
    bucketName,
    key: fileName,
    contentType,
    expectedSize: buffer.length,
    preventOverwrite: options.preventOverwrite === true,
    multipart: options.multipart === true,
    // The retry wrapper creates a fresh bounded single-PUT stream by default,
    // retaining single-part ETags for staging/copy users and atomic IfNoneMatch.
    createBody: () => ({ body: buffer }),
  });
  return getR2PublicUrl(fileName, storageTarget);
};

/**
 * Promote an already durable object to a stable key with a server-side copy.
 * Preview workers stage complete buffers before taking their short publication
 * lease, so large client-to-R2 uploads never extend that critical section.
 */
export const copyR2Object = async (
  bucketName: string,
  sourceKey: string,
  destinationKey: string
): Promise<string> => {
  const storageTarget = getCurrentR2StorageTargetForWrite(bucketName);
  assertCanonicalR2ObjectKey(sourceKey);
  assertCanonicalR2ObjectKey(destinationKey);
  const source = await headR2Object(bucketName, sourceKey);
  const expectedSize = Number(source.size);
  const expectedEtag = String(source.etag || "").replace(/"/g, "");
  let lastError: unknown;

  for (let attempt = 1; attempt <= R2_WRITE_MAX_ATTEMPTS; attempt += 1) {
    try {
      const copied = await s3.send(
        new CopyObjectCommand({
          Bucket: bucketName,
          CopySource: `${bucketName}/${sourceKey}`,
          Key: destinationKey,
          MetadataDirective: "COPY",
        })
      );
      const copiedEtag = String(copied.CopyObjectResult?.ETag || "").replace(
        /"/g,
        ""
      );
      if (expectedEtag && copiedEtag && copiedEtag !== expectedEtag) {
        throw new Error(
          `R2 copy fingerprint mismatch for ${sourceKey} -> ${destinationKey}`
        );
      }
      return getR2PublicUrl(destinationKey, storageTarget);
    } catch (error) {
      lastError = error;
    }

    const retryable = isRetryableR2WriteError(lastError);
    if (retryable && Number.isFinite(expectedSize) && expectedEtag) {
      try {
        const destination = await headR2Object(bucketName, destinationKey);
        const destinationEtag = String(destination.etag || "").replace(
          /"/g,
          ""
        );
        if (
          Number(destination.size) === expectedSize &&
          destinationEtag === expectedEtag
        ) {
          return getR2PublicUrl(destinationKey, storageTarget);
        }
      } catch {
        // Retry the ambiguous copy when the canonical object cannot be proven
        // byte-identical to this run's staged source.
      }
    }
    if (!retryable || attempt >= R2_WRITE_MAX_ATTEMPTS) throw lastError;

    const exponentialDelay = Math.min(
      8_000,
      R2_WRITE_RETRY_BASE_MS * 2 ** (attempt - 1)
    );
    const jitter = Math.floor(
      Math.random() * Math.max(50, exponentialDelay * 0.2)
    );
    await sleep(exponentialDelay + jitter);
  }

  throw lastError;
};

/**
 * Upload a local file path to R2 as a stream. This is used for large artifacts
 * such as APK releases so Node does not need to keep the whole file in memory.
 */
export const uploadFilePathToR2 = async (
  filePath: string,
  contentType: string,
  bucketName: string,
  fileName: string,
  sizeBytes?: number,
  options: R2WriteOptions = {}
): Promise<string> => {
  const storageTarget = getCurrentR2StorageTargetForWrite(bucketName);
  const expectedSize =
    typeof sizeBytes === "number" && Number.isSafeInteger(sizeBytes) && sizeBytes >= 0
      ? sizeBytes
      : (await fs.promises.stat(filePath)).size;
  await putR2ObjectWithRetry({
    bucketName,
    key: fileName,
    contentType,
    expectedSize,
    preventOverwrite: options.preventOverwrite === true,
    createBody: () => {
      const stream = fs.createReadStream(filePath);
      return {
        body: stream,
        dispose: () => {
          if (!stream.destroyed) stream.destroy();
        },
      };
    },
  });
  return getR2PublicUrl(fileName, storageTarget);
};

/**
 * Delete a file from R2 storage.
 * @param bucketName The R2 bucket name
 * @param key The file key (path) to delete
 */
export const deleteFromR2 = async (
  bucketName: string,
  key: string
): Promise<void> => {
  if (isLegacyReadOnlyBucket(bucketName)) {
    console.info(`[R2] Preserved legacy object: ${key}`);
    return;
  }
  assertCanonicalR2ObjectKey(key);
  const current = getCurrentR2StorageTarget();
  if (bucketName !== current.bucketName) {
    console.warn(`[R2] Refused delete outside the active current bucket: ${key}`);
    return;
  }
  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: bucketName,
        Key: key,
      })
    );
    console.log(`[R2] Deleted: ${key}`);
  } catch (error: any) {
    console.warn(`[R2] Failed to delete ${key}: ${error.message}`);
    // Don't throw - deletion failure shouldn't block the workflow
  }
};

/**
 * Delete an R2 object and surface failures to durable job workers so they can
 * retry. Existing callers intentionally keep the best-effort helper above.
 */
export const deleteFromR2Strict = async (
  bucketName: string,
  key: string
): Promise<void> => {
  if (isLegacyReadOnlyBucket(bucketName)) {
    console.info(`[R2] Preserved legacy object: ${key}`);
    return;
  }
  assertCanonicalR2ObjectKey(key);
  const current = getCurrentR2StorageTarget();
  if (bucketName !== current.bucketName) {
    throw new Error("R2 deletes are allowed only in the active current bucket.");
  }
  await s3.send(
    new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key,
    })
  );
  console.log(`[R2] Deleted: ${key}`);
};

/**
 * Extract the R2 key from a URL on one of the two explicitly owned origins.
 * Destructive callers must use resolveCurrentR2ObjectLocationFromUrl instead.
 * E.g., "https://images.sellsnap.store/previews/file.docx?v=123" -> "previews/file.docx"
 */
export const extractR2KeyFromUrl = (url: string): string | null =>
  resolveR2ObjectLocationFromUrl(url)?.key || null;
