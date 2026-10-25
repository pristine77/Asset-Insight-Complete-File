import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import { getAppVersionLabel } from './appVersion';
import { Platform } from 'react-native';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { OfflineReportDraft } from './autoSaveService';
import type { CaptureContext, NativeCaptureJournal, OfflineDraftCounts, OfflineSubmissionState } from './offlineCaptureTypes';
import type { MixedLot } from '../components/camera/types';
import { activityBatch, activityCounts, observeActivity, type ActivityState, type DeviceActivity } from './reportActivityObservation';
import { backupContent, backupOriginalUri, isBackupCandidate } from './captureBackupSnapshot';
import type { DurableContinuationIntent } from './durableContinuationTypes';

const LEGACY_DRAFTS = '@clearvalue_offline_report_drafts_v1';
const LEGACY_AUTOSAVE = '@clearvalue_auto_save';
const LEGACY_QUEUE = '@clearvalue_offline_submit_queue_v1';
const schema = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS capture_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS report_upload_continuations (
  owner_id TEXT NOT NULL, id TEXT NOT NULL, parent_work_item_id TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(owner_id,id), UNIQUE(owner_id,parent_work_item_id)
);
CREATE TABLE IF NOT EXISTS capture_backup_outbox (
  owner_id TEXT NOT NULL, draft_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(owner_id,draft_id,revision)
);
CREATE TABLE IF NOT EXISTS capture_backup_media_refs (
  owner_id TEXT NOT NULL, draft_id TEXT NOT NULL, uri TEXT NOT NULL,
  PRIMARY KEY(owner_id,draft_id,uri)
);
CREATE TABLE IF NOT EXISTS capture_backup_seeded (
  owner_id TEXT NOT NULL, draft_id TEXT NOT NULL, PRIMARY KEY(owner_id,draft_id)
);
CREATE TABLE IF NOT EXISTS report_activity_outbox (
  owner_id TEXT NOT NULL, event_id TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(owner_id,event_id)
);
CREATE TABLE IF NOT EXISTS report_activity_camera (
  owner_id TEXT NOT NULL, draft_id TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(owner_id,draft_id)
);
CREATE TABLE IF NOT EXISTS report_activity_seen (owner_id TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY(owner_id,event_id));
CREATE TABLE IF NOT EXISTS capture_drafts (
  owner_id TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL, revision INTEGER NOT NULL,
  updated_at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(owner_id,id)
);
CREATE INDEX IF NOT EXISTS capture_drafts_owner_updated ON capture_drafts(owner_id,updated_at DESC);
CREATE TABLE IF NOT EXISTS capture_summaries (
  owner_id TEXT NOT NULL, draft_id TEXT NOT NULL, type TEXT NOT NULL, updated_at TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL, PRIMARY KEY(owner_id,draft_id)
);
CREATE TABLE IF NOT EXISTS capture_lots (
  owner_id TEXT NOT NULL, draft_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL,
  main_count INTEGER NOT NULL, extra_count INTEGER NOT NULL, video_count INTEGER NOT NULL,
  PRIMARY KEY(owner_id,draft_id,id)
);
CREATE TABLE IF NOT EXISTS capture_media (
  owner_id TEXT NOT NULL, draft_id TEXT NOT NULL, media_id TEXT NOT NULL, lot_id TEXT NOT NULL,
  slot TEXT NOT NULL, position INTEGER NOT NULL, uri TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(owner_id,draft_id,lot_id,slot,position)
);
CREATE INDEX IF NOT EXISTS capture_media_uri ON capture_media(uri);
CREATE TABLE IF NOT EXISTS capture_outbox (
  owner_id TEXT NOT NULL, draft_id TEXT NOT NULL, revision INTEGER NOT NULL,
  acknowledged_revision INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner_id,draft_id)
);
CREATE TABLE IF NOT EXISTS capture_inventory_errors (
  owner_id TEXT NOT NULL, draft_id TEXT NOT NULL, revision INTEGER NOT NULL, message TEXT NOT NULL,
  PRIMARY KEY(owner_id,draft_id)
);
CREATE TABLE IF NOT EXISTS capture_legacy (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, claimed_by TEXT, claimed_at TEXT
);
CREATE TABLE IF NOT EXISTS capture_pending_camera (
  owner_id TEXT NOT NULL, draft_id TEXT NOT NULL, session_id TEXT NOT NULL,
  revision INTEGER NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL, PRIMARY KEY(owner_id,draft_id)
);`;

function missing(media: unknown): boolean {
  return !!media && typeof media === 'object' && ((media as { availability?: string }).availability === 'missing' || (media as { missing?: boolean }).missing === true);
}

export function countOfflineDraft(draft: Pick<OfflineReportDraft, 'lots'>): OfflineDraftCounts {
  const perLot = draft.lots.map((lot) => ({
    id: lot.id, lotNumber: lot.lotNumber, title: lot.title, mainImages: lot.mainImages.length, extraImages: lot.extraImages.length,
    images: lot.mainImages.length + lot.extraImages.length, videos: lot.videoFiles?.length || 0,
    missingImages: [...lot.mainImages, ...lot.extraImages].filter(missing).length,
  }));
  return perLot.reduce((total, lot) => ({ ...total, images: total.images + lot.images,
    mainImages: total.mainImages + lot.mainImages, extraImages: total.extraImages + lot.extraImages,
    videos: total.videos + lot.videos, missingImages: total.missingImages + lot.missingImages,
  }), { lots: perLot.length, images: 0, mainImages: 0, extraImages: 0, videos: 0, missingImages: 0, perLot });
}

export type OfflineDraftSummary = {
  id: string; type: OfflineReportDraft['type']; title: string; contractNo?: string;
  updatedAt: string; createdAt: string; ownerId?: string; captureMode: 'online' | 'offline';
  localRevision: number; submissionState: OfflineSubmissionState; counts: OfflineDraftCounts;
  manualSubmissionRequired?: boolean;
  inventoryError?: string;
};
const hidden = (draft: OfflineReportDraft) => ['accepted', 'submitted', 'discarded'].includes(draft.submissionState || '');
/** The cloud copy's bookkeeping on a draft; never part of what is uploaded or compared. */
export const CLOUD_SYNC_FIELDS = ['cloudId', 'cloudSyncedAt', 'cloudSyncError', 'cloudSyncErrorKind',
  'cloudSyncRetryAt', 'cloudSyncAttempts', 'cloudSyncLastAttemptAt'] as const;
export type CloudSyncField = typeof CLOUD_SYNC_FIELDS[number];
const legacyNeedsIncomingReview = (details: Record<string, any>) => Boolean(
  details.legacyRequiresIncomingReview ||
  ((details.auctioneer_work_item_id || details.auctioneerWorkItemId) && !details.auctioneerSnapshot) ||
  ((details.auction_management_task_id || details.auctionManagementTaskId || details.auction_payload || details.auctionPayload || details.auctionsoft) && !details.auctionsoftSnapshot)
);
function summary(draft: OfflineReportDraft): OfflineDraftSummary {
  return { id: draft.id, type: draft.type, title: draft.title, contractNo: draft.contractNo,
    createdAt: draft.createdAt, updatedAt: draft.updatedAt, ownerId: draft.ownerId,
    captureMode: draft.captureMode || 'online', localRevision: draft.localRevision || 0,
    submissionState: draft.submissionState || 'local', manualSubmissionRequired: draft.manualSubmissionRequired,
    counts: countOfflineDraft(draft) };
}
type DraftRow = { data: string; revision: number };
type DatabaseFactory = () => Promise<SQLiteDatabase>;

export function nativeActivityState(draft: Pick<OfflineReportDraft, 'lots' | 'formData' | 'activeLotIdx' | 'captureMode' | 'submissionState'>): ActivityState {
  const identity = (raw: string) => {
    if (/^[a-zA-Z0-9._:-]{1,160}$/.test(raw) && !/^(file|content|data):/.test(raw)) return raw;
    // Legacy references get opaque deterministic IDs; paths never leave the device.
    let a = 2166136261, b = 5381;
    for (let i = 0; i < raw.length; i++) { a = Math.imul(a ^ raw.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ raw.charCodeAt(i); }
    return `legacy-${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}`;
  };
  const photo = (value: any) => ({ id: identity(typeof value === 'string' ? value : value.mediaId || value.clientFileId || value.originalUri || value.uri), camera: value?.captureOrigin === 'camera' });
  return { lots: draft.lots.map(lot => ({ id: identity(lot.id), lotNumber: String(lot.lotNumber || ''), main: lot.mainImages.map(photo), extra: lot.extraImages.map(photo), cover: Number.isInteger(lot.coverIndex) ? lot.coverIndex : null })),
    activeLot: draft.lots[draft.activeLotIdx || 0]?.id || null, logo: typeof draft.formData.watermarkImages === 'boolean' ? draft.formData.watermarkImages : null,
    mode: draft.captureMode || 'online', status: draft.submissionState || 'local' };
}

/** One serialized metadata writer; media bytes never enter SQLite or this migration. */
export function createOfflineCaptureStore(openDatabase: DatabaseFactory, legacyStorage = AsyncStorage) {
  let ownerId: string | null = null;
  let database: Promise<SQLiteDatabase> | undefined;
  let initialized: Promise<void> | undefined;
  let writeTail: Promise<unknown> = Promise.resolve();
  const savedListeners = new Set<() => void>();
  const continuationListeners = new Set<() => void>();
  const db = () => (database ??= openDatabase());
  const requireOwner = () => {
    if (!ownerId) throw new Error('Sign in to the draft owner account before saving or uploading.');
    return ownerId;
  };
  const assertOwner = (expected: string) => {
    if (ownerId !== expected) throw new Error('The signed-in account changed. Reopen this draft from its owner account.');
  };
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = writeTail.catch(() => undefined).then(work);
    writeTail = next.catch(() => undefined);
    return next;
  };
  const readJson = <T>(raw: string): T => JSON.parse(raw) as T;

  async function initialize() {
    if (!initialized) initialized = (async () => {
      const database = await db();
      await database.execAsync(schema);
      const migrated = await database.getFirstAsync<{ value: string }>('SELECT value FROM capture_meta WHERE key = ?', 'legacy-v1');
      if (migrated) return;
      const raw = await legacyStorage.multiGet([LEGACY_DRAFTS, LEGACY_AUTOSAVE, LEGACY_QUEUE]);
      await database.withExclusiveTransactionAsync(async (tx) => {
        for (const [key, value] of raw) {
          if (!value) continue;
          // Retain even malformed sources verbatim for recovery; never normalize/drop missing files.
          await tx.runAsync('INSERT OR IGNORE INTO capture_legacy(id,kind,data) VALUES(?,?,?)', `source:${key}`, 'source', value);
          let parsed: any;
          try { parsed = JSON.parse(value); } catch { continue; }
          if (key === LEGACY_DRAFTS && Array.isArray(parsed)) {
            for (const [index, draft] of parsed.entries()) {
              if (!draft || !['asset', 'lotListing'].includes(draft.type) || !Array.isArray(draft.lots)) continue;
              await tx.runAsync('INSERT OR IGNORE INTO capture_legacy(id,kind,data) VALUES(?,?,?)',
                `draft:${String(draft.id || index)}`, 'draft', JSON.stringify(draft));
            }
          } else if (key === LEGACY_AUTOSAVE && ['asset', 'lotListing'].includes(parsed?.formType) && Array.isArray(parsed.lots)) {
            const now = parsed.savedAt || new Date().toISOString();
            const draft = { id: 'legacy-autosave', type: parsed.formType, title: parsed.formData?.contractNo || 'Recovered draft',
              contractNo: parsed.formData?.contractNo, formData: parsed.formData || {}, lots: parsed.lots,
              activeLotIdx: parsed.activeLotIdx || 0, createdAt: now, updatedAt: now };
            await tx.runAsync('INSERT OR IGNORE INTO capture_legacy(id,kind,data) VALUES(?,?,?)', 'draft:legacy-autosave', 'draft', JSON.stringify(draft));
          } else if (key === LEGACY_QUEUE && Array.isArray(parsed)) {
            for (const [index, job] of parsed.entries()) if (job && typeof job === 'object') {
              await tx.runAsync('INSERT OR IGNORE INTO capture_legacy(id,kind,data) VALUES(?,?,?)', `queue:${String(job.id || index)}`, 'queue', JSON.stringify(job));
            }
          }
        }
        await tx.runAsync('INSERT OR REPLACE INTO capture_meta(key,value) VALUES(?,?)', 'legacy-v1', new Date().toISOString());
      });
      // Old keys deliberately remain untouched. They are quarantine, never the new sync source.
    })().catch((error) => { initialized = undefined; throw error; });
    return initialized;
  }

  async function readDraft(id: string, expected: string): Promise<OfflineReportDraft | null> {
    await initialize();
    const row = await (await db()).getFirstAsync<DraftRow>('SELECT data,revision FROM capture_drafts WHERE owner_id = ? AND id = ?', expected, id);
    assertOwner(expected);
    return row ? { ...readJson<OfflineReportDraft>(row.data), ownerId: expected, localRevision: row.revision } : null;
  }

  async function persist(draft: OfflineReportDraft, expected: string, legacyId?: string, explicitSave = false, createOnly = false): Promise<OfflineReportDraft> {
    await initialize();
    assertOwner(expected);
    if (draft.ownerId && draft.ownerId !== expected) throw new Error('This draft belongs to another account.');
    if (new Set(draft.lots.map((lot) => lot.id)).size !== draft.lots.length) throw new Error('Each lot needs its own stable identity.');
    if (countOfflineDraft(draft).images > 5000) throw new Error('A report may contain at most 5,000 photos.');
    const database = await db();
    let saved!: OfflineReportDraft;
    await database.withExclusiveTransactionAsync(async (tx) => {
      assertOwner(expected);
      const old = await tx.getFirstAsync<DraftRow>('SELECT data,revision FROM capture_drafts WHERE owner_id = ? AND id = ?', expected, draft.id);
      if (createOnly && old) throw new Error('This draft is already saved on this device. Open its local copy; it has not been replaced.');
      const previous = old ? readJson<OfflineReportDraft>(old.data) : null;
      if (old && draft.localRevision != null && draft.localRevision !== old.revision) throw new Error('This draft changed while saving. Reopen it before retrying.');
      const revision = (old?.revision || 0) + 1;
      saved = { ...draft, captureId: previous?.captureId || draft.captureId || randomUUID(), ownerId: expected, localRevision: revision,
        manualSubmissionRequired: Boolean(previous?.manualSubmissionRequired || previous?.captureMode === 'offline' || draft.captureMode === 'offline' || draft.manualSubmissionRequired || draft.formData.manualSubmissionRequired),
        inventoryAppVersion: getAppVersionLabel() || 'unknown', inventoryPlatform: Platform.OS === 'ios' ? 'ios' : 'android',
        captureMode: draft.captureMode || previous?.captureMode || 'online',
        submissionState: draft.submissionState || previous?.submissionState || 'local' };
      saved.formData = { ...saved.formData, manualSubmissionRequired: saved.manualSubmissionRequired };
      const camera = await tx.getFirstAsync<{ data: string }>('SELECT data FROM report_activity_camera WHERE owner_id=? AND draft_id=?', expected, draft.id);
      const observations = observeActivity(previous ? nativeActivityState(previous) : null, nativeActivityState(saved))
        .filter(event => !camera || ['history_started', 'draft_saved', 'logo_changed', 'capture_mode_changed', 'submission_requested', 'upload_started'].includes(event.action));
      if (explicitSave && !observations.some(event => event.action === 'draft_saved')) observations.push({ action: 'draft_saved', outcome: 'completed', data: {
        beforeCounts: activityCounts(previous ? nativeActivityState(previous) : null), afterCounts: activityCounts(nativeActivityState(saved)),
        fields: (Object.keys(saved.formData) as Array<keyof typeof saved.formData>).filter(key => !/photo|image|file|uri|url|snapshot/i.test(key) && JSON.stringify(previous?.formData[key]) !== JSON.stringify(saved.formData[key])).slice(0, 100),
        uploadLogo: typeof saved.formData.watermarkImages === 'boolean' ? saved.formData.watermarkImages : null,
        cameraStamp: nativeActivityState(saved).lots.some(lot => [...lot.main, ...lot.extra].some(photo => photo.camera)) ? 'camera_reported' : 'not_recorded', captureMode: saved.captureMode,
      } });
      if (camera) {
        const journal = readJson<{ sessionId: string; activity: Array<Record<string, any>> }>(camera.data);
        for (const item of journal.activity) {
          const event = { ...item, eventId: `camera:${item.eventId}`, activityId: saved.captureId, reportType: saved.type,
            source: saved.inventoryPlatform, appVersion: saved.inventoryAppVersion, sequenceScope: journal.sessionId, contract: saved.contractNo || '',
            data: { ...item.data, uploadLogo: typeof saved.formData.watermarkImages === 'boolean' ? saved.formData.watermarkImages : null, captureMode: saved.captureMode } };
          const inserted = await tx.runAsync('INSERT OR IGNORE INTO report_activity_seen(owner_id,event_id) VALUES(?,?)', expected, event.eventId);
          if (inserted.changes) await tx.runAsync('INSERT OR IGNORE INTO report_activity_outbox(owner_id,event_id,data) VALUES(?,?,?)', expected, event.eventId, JSON.stringify(event));
        }
        await tx.runAsync('DELETE FROM report_activity_camera WHERE owner_id=? AND draft_id=?', expected, draft.id);
      }
      for (const [index, observation] of observations.entries()) {
        const event: DeviceActivity = { ...observation, eventId: `${saved.captureId}:${revision}:${index}`, activityId: saved.captureId!,
          reportType: saved.type, contract: saved.contractNo || '', source: saved.inventoryPlatform!, sequence: revision,
          sequenceScope: saved.captureId!, observedAt: saved.updatedAt, appVersion: saved.inventoryAppVersion };
        await tx.runAsync('INSERT OR IGNORE INTO report_activity_outbox(owner_id,event_id,data) VALUES(?,?,?)', expected, event.eventId, JSON.stringify(event));
      }
      await tx.runAsync('INSERT OR REPLACE INTO capture_drafts(owner_id,id,type,revision,updated_at,data) VALUES(?,?,?,?,?,?)',
        expected, draft.id, draft.type, revision, draft.updatedAt, JSON.stringify(saved));
      await tx.runAsync('INSERT OR REPLACE INTO capture_summaries(owner_id,draft_id,type,updated_at,hidden,data) VALUES(?,?,?,?,?,?)',
        expected, draft.id, draft.type, draft.updatedAt, hidden(saved) ? 1 : 0, JSON.stringify(summary(saved)));
      if (isBackupCandidate(saved) && (!previous || !isBackupCandidate(previous) || backupContent(previous) !== backupContent(saved))) {
        // Atomic with the local save: process death cannot silently lose queue intent.
        await tx.runAsync(`INSERT INTO capture_backup_outbox(owner_id,draft_id,revision,data) VALUES(?,?,?,?)`,
          expected, draft.id, revision, JSON.stringify(saved));
        await tx.runAsync('INSERT OR IGNORE INTO capture_backup_seeded(owner_id,draft_id) VALUES(?,?)', expected, draft.id);
        const refs = new Set<string>();
        for (const lot of saved.lots) for (const media of [...lot.mainImages, ...lot.extraImages, ...(lot.videoFiles || [])]) {
          const value = backupOriginalUri(media);
          if (value && /^(file|content):/i.test(value)) refs.add(value);
        }
        const values = [...refs];
        for (let offset = 0; offset < values.length; offset += 100) {
          const batch = values.slice(offset, offset + 100);
          await tx.runAsync(`INSERT OR IGNORE INTO capture_backup_media_refs(owner_id,draft_id,uri) VALUES ${batch.map(() => '(?,?,?)').join(',')}`,
            ...batch.flatMap(uri => [expected, draft.id, uri]));
        }
      }
      if (saved.submissionState === 'discarded' && previous?.submissionState !== 'discarded') {
        // A durable stop command, not permission to resurrect/upload a deleted draft.
        await tx.runAsync(`INSERT INTO capture_backup_outbox(owner_id,draft_id,revision,data) VALUES(?,?,?,?)`,
          expected, draft.id, revision, JSON.stringify(saved));
      }
      const oldLots = new Map((previous?.lots || []).map((lot) => [lot.id, lot]));
      const oldPositions = new Map((previous?.lots || []).map((lot, index) => [lot.id, index]));
      const nextLotIds = new Set(draft.lots.map((lot) => lot.id));
      for (const oldId of oldLots.keys()) if (!nextLotIds.has(oldId)) {
        await tx.runAsync('DELETE FROM capture_lots WHERE owner_id = ? AND draft_id = ? AND id = ?', expected, draft.id, oldId);
        await tx.runAsync('DELETE FROM capture_media WHERE owner_id = ? AND draft_id = ? AND lot_id = ?', expected, draft.id, oldId);
      }
      for (const [position, lot] of draft.lots.entries()) {
        const previousLot = oldLots.get(lot.id);
        if (JSON.stringify(previousLot) === JSON.stringify(lot)) {
          if (oldPositions.get(lot.id) !== position) await tx.runAsync('UPDATE capture_lots SET position=? WHERE owner_id=? AND draft_id=? AND id=?', position, expected, draft.id, lot.id);
          continue;
        }
        await tx.runAsync('INSERT OR REPLACE INTO capture_lots(owner_id,draft_id,id,position,main_count,extra_count,video_count) VALUES(?,?,?,?,?,?,?)',
          expected, draft.id, lot.id, position, lot.mainImages.length, lot.extraImages.length, lot.videoFiles?.length || 0);
        await tx.runAsync('DELETE FROM capture_media WHERE owner_id = ? AND draft_id = ? AND lot_id = ?', expected, draft.id, lot.id);
        const entries: Array<Array<string | number>> = [];
        for (const [slot, files] of [['main', lot.mainImages], ['extra', lot.extraImages], ['video', lot.videoFiles || []]] as const) {
          for (const [index, file] of files.entries()) {
            const media = typeof file === 'string' ? { uri: file } : file;
            const id = 'mediaId' in media && media.mediaId ? media.mediaId : `${lot.id}:${slot}:${index}`;
            entries.push([expected, draft.id, id, lot.id, slot, index, media.uri, JSON.stringify(media)]);
          }
        }
        // Bounded multi-row writes keep 5,000-photo metadata commits off the bridge hot path.
        for (let offset = 0; offset < entries.length; offset += 100) {
          const batch = entries.slice(offset, offset + 100);
          await tx.runAsync(`INSERT INTO capture_media(owner_id,draft_id,media_id,lot_id,slot,position,uri,data) VALUES ${batch.map(() => '(?,?,?,?,?,?,?,?)').join(',')}`, ...batch.flat());
        }
      }
      if (saved.captureMode === 'offline' || saved.manualSubmissionRequired) await tx.runAsync(`INSERT INTO capture_outbox(owner_id,draft_id,revision) VALUES(?,?,?)
        ON CONFLICT(owner_id,draft_id) DO UPDATE SET revision=excluded.revision`, expected, draft.id, revision);
      else await tx.runAsync('UPDATE capture_outbox SET revision=? WHERE owner_id=? AND draft_id=?', revision, expected, draft.id);
      await tx.runAsync('DELETE FROM capture_inventory_errors WHERE owner_id=? AND draft_id=?', expected, draft.id);
      if (legacyId) await tx.runAsync('UPDATE capture_legacy SET claimed_by = ?, claimed_at = ? WHERE id = ? AND claimed_by IS NULL',
        expected, new Date().toISOString(), legacyId);
    });
    assertOwner(expected);
    for (const listener of savedListeners) { try { listener(); } catch { /* The committed draft remains authoritative. */ } }
    return saved;
  }

  const store = {
    setOwner(value: string | null) { ownerId = value?.trim() || null; },
    getOwnerId() { return ownerId; },
    initialize,
    subscribeSaved(listener: () => void) { savedListeners.add(listener); return () => { savedListeners.delete(listener); }; },
    subscribeContinuations(listener: () => void) { continuationListeners.add(listener); return () => { continuationListeners.delete(listener); }; },
    async seedBackups() {
      const expected = requireOwner(); await initialize();
      await serialize(async () => { assertOwner(expected); await (await db()).withExclusiveTransactionAsync(async tx => { await tx.runAsync(`
        INSERT OR IGNORE INTO capture_backup_outbox(owner_id,draft_id,revision,data)
        SELECT d.owner_id,d.id,d.revision,d.data FROM capture_drafts d
        JOIN capture_summaries s ON s.owner_id=d.owner_id AND s.draft_id=d.id
        WHERE d.owner_id=? AND s.hidden=0 AND d.type IN ('asset','lotListing')
          AND NOT EXISTS (SELECT 1 FROM capture_backup_seeded q WHERE q.owner_id=d.owner_id AND q.draft_id=d.id)
          AND (json_extract(d.data,'$.captureMode')='offline' OR json_extract(d.data,'$.manualSubmissionRequired')=1)`, expected);
        await tx.runAsync(`INSERT OR IGNORE INTO capture_backup_media_refs(owner_id,draft_id,uri)
          SELECT m.owner_id,m.draft_id,COALESCE(NULLIF(json_extract(m.data,'$.originalUri'),''),m.uri)
          FROM capture_media m JOIN capture_backup_outbox b ON b.owner_id=m.owner_id AND b.draft_id=m.draft_id
          WHERE m.owner_id=?`, expected);
        // Seed legacy captures once, not on every foreground/auth restart. Ordinary
        // content saves already journal each new revision atomically above.
        await tx.runAsync(`INSERT OR IGNORE INTO capture_backup_seeded(owner_id,draft_id)
          SELECT owner_id,draft_id FROM capture_backup_outbox WHERE owner_id=?`, expected);
      }); });
    },
    async pendingBackups(limit = 10, excluded: string[] = []): Promise<OfflineReportDraft[]> {
      const expected = requireOwner(); await initialize();
      const skip = excluded.slice(0, 200);
      const rows = await (await db()).getAllAsync<{ data: string }>(`SELECT data FROM capture_backup_outbox WHERE owner_id=?${skip.length ? ` AND draft_id NOT IN (${skip.map(() => '?').join(',')})` : ''} ORDER BY rowid LIMIT ?`, expected, ...skip, Math.min(20, Math.max(1, limit)));
      assertOwner(expected); return rows.map(row => readJson<OfflineReportDraft>(row.data));
    },
    async acknowledgeBackupQueue(id: string, revision: number, expected: string) {
      assertOwner(expected); await initialize();
      await serialize(async () => { assertOwner(expected); await (await db()).runAsync(
        'DELETE FROM capture_backup_outbox WHERE owner_id=? AND draft_id=? AND revision=?', expected, id, revision
      ); });
    },
    async stageCameraActivity(journal: NativeCaptureJournal & { activity?: unknown[] }) {
      const expected = requireOwner(); if (journal.ownerId !== expected) throw new Error('Camera owner changed.');
      if (!Array.isArray(journal.activity)) return;
      await serialize(async () => { await initialize(); assertOwner(expected);
        await (await db()).runAsync('INSERT OR REPLACE INTO report_activity_camera(owner_id,draft_id,data) VALUES(?,?,?)', expected, journal.draftId,
          JSON.stringify({ sessionId: journal.sessionId, activity: journal.activity }));
      });
    },
    async pendingActivity(): Promise<DeviceActivity[]> {
      const expected = requireOwner(); await initialize();
      const rows = await (await db()).getAllAsync<{ data: string }>('SELECT data FROM report_activity_outbox WHERE owner_id=? ORDER BY rowid LIMIT 100', expected);
      assertOwner(expected); return activityBatch(rows.map(row => readJson<DeviceActivity>(row.data)));
    },
    async acknowledgeActivity(ids: string[], expected: string) {
      assertOwner(expected); await initialize();
      await serialize(async () => { assertOwner(expected); await (await db()).withExclusiveTransactionAsync(async tx => {
        for (const id of ids.slice(0, 100)) await tx.runAsync('DELETE FROM report_activity_outbox WHERE owner_id=? AND event_id=?', expected, id);
      }); });
    },
    async savePendingCapture(context: CaptureContext, lots: MixedLot[]): Promise<NativeCaptureJournal> {
      const expected = requireOwner();
      if (context.ownerId !== expected) throw new Error('The camera belongs to another account.');
      return serialize(async () => {
        await initialize(); assertOwner(expected);
        const previous = await (await db()).getFirstAsync<{ session_id: string; revision: number; acknowledged: number }>(
          'SELECT session_id,revision,acknowledged FROM capture_pending_camera WHERE owner_id=? AND draft_id=?', expected, context.draftId);
        if (previous && !previous.acknowledged && previous.session_id !== context.sessionId) throw new Error('Recover the previous camera session before starting another.');
        const journal: NativeCaptureJournal = { ...context, revision: (previous?.revision || 0) + 1, lots, updatedAt: new Date().toISOString() };
        assertOwner(expected);
        await (await db()).runAsync(`INSERT INTO capture_pending_camera(owner_id,draft_id,session_id,revision,data) VALUES(?,?,?,?,?)
          ON CONFLICT(owner_id,draft_id) DO UPDATE SET session_id=excluded.session_id,revision=excluded.revision,data=excluded.data,acknowledged=0`,
          expected, context.draftId, context.sessionId, journal.revision, JSON.stringify(journal));
        assertOwner(expected);
        return journal;
      });
    },
    async getPendingCapture(context: CaptureContext): Promise<NativeCaptureJournal | null> {
      const expected = requireOwner();
      if (context.ownerId !== expected) throw new Error('The camera belongs to another account.');
      await initialize(); assertOwner(expected);
      const row = await (await db()).getFirstAsync<{ data: string }>('SELECT data FROM capture_pending_camera WHERE owner_id=? AND draft_id=? AND acknowledged=0', expected, context.draftId);
      assertOwner(expected);
      return row ? readJson<NativeCaptureJournal>(row.data) : null;
    },
    async acknowledgePendingCapture(context: CaptureContext, revision: number): Promise<boolean> {
      const expected = requireOwner();
      if (context.ownerId !== expected) throw new Error('The camera belongs to another account.');
      return serialize(async () => {
        await initialize(); assertOwner(expected);
        const result = await (await db()).runAsync("UPDATE capture_pending_camera SET acknowledged=1,data='{}' WHERE owner_id=? AND draft_id=? AND session_id=? AND revision=? AND acknowledged=0",
          expected, context.draftId, context.sessionId, revision);
        return result.changes === 1;
      });
    },
    async getDraft(id: string) { return readDraft(id, requireOwner()); },
    async listContinuations(): Promise<DurableContinuationIntent[]> {
      const expected = requireOwner(); await initialize();
      const rows = await (await db()).getAllAsync<{ data: string }>('SELECT data FROM report_upload_continuations WHERE owner_id=? ORDER BY rowid', expected);
      assertOwner(expected); return rows.map(row => readJson<DurableContinuationIntent>(row.data));
    },
    async prepareContinuation(intent: DurableContinuationIntent): Promise<DurableContinuationIntent> {
      const expected = requireOwner();
      if (intent.ownerId !== expected) throw new Error('The signed-in account changed.');
      return serialize(async () => {
        const parent = await readDraft(intent.parentDraftId, expected);
        if (!parent || parent.captureId !== intent.parentCaptureId || parent.formData.clientSubmissionId !== intent.parentClientSubmissionId ||
            parent.localRevision !== intent.parentRevision || parent.formData.auctioneerWorkItemId !== intent.parentWorkItemId || hidden(parent)) {
          throw new Error('The saved parent changed before Continue. Reopen its original draft.');
        }
        const row = await (await db()).getFirstAsync<{ data: string }>('SELECT data FROM report_upload_continuations WHERE owner_id=? AND parent_work_item_id=?', expected, intent.parentWorkItemId);
        const old = row ? readJson<DurableContinuationIntent>(row.data) : undefined;
        if (old && (old.parentDraftId !== intent.parentDraftId || old.parentCaptureId !== intent.parentCaptureId || old.parentClientSubmissionId !== intent.parentClientSubmissionId)) {
          throw new Error('This work item already has a different saved Continue request. Open it from Drafts.');
        }
        if (old && old.stage !== 'prepared') throw new Error('This Continue request is already staged. Retry opening its next lot from Drafts; do not submit it again.');
        const next = old ? { ...intent, id: old.id, successorDraftId: old.successorDraftId, successorCaptureId: old.successorCaptureId, createdAt: old.createdAt } : intent;
        assertOwner(expected);
        await (await db()).runAsync('INSERT INTO report_upload_continuations(owner_id,id,parent_work_item_id,data) VALUES(?,?,?,?) ON CONFLICT(owner_id,id) DO UPDATE SET data=excluded.data', expected, next.id, next.parentWorkItemId, JSON.stringify(next));
        assertOwner(expected); continuationListeners.forEach(listener => listener()); return next;
      });
    },
    async updateContinuation(id: string, change: (intent: DurableContinuationIntent) => DurableContinuationIntent): Promise<DurableContinuationIntent> {
      const expected = requireOwner();
      return serialize(async () => {
        await initialize(); assertOwner(expected);
        const row = await (await db()).getFirstAsync<{ data: string }>('SELECT data FROM report_upload_continuations WHERE owner_id=? AND id=?', expected, id);
        if (!row) throw new Error('The saved Continue request is unavailable.');
        const old = readJson<DurableContinuationIntent>(row.data), next = change(old);
        if (next.id !== old.id || next.ownerId !== expected || next.type !== old.type || next.parentRevision !== old.parentRevision || next.parentDraftId !== old.parentDraftId || next.parentWorkItemId !== old.parentWorkItemId ||
            next.parentCaptureId !== old.parentCaptureId || next.parentClientSubmissionId !== old.parentClientSubmissionId ||
            next.successorDraftId !== old.successorDraftId || next.successorCaptureId !== old.successorCaptureId) throw new Error('The Continue identity changed.');
        assertOwner(expected);
        await (await db()).runAsync('UPDATE report_upload_continuations SET data=? WHERE owner_id=? AND id=?', JSON.stringify({ ...next, updatedAt: new Date().toISOString() }), expected, id);
        assertOwner(expected); continuationListeners.forEach(listener => listener()); return next;
      });
    },
    async recordDraftOpened(id: string, eventId: string) {
      const expected = requireOwner();
      if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(eventId)) throw new Error('Invalid review event identity.');
      return serialize(async () => {
        const draft = await readDraft(id, expected);
        if (!draft || hidden(draft)) throw new Error('The saved draft is unavailable.');
        const state = nativeActivityState(draft);
        const counts = activityCounts(state);
        const event: DeviceActivity = {
          eventId, activityId: draft.captureId || draft.id, reportType: draft.type,
          contract: draft.contractNo || '', source: Platform.OS === 'ios' ? 'ios' : 'android',
          sequence: draft.localRevision || 0, sequenceScope: draft.captureId || draft.id,
          observedAt: new Date().toISOString(), appVersion: getAppVersionLabel(),
          action: 'draft_opened', outcome: 'completed',
          data: { beforeCounts: counts, afterCounts: counts, uploadLogo: state.logo,
            cameraStamp: state.lots.some(lot => [...lot.main, ...lot.extra].some(photo => photo.camera)) ? 'camera_reported' : 'not_recorded', captureMode: state.mode },
        };
        await (await db()).withExclusiveTransactionAsync(async tx => {
          assertOwner(expected);
          const inserted = await tx.runAsync('INSERT OR IGNORE INTO report_activity_seen(owner_id,event_id) VALUES(?,?)', expected, eventId);
          if (inserted.changes) await tx.runAsync('INSERT INTO report_activity_outbox(owner_id,event_id,data) VALUES(?,?,?)', expected, eventId, JSON.stringify(event));
          assertOwner(expected);
        });
      });
    },
    async listDrafts(type?: OfflineReportDraft['type']): Promise<OfflineReportDraft[]> {
      if (!ownerId) return [];
      const expected = ownerId;
      await initialize();
      const rows = await (await db()).getAllAsync<DraftRow>(`SELECT data,revision FROM capture_drafts WHERE owner_id = ?${type ? ' AND type = ?' : ''} ORDER BY updated_at DESC`, ...[expected, ...(type ? [type] : [])]);
      assertOwner(expected);
      return rows.map((row) => ({ ...readJson<OfflineReportDraft>(row.data), ownerId: expected, localRevision: row.revision })).filter((draft) => !hidden(draft));
    },
    async listSummaries(type?: OfflineReportDraft['type']): Promise<OfflineDraftSummary[]> {
      if (!ownerId) return [];
      const expected = ownerId; await initialize();
      const rows = await (await db()).getAllAsync<{ data: string; message?: string }>(`SELECT s.data,e.message FROM capture_summaries s LEFT JOIN capture_inventory_errors e ON e.owner_id=s.owner_id AND e.draft_id=s.draft_id WHERE s.owner_id=? AND s.hidden=0${type ? ' AND s.type=?' : ''} ORDER BY s.updated_at DESC`, expected, ...(type ? [type] : []));
      assertOwner(expected);
      return rows.map((row) => ({ ...readJson<OfflineDraftSummary>(row.data), inventoryError: row.message || undefined }));
    },
    async saveDraft(draft: OfflineReportDraft, explicitSave = false) { const expected = requireOwner(); return serialize(() => persist(draft, expected, undefined, explicitSave)); },
    async createCloudDraft(draft: OfflineReportDraft, expectedOwner: string) {
      assertOwner(expectedOwner);
      if (!expectedOwner || draft.ownerId !== expectedOwner) throw new Error('Sign in to the draft owner account before restoring.');
      // The absence check and insert share the store writer and SQLite transaction.
      // A late cloud response cannot replace a capture, edit, or hidden accepted draft.
      return serialize(() => persist(draft, expectedOwner, undefined, false, true));
    },
    async updateDraft(id: string, change: (draft: OfflineReportDraft) => OfflineReportDraft, explicitSave = false) {
      const expected = requireOwner();
      return serialize(async () => {
        const draft = await readDraft(id, expected);
        if (!draft) throw new Error('The saved draft is unavailable.');
        const next = change(draft);
        if (next === draft) return draft;
        return persist(next, expected, undefined, explicitSave);
      });
    },
    /**
     * Cloud-copy bookkeeping is not an edit, so it is written in place without a
     * new revision. Only the CLOUD_SYNC_FIELDS returned by `change` are applied;
     * return null to leave the draft as it is. A new revision here made a queued
     * Android upload fail its acceptance check ("This draft changed after the
     * upload was saved") when the cloud copy finished syncing just after Submit
     * (phone test 2026-10-11).
     */
    async updateDraftSyncState(id: string, change: (draft: OfflineReportDraft) => Partial<Pick<OfflineReportDraft, CloudSyncField>> | null) {
      const expected = requireOwner();
      return serialize(async () => {
        const draft = await readDraft(id, expected);
        if (!draft) return null;
        const fields = change(draft);
        if (!fields || draft.localRevision == null) return draft;
        const next: OfflineReportDraft = { ...draft };
        for (const key of CLOUD_SYNC_FIELDS) if (key in fields) (next as any)[key] = (fields as any)[key];
        assertOwner(expected);
        // Same revision as read: a save that landed in between wins, and this write is skipped.
        await (await db()).runAsync('UPDATE capture_drafts SET data=? WHERE owner_id=? AND id=? AND revision=?',
          JSON.stringify(next), expected, id, draft.localRevision);
        return next;
      });
    },
    async deleteDraft(id: string) {
      return store.setSubmissionState(id, 'discarded');
    },
    async listLegacyDrafts(): Promise<OfflineReportDraft[]> {
      const expected = requireOwner(); await initialize();
      const rows = await (await db()).getAllAsync<{ id: string; data: string }>('SELECT id,data FROM capture_legacy WHERE kind = ? AND claimed_by IS NULL', 'draft');
      assertOwner(expected);
      return rows.map((row) => ({ ...readJson<OfflineReportDraft>(row.data), id: row.id })).filter((draft) => !draft.ownerId || draft.ownerId === expected);
    },
    async claimLegacyDraft(id: string) {
      const expected = requireOwner();
      return serialize(async () => {
        await initialize(); assertOwner(expected);
        const row = await (await db()).getFirstAsync<{ data: string; claimed_by: string | null }>('SELECT data,claimed_by FROM capture_legacy WHERE id = ? AND kind = ?', id, 'draft');
        if (!row || row.claimed_by) throw new Error('This legacy draft has already been recovered or is unavailable.');
        const draft = readJson<OfflineReportDraft>(row.data);
        if (draft.ownerId && draft.ownerId !== expected) throw new Error('This legacy draft belongs to another account.');
        const existing = await readDraft(draft.id, expected);
        if (existing) throw new Error('A draft with this identity already exists. Review it before recovering another copy.');
        return persist({ ...draft, ownerId: expected, captureMode: 'offline', submissionState: 'local',
          formData: { ...draft.formData, captureMode: 'offline',
            legacyRequiresIncomingReview: legacyNeedsIncomingReview(draft.formData || {}) },
          legacyRecoveredAt: new Date().toISOString(), localRevision: undefined }, expected, id);
      });
    },
    async listLegacyJobs(): Promise<Array<{ id: string; job: Record<string, any> }>> {
      const expected = requireOwner(); await initialize();
      const rows = await (await db()).getAllAsync<{ id: string; data: string }>('SELECT id,data FROM capture_legacy WHERE kind = ? AND claimed_by IS NULL', 'queue');
      assertOwner(expected);
      return rows.map((row) => ({ id: row.id, job: readJson<Record<string, any>>(row.data) })).filter((row) => !row.job.ownerId || row.job.ownerId === expected);
    },
    async acknowledgeLegacyJob(id: string) {
      const expected = requireOwner(); await initialize(); assertOwner(expected);
      await (await db()).runAsync('UPDATE capture_legacy SET claimed_by = ?, claimed_at = ? WHERE id = ? AND kind = ? AND claimed_by IS NULL', expected, new Date().toISOString(), id, 'queue');
    },
    async claimLegacyJobAsDraft(id: string) {
      const expected = requireOwner();
      return serialize(async () => {
        await initialize(); assertOwner(expected);
        const row = await (await db()).getFirstAsync<{ data: string; claimed_by: string | null }>('SELECT data,claimed_by FROM capture_legacy WHERE id = ? AND kind = ?', id, 'queue');
        if (!row || row.claimed_by) throw new Error('This queued report has already been recovered or is unavailable.');
        const job = readJson<Record<string, any>>(row.data);
        if (job.ownerId && job.ownerId !== expected) throw new Error('This legacy queued report belongs to another account.');
        if (!['asset', 'lotListing'].includes(job.type) || !Array.isArray(job.lots)) throw new Error('This legacy queued report cannot be recovered automatically. Its original metadata remains preserved.');
        const details = job.details || {};
        const now = new Date().toISOString();
        const draftId = `recovered-queue-${String(job.id)}`;
        if (await readDraft(draftId, expected)) throw new Error('This report already exists in your recovered drafts.');
        const formData: Record<string, any> = { captureMode: 'offline' };
        // Preserve all detail fields, translating transport spelling without guessing values.
        for (const [key, value] of Object.entries(details)) formData[key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase())] = value;
        formData.clientSubmissionId = details.client_submission_id || details.clientSubmissionId;
        formData.auctioneerSnapshot = job.auctioneerSnapshot || details.auctioneerSnapshot;
        formData.auctionsoftSnapshot = job.auctionsoftSnapshot || details.auctionsoftSnapshot;
        formData.legacyRequiresIncomingReview = legacyNeedsIncomingReview({ ...details, ...formData });
        return persist({ id: draftId, ownerId: expected, type: job.type, title: details.contract_no || details.contractNo || 'Recovered queued report',
          contractNo: details.contract_no || details.contractNo, formData, captureMode: 'offline', submissionState: 'paused',
          submissionError: 'Recovered from an older installation. Review every field and photo before submitting.', legacyRecoveredAt: now,
          lots: job.lots.map((lot: any, index: number) => ({ ...lot, id: lot.id || `recovered-lot-${index}`,
            mainImages: lot.files || lot.mainImages || [], extraImages: lot.extraFiles || lot.extraImages || [],
            videoFiles: lot.videoFiles || (lot.videoFile ? [lot.videoFile] : []), coverIndex: lot.coverIndex || 0 })),
          activeLotIdx: 0, createdAt: job.createdAt || now, updatedAt: now }, expected, id);
      });
    },
    async inventoryCandidates(limit = 20, excludedIds: string[] = []): Promise<Array<{ draftId: string; revision: number; draft: OfflineReportDraft }>> {
      if (!ownerId) return [];
      const expected = ownerId; await initialize();
      const excluded = [...new Set(excludedIds)].slice(0, 100);
      const rows = await (await db()).getAllAsync<DraftRow & { id: string }>(`SELECT d.id,d.data,o.revision FROM capture_outbox o
        JOIN capture_drafts d ON d.owner_id=o.owner_id AND d.id=o.draft_id
        WHERE o.owner_id=? AND o.revision>o.acknowledged_revision AND NOT EXISTS (SELECT 1 FROM capture_inventory_errors e WHERE e.owner_id=o.owner_id AND e.draft_id=o.draft_id AND e.revision=o.revision)${excluded.length ? ` AND d.id NOT IN (${excluded.map(() => '?').join(',')})` : ''} ORDER BY d.updated_at,d.id LIMIT ?`, expected, ...excluded, Math.max(1, Math.min(100, limit)));
      assertOwner(expected);
      return rows.map((row) => ({ draftId: row.id, revision: row.revision, draft: readJson<OfflineReportDraft>(row.data) }));
    },
    async acknowledgeInventory(id: string, revision: number) {
      const expected = requireOwner(); await initialize(); assertOwner(expected);
      await (await db()).runAsync('UPDATE capture_outbox SET acknowledged_revision = MAX(acknowledged_revision, ?) WHERE owner_id = ? AND draft_id = ? AND revision >= ?', revision, expected, id, revision);
      await (await db()).runAsync('DELETE FROM capture_inventory_errors WHERE owner_id=? AND draft_id=? AND revision<=?', expected, id, revision);
    },
    async recordInventoryError(id: string, revision: number, safeMessage: string) {
      const expected = requireOwner(); await initialize(); assertOwner(expected);
      await (await db()).runAsync(`INSERT INTO capture_inventory_errors(owner_id,draft_id,revision,message)
        SELECT ?,?,?,? FROM capture_outbox WHERE owner_id=? AND draft_id=? AND revision=? AND acknowledged_revision<revision
        ON CONFLICT(owner_id,draft_id) DO UPDATE SET revision=excluded.revision,message=excluded.message`,
        expected, id, revision, safeMessage.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500), expected, id, revision);
    },
    async setSubmissionState(id: string, state: OfflineSubmissionState, reportId?: string, error?: string) {
      return store.updateDraft(id, (draft) => ['accepted', 'submitted'].includes(draft.submissionState || '') && !['accepted', 'submitted', 'discarded'].includes(state) ? draft : ({ ...draft, submissionState: state, reportId: reportId || draft.reportId,
        submissionError: error, ...(state === 'ready' ? { submissionRequestedAt: draft.submissionRequestedAt || new Date().toISOString() } : {}),
        ...(['submitted', 'accepted'].includes(state) ? { submittedAt: new Date().toISOString() } : {}) }));
    },
    async recordTransferAcceptance(id: string, revision: number, captureId: string, submissionId: string, reportId: string) {
      const expected = requireOwner();
      return serialize(async () => {
        const draft = await readDraft(id, expected);
        if (!draft || draft.captureId !== captureId || draft.formData.clientSubmissionId !== submissionId) {
          throw new Error('The accepted upload belongs to an earlier saved capture. Your current draft and originals are kept.');
        }
        if (['accepted', 'submitted'].includes(draft.submissionState || '') && draft.reportId === reportId) return;
        if (draft.localRevision !== revision || hidden(draft)) {
          throw new Error('This draft changed after the upload was saved. Check Previews; the current draft and originals are kept.');
        }
        await persist({ ...draft, submissionState: 'accepted', reportId, submissionError: undefined, submittedAt: new Date().toISOString() }, expected);
      });
    },
    async getProtectedMediaUris(): Promise<string[]> {
      await initialize();
      const rows = await (await db()).getAllAsync<{ data: string }>('SELECT data FROM capture_media');
      const legacy = await (await db()).getAllAsync<{ data: string }>('SELECT data FROM capture_legacy WHERE kind != ?', 'source');
      const pending = await (await db()).getAllAsync<{ data: string }>('SELECT data FROM capture_pending_camera');
      const backupRefs = await (await db()).getAllAsync<{ uri: string }>('SELECT uri FROM capture_backup_media_refs');
      const keep = new Set<string>();
      const visit = (value: unknown) => {
        if (typeof value === 'string' && /^(file|content|ph):\/\//.test(value)) keep.add(value);
        else if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object') Object.values(value).forEach(visit);
      };
      [...rows, ...legacy, ...pending].forEach((row) => { try { visit(JSON.parse(row.data)); } catch { /* retained raw quarantine */ } });
      backupRefs.forEach(row => keep.add(row.uri));
      return [...keep];
    },
  };
  return store;
}

export const OfflineCaptureStore = createOfflineCaptureStore(async () => {
  // Avoid initializing a native database at module import or before the owner has signed in.
  const SQLite = await import('expo-sqlite');
  return SQLite.openDatabaseAsync('asset-insight-capture-v1.db');
});
export default OfflineCaptureStore;
