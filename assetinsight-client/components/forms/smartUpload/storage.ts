import { openDB, type DBSchema, type IDBPDatabase } from "idb";

export type SmartUploadKind = "asset" | "lot-listing";
export type SmartUploadStage =
  | "selected"
  | "uploading"
  | "classifying"
  | "review"
  | "submitting"
  | "failed";

export type SmartUploadStoredFile = {
  fileId: string;
  name: string;
  type: string;
  size: number;
  lastModified: number;
  originalOrder: number;
  uploaded: boolean;
  url?: string;
};

export type SmartUploadDraftState = {
  version: 1;
  scope: string;
  userId: string;
  kind: SmartUploadKind;
  clientSubmissionId: string;
  sessionId?: string;
  stage: SmartUploadStage;
  details: Record<string, unknown>;
  files: SmartUploadStoredFile[];
  savedAt: string;
};

export type SmartUploadDraft = Omit<SmartUploadDraftState, "files"> & {
  files: Array<SmartUploadStoredFile & { file?: File }>;
};

type StoredSmartMedia = {
  id: string;
  scope: string;
  blob: Blob;
};

interface SmartUploadDatabase extends DBSchema {
  sessions: {
    key: string;
    value: SmartUploadDraftState;
  };
  media: {
    key: string;
    value: StoredSmartMedia;
    indexes: { "by-scope": string };
  };
}

const DATABASE_NAME = "clearvalue-smart-upload";
const DATABASE_VERSION = 1;
const LOCAL_MEDIA_RECOVERY_MAX_BYTES = 256 * 1024 * 1024;
let databasePromise: Promise<IDBPDatabase<SmartUploadDatabase>> | null = null;
let persistenceRequested = false;
// Keeps the active tab usable when IndexedDB is disabled, private-mode quota
// is too small, or a large camera selection cannot be copied locally. This is
// intentionally metadata-only: the live React draft retains the selected File
// objects until R2 confirms them.
const volatileDrafts = new Map<string, SmartUploadDraftState>();

const withRecoveryAvailability = (
  details: Record<string, unknown>,
  available: boolean
) => ({
  ...details,
  smart_upload_local_recovery_available: available,
});

const rememberDraft = (state: SmartUploadDraftState) => {
  volatileDrafts.set(state.scope, state);
  return state;
};

async function deleteMediaForScope(
  database: IDBPDatabase<SmartUploadDatabase>,
  scope: string
) {
  const transaction = database.transaction("media", "readwrite");
  const mediaKeys = await transaction.store.index("by-scope").getAllKeys(scope);
  for (const key of mediaKeys) {
    await transaction.store.delete(key);
  }
  await transaction.done;
}

export function getSmartUploadScope(
  userId: string,
  kind: SmartUploadKind,
  scopeId?: string
) {
  const normalized = String(scopeId || "").trim();
  return `${userId}:${kind}${normalized ? `:${normalized}` : ""}`;
}

async function getDatabase() {
  if (typeof window === "undefined" || !("indexedDB" in window)) {
    throw new Error(
      "Smart Upload recovery storage is unavailable in this browser. Enable site storage and try again."
    );
  }
  if (!databasePromise) {
    databasePromise = openDB<SmartUploadDatabase>(
      DATABASE_NAME,
      DATABASE_VERSION,
      {
        upgrade(database) {
          database.createObjectStore("sessions", { keyPath: "scope" });
          const media = database.createObjectStore("media", { keyPath: "id" });
          media.createIndex("by-scope", "scope");
        },
      }
    ).catch((error) => {
      databasePromise = null;
      throw error;
    });
  }
  return databasePromise;
}

async function requestPersistentStorage() {
  if (persistenceRequested || typeof navigator === "undefined") return;
  persistenceRequested = true;
  try {
    await navigator.storage?.persist?.();
  } catch {
    // Persistence is advisory. IndexedDB remains usable when declined.
  }
}

async function canPersistLocalMedia(totalBytes: number) {
  // Copying a multi-gigabyte camera selection before starting the network
  // upload creates its own long pause and quota pressure. Bound the optional
  // recovery copy while leaving the live upload and server limits independent.
  if (totalBytes > LOCAL_MEDIA_RECOVERY_MAX_BYTES) return false;
  if (typeof navigator === "undefined") return true;
  try {
    const estimate = await navigator.storage?.estimate?.();
    const quota = Number(estimate?.quota);
    const usage = Number(estimate?.usage || 0);
    if (Number.isFinite(quota) && quota > 0) {
      return totalBytes <= Math.max(0, quota - usage) * 0.7;
    }
  } catch {
    // An unavailable estimate does not prove that IndexedDB is unavailable.
  }
  return true;
}

export async function createSmartUploadDraft(args: {
  userId: string;
  kind: SmartUploadKind;
  scopeId?: string;
  clientSubmissionId: string;
  details: Record<string, unknown>;
  files: File[];
}): Promise<SmartUploadDraft> {
  await requestPersistentStorage();
  const scope = getSmartUploadScope(args.userId, args.kind, args.scopeId);
  const records: SmartUploadStoredFile[] = args.files.map((file, index) => ({
    fileId: `images-${index}`,
    name: file.name || `image-${index + 1}`,
    type: file.type || "application/octet-stream",
    size: file.size,
    lastModified: file.lastModified || 0,
    originalOrder: index,
    uploaded: false,
  }));
  const persistMedia = await canPersistLocalMedia(
    args.files.reduce((sum, file) => sum + file.size, 0)
  );
  let state: SmartUploadDraftState = {
    version: 1,
    scope,
    userId: args.userId,
    kind: args.kind,
    clientSubmissionId: args.clientSubmissionId,
    stage: "selected",
    details: withRecoveryAvailability(args.details, persistMedia),
    files: records,
    savedAt: new Date().toISOString(),
  };
  let database: IDBPDatabase<SmartUploadDatabase> | undefined;
  try {
    database = await getDatabase();
    await deleteMediaForScope(database, scope).catch(() => undefined);
    // Persist lightweight metadata first. Every Blob uses its own transaction
    // so the browser never has to stage the entire selection atomically.
    await database.put("sessions", state);
    if (persistMedia) {
      for (let index = 0; index < args.files.length; index += 1) {
        const file = args.files[index];
        const record = records[index];
        await database.put("media", {
          id: `${scope}:${record.fileId}`,
          scope,
          blob: file,
        });
      }
    }
  } catch {
    // Local recovery is an enhancement, not an upload prerequisite. Keep the
    // live File references and record the limitation for an explicit UI warning.
    state = {
      ...state,
      details: withRecoveryAvailability(state.details, false),
      savedAt: new Date().toISOString(),
    };
    if (database) {
      await deleteMediaForScope(database, scope).catch(() => undefined);
      await database.put("sessions", state).catch(() => undefined);
    }
  }
  rememberDraft(state);
  // The picker already supplied these File objects. Returning the same
  // references avoids immediately reading and cloning every Blob back out of
  // IndexedDB after it was persisted.
  return {
    ...state,
    files: records.map((record, index) => ({
      ...record,
      file: args.files[index],
    })),
  };
}

export async function saveServerSmartUploadDraft(args: {
  userId: string;
  kind: SmartUploadKind;
  scopeId?: string;
  clientSubmissionId: string;
  sessionId: string;
  details: Record<string, unknown>;
  stage: SmartUploadStage;
  files: SmartUploadStoredFile[];
}): Promise<SmartUploadDraft> {
  const scope = getSmartUploadScope(args.userId, args.kind, args.scopeId);
  const state: SmartUploadDraftState = {
    version: 1,
    scope,
    userId: args.userId,
    kind: args.kind,
    clientSubmissionId: args.clientSubmissionId,
    sessionId: args.sessionId,
    stage: args.stage,
    details: args.details,
    files: args.files,
    savedAt: new Date().toISOString(),
  };
  rememberDraft(state);
  try {
    const database = await getDatabase();
    await database.put("sessions", state);
  } catch {
    // The authoritative server session remains resumable even when this
    // browser cannot keep a local projection.
  }
  return { ...state, files: state.files.map((file) => ({ ...file })) };
}

export async function updateSmartUploadDraft(
  userId: string,
  kind: SmartUploadKind,
  changes: Partial<
    Pick<
      SmartUploadDraftState,
      "sessionId" | "stage" | "details" | "files"
    >
  >,
  scopeId?: string
) {
  const scope = getSmartUploadScope(userId, kind, scopeId);
  let database: IDBPDatabase<SmartUploadDatabase> | undefined;
  let current: SmartUploadDraftState | undefined;
  try {
    database = await getDatabase();
    current = await database.get("sessions", scope);
  } catch {
    current = undefined;
  }
  current = volatileDrafts.get(scope) || current;
  if (!current) throw new Error("The Smart Upload recovery session is missing.");
  const next: SmartUploadDraftState = {
    ...current,
    ...changes,
    scope,
    userId,
    kind,
    savedAt: new Date().toISOString(),
  };
  if (database) {
    try {
      await database.put("sessions", next);
    } catch {
      if (
        next.stage === "selected" &&
        next.details.smart_upload_local_recovery_available !== false
      ) {
        throw new Error(
          "The updated image order could not be saved safely. Free some browser storage or discard and re-select the images before continuing."
        );
      }
    }
  } else if (
    next.stage === "selected" &&
    next.details.smart_upload_local_recovery_available !== false
  ) {
    throw new Error(
      "The updated image order could not be saved safely. Free some browser storage or discard and re-select the images before continuing."
    );
  }
  rememberDraft(next);
  return next;
}

export async function loadSmartUploadDraft(
  userId: string,
  kind: SmartUploadKind,
  scopeId?: string
): Promise<SmartUploadDraft | null> {
  const scope = getSmartUploadScope(userId, kind, scopeId);
  let state: SmartUploadDraftState | undefined;
  try {
    const database = await getDatabase();
    state = await database.get("sessions", scope);
  } catch {
    state = undefined;
  }
  const volatile = volatileDrafts.get(scope);
  if (
    volatile &&
    (!state || Date.parse(volatile.savedAt) >= Date.parse(state.savedAt))
  ) {
    state = volatile;
  }
  if (state) rememberDraft(state);
  // Keep resume lightweight. Upload workers load at most their concurrency
  // window of original Blobs below instead of cloning the entire selection
  // into page memory during workspace startup.
  return state
    ? { ...state, files: state.files.map((file) => ({ ...file })) }
    : null;
}

export async function loadSmartUploadFile(
  draft: Pick<SmartUploadDraftState, "scope">,
  descriptor: SmartUploadStoredFile
) {
  let media: StoredSmartMedia | undefined;
  try {
    const database = await getDatabase();
    media = await database.get("media", `${draft.scope}:${descriptor.fileId}`);
  } catch {
    return undefined;
  }
  if (!media?.blob) return undefined;
  return new File([media.blob], descriptor.name, {
    type: descriptor.type || media.blob.type,
    lastModified: descriptor.lastModified,
  });
}

export async function releaseSmartUploadMedia(
  userId: string,
  kind: SmartUploadKind,
  scopeId?: string
) {
  const scope = getSmartUploadScope(userId, kind, scopeId);
  try {
    const database = await getDatabase();
    await deleteMediaForScope(database, scope);
  } catch {
    // No local media is also a successful release from the active workflow.
  }
}

export async function deleteSmartUploadDraft(
  userId: string,
  kind: SmartUploadKind,
  scopeId?: string
) {
  const scope = getSmartUploadScope(userId, kind, scopeId);
  volatileDrafts.delete(scope);
  let database: IDBPDatabase<SmartUploadDatabase>;
  try {
    database = await getDatabase();
  } catch {
    return;
  }
  const transaction = database.transaction(["sessions", "media"], "readwrite");
  const mediaKeys = await transaction
    .objectStore("media")
    .index("by-scope")
    .getAllKeys(scope);
  await transaction.objectStore("sessions").delete(scope);
  for (const key of mediaKeys) {
    await transaction.objectStore("media").delete(key);
  }
  await transaction.done;
}
