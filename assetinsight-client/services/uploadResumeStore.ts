import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { FormDraftKind } from "@/components/forms/drafts/storage";
import { assertAuthSessionCurrent, captureAuthSession } from "@/lib/auth-storage";
import { describeOrderedFiles, orderedSubmissionFiles, submissionFilesMatchManifest, type SubmissionFileDescriptor, type SubmissionLotMedia } from "./uploadJobFiles";

// Separate from both the editable-drafts DB and Pristine's metadata-only store.
// One atomic transaction owns the frozen request, form snapshot, and originals.
export const UPLOAD_RESUME_VERSION = 2 as const;
export type UploadResumeRecord = {
  version: typeof UPLOAD_RESUME_VERSION;
  key: string;
  ownerId: string;
  kind: FormDraftKind;
  scopeId?: string;
  endpoint: "/asset" | "/lot-listing";
  details: Record<string, unknown>;
  clientSubmissionId: string;
  sessionId?: string;
  files: SubmissionFileDescriptor[];
  title: string;
  totalFiles: number;
  uploadedFiles: number;
  savedAt: string;
  needsForm?: boolean;
};
type StoredMedia = { key: string; uploadKey: string; blob: Blob; name: string; type: string; size: number; lastModified: number };
interface ResumeDatabase extends DBSchema {
  resumable: { key: string; value: UploadResumeRecord; indexes: { "by-owner": string } };
  snapshots: { key: string; value: { key: string; envelope: unknown; mediaCount: number } };
  media: { key: string; value: StoredMedia; indexes: { "by-upload": string } };
}
const DATABASE_NAME = "cv-upload-snapshots";
let databasePromise: Promise<IDBPDatabase<ResumeDatabase>> | null = null;
export class UploadPersistenceError extends Error {
  constructor(message = "This browser could not safely save the report and original photos for background upload. Keep the form open and retry, or free device storage first.") {
    super(message); this.name = "UploadPersistenceError";
  }
}
export type UploadStoreGuard = { signal?: AbortSignal; isCurrent?: () => boolean };
function guard(options?: UploadStoreGuard) {
  const session = captureAuthSession();
  return () => {
    assertAuthSessionCurrent(session);
    if (options?.signal?.aborted || options?.isCurrent?.() === false) throw new DOMException("Upload was interrupted before it could be safely handed off.", "AbortError");
  };
}
function getDatabase() {
  if (typeof indexedDB === "undefined") throw new UploadPersistenceError("Durable browser storage is unavailable. Keep this form open; enable site storage before starting a background upload.");
  if (!databasePromise) databasePromise = openDB<ResumeDatabase>(DATABASE_NAME, 1, {
    upgrade(database) {
      database.createObjectStore("resumable", { keyPath: "key" }).createIndex("by-owner", "ownerId");
      database.createObjectStore("snapshots", { keyPath: "key" });
      database.createObjectStore("media", { keyPath: "key" }).createIndex("by-upload", "uploadKey");
    },
  }).catch((error) => { databasePromise = null; throw error; });
  return databasePromise;
}
export function resumeKey(ownerId: string, kind: FormDraftKind, scopeId?: string, clientSubmissionId?: string) {
  return JSON.stringify([ownerId, kind, scopeId || "default", clientSubmissionId || ""]);
}
function mediaKey(key: string, index: number) { return `${key}:${index}`; }
function serializeSnapshot(value: unknown, media: readonly File[]): unknown {
  const indexes = new Map<File, number>();
  media.forEach((file, index) => { if (!indexes.has(file)) indexes.set(file, index); });
  const ancestors = new Set<object>();
  const visit = (item: unknown): unknown => {
    if (item instanceof Blob) {
      const index = indexes.get(item as File);
      if (index === undefined) throw new UploadPersistenceError("A photo in this report is missing from its upload list. Keep the form open and review the selected media.");
      return { __cvUploadOriginal: index };
    }
    if (item && typeof item === "object") {
      if (ancestors.has(item)) throw new UploadPersistenceError();
      ancestors.add(item);
      const output = Array.isArray(item) ? item.map(visit) : Object.fromEntries(Object.entries(item).map(([key, field]) => [key, visit(field)]));
      ancestors.delete(item);
      return output;
    }
    if (typeof item === "function" || typeof item === "symbol") throw new UploadPersistenceError();
    return item;
  };
  return visit(value);
}
function hydrateSnapshot(value: unknown, media: File[]): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const marker = value as Record<string, unknown>;
    if (Object.keys(marker).length === 1 && "__cvUploadOriginal" in marker) {
      const index = marker.__cvUploadOriginal;
      if (!Number.isInteger(index) || Number(index) < 0 || !media[Number(index)]) throw new UploadPersistenceError("Some saved original media could not be read. Keep this upload and check Reports before starting again.");
      return media[Number(index)];
    }
    return Object.fromEntries(Object.entries(marker).map(([key, field]) => [key, hydrateSnapshot(field, media)]));
  }
  if (Array.isArray(value)) return value.map((field) => hydrateSnapshot(field, media));
  return value;
}

/** Reject storage/quota failure: a form must not close until this resolves. */
export async function rememberResumableUpload(
  input: Omit<UploadResumeRecord, "version" | "key" | "savedAt">,
  media: readonly File[], draftSnapshot: unknown, options?: UploadStoreGuard,
): Promise<UploadResumeRecord> {
  const current = guard(options); current();
  if (!input.ownerId || !input.clientSubmissionId || input.totalFiles !== media.length || !submissionFilesMatchManifest(describeOrderedFiles(media), input.files).matches) throw new UploadPersistenceError();
  const snapshot = draftSnapshot as { userId?: unknown; kind?: unknown; lots?: unknown; data?: { lots?: unknown } } | null;
  const snapshotLots = input.kind === "lot-listing" ? snapshot?.data?.lots : snapshot?.lots;
  if (!snapshot || snapshot.userId !== input.ownerId || snapshot.kind !== input.kind || !Array.isArray(snapshotLots)) throw new UploadPersistenceError("The saved report does not match the signed-in account. Keep this form open and sign in again before retrying.");
  const snapshotMedia = orderedSubmissionFiles(input.kind, snapshotLots as SubmissionLotMedia[]);
  if (snapshotMedia.length !== media.length || snapshotMedia.some((file, index) => file !== media[index]) || input.endpoint !== (input.kind === "asset" ? "/asset" : "/lot-listing") || (typeof input.details.client_submission_id === "string" && input.details.client_submission_id !== input.clientSubmissionId)) throw new UploadPersistenceError("The saved report does not match its upload identity or media order. Keep the form open and review it before retrying.");
  const key = resumeKey(input.ownerId, input.kind, input.scopeId, input.clientSubmissionId);
  // Clone metadata before the first await; subsequent form edits cannot leak in.
  const record: UploadResumeRecord = { ...JSON.parse(JSON.stringify(input)), key, version: UPLOAD_RESUME_VERSION, savedAt: new Date().toISOString() };
  const envelope = serializeSnapshot(draftSnapshot, media);
  const originals = media.map((file, index): StoredMedia => ({ key: mediaKey(key, index), uploadKey: key, blob: file, name: file.name, type: file.type, size: file.size, lastModified: file.lastModified }));
  try {
    const database = await getDatabase(); current();
    const tx = database.transaction(["resumable", "snapshots", "media"], "readwrite");
    try {
      const previous = await tx.objectStore("resumable").get(key); current();
      // Never mutate a frozen attempt, even if the new files share metadata.
      if (previous) throw new UploadPersistenceError("This upload is already saved. Use Finish upload to continue the original submission; do not submit a changed form under the same identity.");
      await tx.objectStore("resumable").add(record); current();
      await tx.objectStore("snapshots").add({ key, envelope, mediaCount: media.length }); current();
      for (const original of originals) { await tx.objectStore("media").add(original); current(); }
      await tx.done; current();
    } catch (error) { try { tx.abort(); } catch {} await tx.done.catch(() => undefined); throw error; }
    return record;
  } catch (error) {
    current();
    if (error instanceof UploadPersistenceError) throw error;
    throw new UploadPersistenceError();
  }
}

/** Exact immutable snapshot read; never read or overwrite an editable draft. */
export async function loadResumableDraft(record: UploadResumeRecord, options?: UploadStoreGuard): Promise<{ record: UploadResumeRecord; envelope: unknown; media: File[] } | null> {
  const current = guard(options); current();
  const database = await getDatabase(); current();
  const tx = database.transaction(["resumable", "snapshots", "media"], "readonly");
  const saved = await tx.objectStore("resumable").get(record.key); current();
  if (!saved || saved.ownerId !== record.ownerId || saved.clientSubmissionId !== record.clientSubmissionId || saved.kind !== record.kind) return null;
  const snapshot = await tx.objectStore("snapshots").get(record.key); current();
  if (!snapshot || snapshot.mediaCount !== saved.files.length) throw new UploadPersistenceError("Some saved original media could not be read. Keep this upload and check Reports before starting again.");
  const media: File[] = [];
  for (let index = 0; index < snapshot.mediaCount; index++) {
    const original = await tx.objectStore("media").get(mediaKey(record.key, index)); current();
    if (!original || !(original.blob instanceof Blob) || original.blob.size !== original.size) throw new UploadPersistenceError("Some saved original media could not be read. Keep this upload and check Reports before starting again.");
    media.push(new File([original.blob], original.name, { type: original.type, lastModified: original.lastModified }));
  }
  await tx.done; current();
  if (!submissionFilesMatchManifest(describeOrderedFiles(media), saved.files).matches) throw new UploadPersistenceError();
  return { record: saved, envelope: hydrateSnapshot(snapshot.envelope, media), media };
}

async function updateRecord(ownerId: string, kind: FormDraftKind, scopeId: string | undefined, submissionId: string | undefined, update: (row: UploadResumeRecord) => UploadResumeRecord, options?: UploadStoreGuard) {
  // Missing exact identity must never update a newer upload in the same scope.
  if (!submissionId) return;
  const current = guard(options); current(); const database = await getDatabase(); current();
  const tx = database.transaction("resumable", "readwrite");
  try {
    const existing = await tx.store.get(resumeKey(ownerId, kind, scopeId, submissionId)); current();
    if (existing) { await tx.store.put(update(existing)); current(); }
    await tx.done; current();
  } catch (error) { try { tx.abort(); } catch {} await tx.done.catch(() => undefined); throw error; }
}
export function attachResumableSession(ownerId: string, kind: FormDraftKind, scopeId: string | undefined, sessionId: string, submissionId?: string, options?: UploadStoreGuard) {
  return updateRecord(ownerId, kind, scopeId, submissionId, (row) => {
    if (row.sessionId && row.sessionId !== sessionId) throw new UploadPersistenceError("The upload session changed. Check Reports before retrying this upload.");
    return { ...row, sessionId };
  }, options);
}
export function recordResumableProgress(ownerId: string, kind: FormDraftKind, scopeId: string | undefined, uploadedFiles: number, submissionId?: string, options?: UploadStoreGuard) {
  return updateRecord(ownerId, kind, scopeId, submissionId, (row) => ({ ...row, uploadedFiles: Math.max(row.uploadedFiles, Math.min(row.totalFiles, Math.max(0, Math.floor(uploadedFiles)))) }), options);
}
export function markResumableNeedsForm(ownerId: string, kind: FormDraftKind, scopeId: string | undefined, submissionId: string, options?: UploadStoreGuard) {
  return updateRecord(ownerId, kind, scopeId, submissionId, (row) => ({ ...row, needsForm: true }), options);
}
export async function listResumableUploads(ownerId: string): Promise<UploadResumeRecord[]> {
  if (!ownerId) return [];
  const current = guard(); const database = await getDatabase(); current();
  const rows = await database.getAllFromIndex("resumable", "by-owner", ownerId); current();
  return rows.filter((row) => row.version === UPLOAD_RESUME_VERSION).sort((left, right) => right.savedAt.localeCompare(left.savedAt));
}
export async function getResumableUpload(ownerId: string, kind: FormDraftKind, scopeId: string | undefined, submissionId: string, options?: UploadStoreGuard): Promise<UploadResumeRecord | null> {
  const current = guard(options); current(); const database = await getDatabase(); current();
  const record = await database.get("resumable", resumeKey(ownerId, kind, scopeId, submissionId)); current();
  return record || null;
}
/** Only exact, server-accepted attempts or explicit discards may release bytes. */
export async function forgetResumableUpload(ownerId: string, kind: FormDraftKind, scopeId?: string, submissionId?: string, options?: UploadStoreGuard): Promise<void> {
  if (!submissionId) return;
  const current = guard(options); current(); const database = await getDatabase(); current();
  const key = resumeKey(ownerId, kind, scopeId, submissionId);
  const tx = database.transaction(["resumable", "snapshots", "media"], "readwrite");
  try {
    const keys = await tx.objectStore("media").index("by-upload").getAllKeys(key); current();
    for (const mediaId of keys) { await tx.objectStore("media").delete(mediaId); current(); }
    await tx.objectStore("snapshots").delete(key); current();
    await tx.objectStore("resumable").delete(key); current();
    await tx.done; current();
  } catch (error) { try { tx.abort(); } catch {} await tx.done.catch(() => undefined); throw error; }
}
/** Logout intentionally retains recoverable owner-bound originals. */
export async function forgetOwnerResumableUploads(_ownerId: string): Promise<void> { /* Never delete on account changes. */ }
export function resetUploadResumeStoreForTests() { databasePromise = null; }
