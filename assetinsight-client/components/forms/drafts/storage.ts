import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { activityBatch, activityCounts, observeActivity, type ActivityState, type DeviceActivity } from "@/lib/reportActivityObservation";

export const FORM_DRAFT_VERSION = 3 as const;
export const LEGACY_FORM_DRAFT_VERSION = 2 as const;

export function browserActivityState(value: unknown): ActivityState {
  const envelope = value as Record<string, any>;
  const form = envelope.formData || envelope.data || {};
  const lots = (envelope.lots || form.lots || []) as Array<Record<string, any>>;
  const photo = (item: any) => ({ id: String(item?.id || item?.clientFileId || item?.mediaId || "not-recorded"), camera: false });
  return { lots: lots.map(lot => ({ id: lot.id, lotNumber: String(lot.lotNumber || ""),
    main: (lot.files || lot.mainImages || []).map(photo), extra: (lot.extraFiles || lot.extraImages || []).map(photo),
    cover: Number.isInteger(lot.coverIndex) ? lot.coverIndex : null })),
    activeLot: lots[envelope.activeLotIdx || form.activeLotIdx || 0]?.id || null,
    logo: typeof form.watermarkImages === "boolean" ? form.watermarkImages : null, mode: "online", status: "local" };
}

export async function pendingBrowserActivity(owner: string) {
  const database = await getDatabase();
  const rows = await database.getAllFromIndex("activity", "by-owner", owner, 100);
  return activityBatch(rows.map(row => row.event));
}
export async function acknowledgeBrowserActivity(owner: string, ids: string[]) {
  const database = await getDatabase();
  const tx = database.transaction("activity", "readwrite");
  for (const id of ids.slice(0, 100)) await tx.store.delete(`${owner}:${id}`);
  await tx.done;
}

export type FormDraftKind = "asset" | "lot-listing";

export type ScopedDraftEnvelope = {
  version: number;
  kind: FormDraftKind;
  userId: string;
  revision: number;
  savedAt: string;
};

type MediaMarker = {
  __cvDraftMediaV3: true;
  id: string;
};

type StoredMedia = {
  id: string;
  scope: string;
  blob: Blob;
  name: string;
  type: string;
  size: number;
  lastModified: number;
};

type StoredDraft = {
  scope: string;
  envelope: unknown;
  mediaIds: string[];
  savedAt: string;
};

interface DraftDatabase extends DBSchema {
  activitySnapshots: { key: string; value: { id: string; state: ActivityState; revision: number } };
  activity: {
    key: string;
    value: { id: string; owner: string; event: DeviceActivity };
    indexes: { "by-owner": string };
  };
  drafts: {
    key: string;
    value: StoredDraft;
  };
  media: {
    key: string;
    value: StoredMedia;
    indexes: { "by-scope": string };
  };
}

export type LoadedScopedDraft<T> = {
  envelope: T;
  missingMediaCount: number;
};

export type ScopedDraftSummary = {
  kind: FormDraftKind;
  userId: string;
  scopeId?: string;
  revision: number;
  savedAt: string;
  contractNo: string;
  lotCount: number;
  mediaCount: number;
};

export class DraftEnvelopeError extends Error {
  constructor(
    message: string,
    readonly code:
      | "corrupt"
      | "unsupported-version"
      | "wrong-kind"
      | "wrong-user"
  ) {
    super(message);
    this.name = "DraftEnvelopeError";
  }
}

export class DraftPersistenceError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "DraftPersistenceError";
  }
}

const DB_NAME = "clearvalue-form-drafts";
const DB_VERSION = 3;
let databasePromise: Promise<IDBPDatabase<DraftDatabase>> | null = null;
let persistenceRequested = false;
const mediaIdByBlob = new WeakMap<Blob, string>();

export async function recordBrowserObservation(owner: string, activityId: string, kind: FormDraftKind, contract: string, lots: Array<{ id: string; lotNumber?: string; files: File[]; extraFiles?: File[]; coverIndex: number }>, logo: boolean, baseline = false) {
  const scope = scopeFor(owner, kind, activityId);
  const photo = (file: File) => {
    const id = mediaIdByBlob.get(file) || createMediaId(scope, file.name);
    mediaIdByBlob.set(file, id); return { id, camera: false };
  };
  const state: ActivityState = { lots: lots.map(lot => ({ id: lot.id, lotNumber: String(lot.lotNumber || ""),
    main: lot.files.map(photo), extra: (lot.extraFiles || []).map(photo), cover: lot.coverIndex })), activeLot: null, logo, mode: "online", status: "local" };
  const database = await getDatabase();
  const tx = database.transaction(["activity", "activitySnapshots"], "readwrite");
  const previous = await tx.objectStore("activitySnapshots").get(scope);
  // Mount/restore establishes current state; it must not invent removals while
  // hydration replaces an empty form, or replay imports already saved yesterday.
  const observations = baseline
    ? previous ? [] : observeActivity(null, state).filter(event => event.action === "history_started")
    : observeActivity(previous?.state || null, state).filter(event => event.action !== "draft_saved");
  const revision = (previous?.revision || 0) + 1;
  for (const [index, observation] of observations.entries()) {
    const event: DeviceActivity = { ...observation, eventId: `observe:${activityId}:${revision}:${index}`, activityId,
      reportType: kind === "asset" ? "asset" : "lotListing", contract, source: "web", sequence: revision, sequenceScope: scope, observedAt: new Date().toISOString() };
    await tx.objectStore("activity").add({ id: `${owner}:${event.eventId}`, owner, event });
  }
  await tx.objectStore("activitySnapshots").put({ id: scope, state, revision });
  await tx.done;
}

function normalizeScopeId(scopeId?: string) {
  const normalized = String(scopeId || "").trim();
  return normalized ? `:${normalized}` : "";
}

function scopeFor(userId: string, kind: FormDraftKind, scopeId?: string) {
  return `${userId}:${kind}${normalizeScopeId(scopeId)}`;
}

function assertBrowserStorage() {
  if (typeof window === "undefined" || !("indexedDB" in window)) {
    throw new DraftPersistenceError(
      "Durable draft storage is unavailable in this browser. Keep this form open or enable site storage before continuing."
    );
  }
}

function getDatabase() {
  assertBrowserStorage();
  if (!databasePromise) {
    databasePromise = openDB<DraftDatabase>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        if (!database.objectStoreNames.contains("drafts")) database.createObjectStore("drafts", { keyPath: "scope" });
        if (!database.objectStoreNames.contains("media")) {
          const media = database.createObjectStore("media", { keyPath: "id" });
          media.createIndex("by-scope", "scope");
        }
        if (!database.objectStoreNames.contains("activity")) database.createObjectStore("activity", { keyPath: "id" }).createIndex("by-owner", "owner");
        if (!database.objectStoreNames.contains("activitySnapshots")) database.createObjectStore("activitySnapshots", { keyPath: "id" });
      },
    }).catch((error) => {
      databasePromise = null;
      throw new DraftPersistenceError(
        "The browser could not open durable draft storage. Check site-storage permissions and try again.",
        error
      );
    });
  }
  return databasePromise;
}

function hashIdentity(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function createMediaId(scope: string, identity: string) {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) return `${scope}:${randomId}`;
  return `${scope}:${hashIdentity(`${identity}|${Date.now()}|${Math.random()}`)}`;
}

function isMediaMarker(value: unknown): value is MediaMarker {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as MediaMarker).__cvDraftMediaV3 === true &&
      typeof (value as MediaMarker).id === "string"
  );
}

async function serializeValue(
  value: unknown,
  path: string,
  scope: string,
  media: Map<string, StoredMedia>
): Promise<unknown> {
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    const file = value as File;
    const name = typeof file.name === "string" ? file.name : `media-${path}`;
    const lastModified = Number(file.lastModified || 0);
    const existingId = mediaIdByBlob.get(value);
    const identity = `${scope}|${path}|${name}|${value.type}|${value.size}|${lastModified}`;
    // A restored or unchanged Blob keeps its existing ID through the WeakMap.
    // A newly selected Blob always receives a new ID, even if its filename and
    // metadata happen to match an older file whose bytes are different.
    const id = existingId?.startsWith(`${scope}:`)
      ? existingId
      : createMediaId(scope, identity);
    mediaIdByBlob.set(value, id);
    media.set(id, {
      id,
      scope,
      blob: value,
      name,
      type: value.type || "application/octet-stream",
      size: value.size,
      lastModified,
    });
    return { __cvDraftMediaV3: true, id } satisfies MediaMarker;
  }

  if (Array.isArray(value)) {
    return Promise.all(
      value.map((item, index) => serializeValue(item, `${path}.${index}`, scope, media))
    );
  }

  if (value && typeof value === "object") {
    const entries = await Promise.all(
      Object.entries(value).map(async ([key, item]) => [
        key,
        await serializeValue(item, `${path}.${key}`, scope, media),
      ] as const)
    );
    return Object.fromEntries(entries);
  }

  return value;
}

async function hydrateValue(
  value: unknown,
  mediaStore: { get(id: string): Promise<StoredMedia | undefined> },
  missing: { count: number }
): Promise<unknown> {
  if (isMediaMarker(value)) {
    const stored = await mediaStore.get(value.id);
    if (!stored) {
      missing.count += 1;
      return undefined;
    }
    const file = new File([stored.blob], stored.name, {
      type: stored.type,
      lastModified: stored.lastModified,
    });
    mediaIdByBlob.set(file, stored.id);
    return file;
  }

  if (Array.isArray(value)) {
    const items = await Promise.all(
      value.map((item) => hydrateValue(item, mediaStore, missing))
    );
    return items.filter((item) => item !== undefined);
  }

  if (value && typeof value === "object") {
    const entries = await Promise.all(
      Object.entries(value).map(async ([key, item]) => [
        key,
        await hydrateValue(item, mediaStore, missing),
      ] as const)
    );
    return Object.fromEntries(entries.filter(([, item]) => item !== undefined));
  }

  return value;
}

export async function requestDurableDraftStorage() {
  if (persistenceRequested || typeof navigator === "undefined") return;
  persistenceRequested = true;
  try {
    await navigator.storage?.persist?.();
  } catch {
    // Persistence is advisory; IndexedDB still works when the browser declines it.
  }
}

export async function getDraftStorageEstimate() {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return null;
  try {
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}

function isQuotaError(error: unknown) {
  const name = String((error as { name?: unknown } | null)?.name || "");
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED";
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 MB";
  return `${Math.max(0.1, value / 1024 / 1024).toFixed(1)} MB`;
}

export async function saveScopedDraft<T extends ScopedDraftEnvelope>(
  envelope: T,
  scopeId?: string
) {
  if (envelope.version !== FORM_DRAFT_VERSION) {
    throw new DraftPersistenceError("Only version 3 drafts can be saved to durable storage.");
  }
  await requestDurableDraftStorage();
  const database = await getDatabase();
  const scope = scopeFor(envelope.userId, envelope.kind, scopeId);
  const nextMedia = new Map<string, StoredMedia>();
  const serialized = await serializeValue(envelope, "draft", scope, nextMedia);
  const transaction = database.transaction(["drafts", "media", "activity"], "readwrite");

  try {
    const previous = await transaction.objectStore("drafts").get(scope);
    const draftData = serialized as Record<string, any>;
    const form = draftData.formData || draftData.data || {};
    const activityId = String(scopeId || form.captureId || form.clientSubmissionId || scope);
    const oldForm = (previous?.envelope as Record<string, any> | undefined)?.formData || (previous?.envelope as Record<string, any> | undefined)?.data || {};
    const observations = [{ action: "draft_saved", outcome: "completed" as const, data: {
      beforeCounts: activityCounts(previous ? browserActivityState(previous.envelope) : null),
      afterCounts: activityCounts(browserActivityState(serialized)), uploadLogo: typeof form.watermarkImages === "boolean" ? form.watermarkImages : null,
      cameraStamp: "not_recorded", captureMode: "online",
      fields: Object.keys(form).filter(key => !/lot|image|photo|file|uri|url/i.test(key) && JSON.stringify(oldForm[key]) !== JSON.stringify(form[key])).slice(0, 100),
    } }];
    const operationId = createMediaId("event", scope);
    for (const [index, observation] of observations.entries()) {
      const event: DeviceActivity = { ...observation, eventId: `${operationId}:${index}`, activityId,
        reportType: envelope.kind === "asset" ? "asset" : "lotListing", contract: String(form.contractNo || ""),
        source: "web", sequence: Math.max(1, envelope.revision), sequenceScope: `saved:${scope}`,
        observedAt: envelope.savedAt };
      await transaction.objectStore("activity").add({ id: `${envelope.userId}:${event.eventId}`, owner: envelope.userId, event });
    }
    for (const record of nextMedia.values()) {
      const existing = await transaction.objectStore("media").get(record.id);
      if (
        !existing ||
        existing.size !== record.size ||
        existing.lastModified !== record.lastModified ||
        existing.type !== record.type
      ) {
        await transaction.objectStore("media").put(record);
      }
    }

    // Commit the new metadata before removing stale media in the same atomic
    // transaction. Any quota/error abort restores the previous valid revision.
    await transaction.objectStore("drafts").put({
      scope,
      envelope: serialized,
      mediaIds: [...nextMedia.keys()],
      savedAt: envelope.savedAt,
    });
    const retained = new Set(nextMedia.keys());
    for (const id of previous?.mediaIds || []) {
      if (!retained.has(id)) await transaction.objectStore("media").delete(id);
    }
    await transaction.done;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // The transaction may already have aborted itself.
    }
    const estimate = await getDraftStorageEstimate();
    const available =
      estimate?.quota !== undefined && estimate?.usage !== undefined
        ? Math.max(0, estimate.quota - estimate.usage)
        : null;
    const capacityHint =
      available === null ? "" : ` Browser storage has about ${formatBytes(available)} available.`;
    throw new DraftPersistenceError(
      isQuotaError(error)
        ? `Draft storage is full.${capacityHint} Remove unneeded site data or reduce this draft's media, then save again. The previous valid draft was preserved.`
        : `Draft media could not be stored safely.${capacityHint} The previous valid draft was preserved.`,
      error
    );
  }
}

export async function loadScopedDraft<T extends ScopedDraftEnvelope>(
  userId: string,
  kind: FormDraftKind,
  scopeId?: string
): Promise<LoadedScopedDraft<T> | null> {
  const database = await getDatabase();
  const scope = scopeFor(userId, kind, scopeId);
  const transaction = database.transaction(["drafts", "media"], "readonly");
  const record = await transaction.objectStore("drafts").get(scope);
  if (!record) return null;
  const missing = { count: 0 };
  const envelope = (await hydrateValue(
    record.envelope,
    transaction.objectStore("media"),
    missing
  )) as T;
  await transaction.done;
  assertScopedDraftEnvelope(envelope, { userId, kind, version: FORM_DRAFT_VERSION });
  return { envelope, missingMediaCount: missing.count };
}

export async function hasScopedDraft(
  userId: string,
  kind: FormDraftKind,
  scopeId?: string
) {
  const database = await getDatabase();
  return Boolean(await database.get("drafts", scopeFor(userId, kind, scopeId)));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function summarizeStoredDraft(
  record: StoredDraft,
  expectedUserId: string
): ScopedDraftSummary | null {
  const envelope = asRecord(record.envelope);
  if (!envelope || envelope.version !== FORM_DRAFT_VERSION) return null;
  if (envelope.userId !== expectedUserId) return null;
  if (envelope.kind !== "asset" && envelope.kind !== "lot-listing") return null;

  const kind = envelope.kind;
  const data = asRecord(kind === "asset" ? envelope.formData : envelope.data);
  const lots = Array.isArray(
    kind === "asset" ? envelope.lots : data?.lots
  )
    ? ((kind === "asset" ? envelope.lots : data?.lots) as unknown[])
    : [];
  const ordinaryScope = scopeFor(expectedUserId, kind);
  const scopedPrefix = `${ordinaryScope}:`;
  const scopeId = record.scope.startsWith(scopedPrefix)
    ? record.scope.slice(scopedPrefix.length)
    : undefined;

  return {
    kind,
    userId: expectedUserId,
    scopeId,
    revision: Number(envelope.revision) || 0,
    savedAt:
      typeof envelope.savedAt === "string" ? envelope.savedAt : record.savedAt,
    contractNo:
      typeof data?.contractNo === "string" ? data.contractNo.trim() : "",
    lotCount: lots.length,
    mediaCount: record.mediaIds.length,
  };
}

/**
 * Lists draft metadata without hydrating Blob records. The sidebar uses this
 * to remain fast even when a report contains hundreds of original photos.
 * Auctioneer-scoped drafts stay in their Incoming work item unless explicitly
 * requested because they require that work item's integration context.
 */
export async function listScopedDrafts(
  userId: string,
  options: { includeScoped?: boolean } = {}
): Promise<ScopedDraftSummary[]> {
  const database = await getDatabase();
  const records = await database.getAll("drafts");
  return records
    .map((record) => summarizeStoredDraft(record, userId))
    .filter((summary): summary is ScopedDraftSummary => Boolean(summary))
    .filter((summary) => options.includeScoped || !summary.scopeId)
    .sort(
      (left, right) =>
        new Date(right.savedAt).getTime() - new Date(left.savedAt).getTime()
    );
}

export async function deleteScopedDraft(
  userId: string,
  kind: FormDraftKind,
  scopeId?: string
) {
  const database = await getDatabase();
  const scope = scopeFor(userId, kind, scopeId);
  const transaction = database.transaction(["drafts", "media"], "readwrite");
  const record = await transaction.objectStore("drafts").get(scope);
  await transaction.objectStore("drafts").delete(scope);
  for (const id of record?.mediaIds || []) {
    await transaction.objectStore("media").delete(id);
  }
  await transaction.done;
}

export function getScopedDraftKey(
  userId: string | null | undefined,
  kind: FormDraftKind,
  scopeId?: string
) {
  if (!userId) return null;
  return `cv:${userId}:${kind}${normalizeScopeId(scopeId)}:draft:v2`;
}

function assertScopedDraftEnvelope(
  parsed: unknown,
  expected: { userId: string; kind: FormDraftKind; version: number }
) {
  if (!parsed || typeof parsed !== "object") {
    throw new DraftEnvelopeError("The saved draft has an invalid shape.", "corrupt");
  }
  const envelope = parsed as Partial<ScopedDraftEnvelope>;
  if (envelope.version !== expected.version) {
    throw new DraftEnvelopeError(
      "The saved draft uses an unsupported version.",
      "unsupported-version"
    );
  }
  if (envelope.kind !== expected.kind) {
    throw new DraftEnvelopeError("The saved draft belongs to a different form.", "wrong-kind");
  }
  if (envelope.userId !== expected.userId) {
    throw new DraftEnvelopeError("The saved draft belongs to a different user.", "wrong-user");
  }
}

export function parseScopedDraftEnvelope<T extends ScopedDraftEnvelope>(
  raw: string,
  expected: { userId: string; kind: FormDraftKind }
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DraftEnvelopeError("The saved draft is not valid JSON.", "corrupt");
  }
  assertScopedDraftEnvelope(parsed, {
    ...expected,
    version: LEGACY_FORM_DRAFT_VERSION,
  });
  return parsed as T;
}
