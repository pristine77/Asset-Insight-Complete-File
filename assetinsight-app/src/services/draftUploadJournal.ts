import type { SQLiteDatabase } from 'expo-sqlite';
import type { DeviceActivity } from './reportActivityObservation';

export type DraftReceiptCounts = { verified: number; total: number };
export type DraftUploadReason = 'offline_mode' | 'connection_lost' | 'transport_error' | 'no_progress' |
  'server_error' | 'rate_limited' | 'authentication_required' | 'access_denied' | 'request_conflict' |
  'request_rejected' | 'original_unavailable' | 'receipts_incomplete' | 'invalid_manifest' |
  'no_completion_record' | 'unknown';

export const draftUploadSchema = `
CREATE TABLE IF NOT EXISTS draft_upload_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, draft TEXT NOT NULL, runtime TEXT NOT NULL,
  context TEXT NOT NULL, stopped INTEGER NOT NULL DEFAULT 0, verified INTEGER, total INTEGER, last_reported INTEGER
);
CREATE INDEX IF NOT EXISTS draft_upload_owner ON draft_upload_attempts(owner,stopped,draft);`;

type Context = Pick<DeviceActivity, 'activityId' | 'reportType' | 'source' | 'contract' | 'appVersion'>;
type Attempt = { id: number; owner: string; runtime: string; context: string; verified: number | null; total: number | null; last_reported: number | null };
type Action = 'started' | 'resumed' | 'progress' | 'interrupted' | 'finished';

async function emit(tx: SQLiteDatabase, row: Attempt, action: Action, reason?: DraftUploadReason) {
  const context: Context = JSON.parse(row.context);
  const now = Date.now();
  // The random runtime ID distinguishes attempts even after a phone reinstall or database restore.
  const event: DeviceActivity = { ...context, action: `draft_upload_${action}`,
    eventId: `draft-sync:${row.runtime}:${row.id}:${action}:${row.verified ?? 'none'}`,
    sequenceScope: context.activityId, sequence: now, observedAt: new Date(now).toISOString(),
    outcome: action === 'interrupted' ? 'failed' : action === 'finished' ? 'completed' : 'requested',
    data: { ...(reason ? { draftUploadReason: reason } : {}),
      ...(row.verified == null ? {} : { draftUploadCounts: { verified: row.verified, total: row.total } }) } };
  await tx.runAsync('INSERT INTO report_activity_outbox(owner_id,event_id,data) VALUES(?,?,?)', row.owner, event.eventId, JSON.stringify(event));
}

export async function recoverDraftUploads(tx: SQLiteDatabase, owner: string, runtime: string) {
  const pending = await tx.getAllAsync<Attempt>('SELECT * FROM draft_upload_attempts WHERE owner=? AND runtime<>? AND stopped=0 ORDER BY id', owner, runtime);
  for (const row of pending) {
    await emit(tx, row, 'interrupted', 'no_completion_record');
    await tx.runAsync('UPDATE draft_upload_attempts SET stopped=1 WHERE id=?', row.id);
  }
}

export async function beginDraftUpload(tx: SQLiteDatabase, owner: string, draft: string, runtime: string, context: Context) {
  await recoverDraftUploads(tx, owner, runtime);
  const prior = await tx.runAsync('DELETE FROM draft_upload_attempts WHERE owner=? AND draft=? AND stopped=1', owner, draft);
  const result = await tx.runAsync('INSERT INTO draft_upload_attempts(owner,draft,runtime,context) VALUES(?,?,?,?)', owner, draft, runtime, JSON.stringify(context));
  const row = { id: result.lastInsertRowId, owner, runtime, context: JSON.stringify(context), verified: null, total: null, last_reported: null };
  await emit(tx, row, prior.changes ? 'resumed' : 'started');
  return row.id;
}

export async function updateDraftUpload(
  tx: SQLiteDatabase, owner: string, id: number, update: DraftReceiptCounts | 'finished' | DraftUploadReason
) {
  const row = await tx.getFirstAsync<Attempt>('SELECT * FROM draft_upload_attempts WHERE id=? AND owner=? AND stopped=0', id, owner);
  if (!row) return;
  if (typeof update === 'object') {
    if (!Number.isSafeInteger(update.total) || !Number.isSafeInteger(update.verified) || update.verified < 0 ||
        update.verified > update.total || (row.total != null && row.total !== update.total) ||
        (row.verified != null && update.verified <= row.verified)) return;
    row.verified = update.verified; row.total = update.total;
    // Retain every receipt checkpoint locally. Bound the timeline to roughly ten progress notices per attempt.
    if (row.last_reported == null || update.verified - row.last_reported >= Math.max(10, Math.ceil(update.total / 10))) {
      await emit(tx, row, 'progress');
      row.last_reported = update.verified;
    }
    await tx.runAsync('UPDATE draft_upload_attempts SET verified=?,total=?,last_reported=? WHERE id=?', row.verified, row.total, row.last_reported, id);
  } else if (update === 'finished') {
    // A prior best-effort journal write may have failed. Never attach a stale partial
    // count to the successful final verification.
    if (row.verified !== row.total) row.verified = null;
    await emit(tx, row, 'finished');
    await tx.runAsync('DELETE FROM draft_upload_attempts WHERE id=?', id);
  } else {
    await emit(tx, row, 'interrupted', update);
    await tx.runAsync('UPDATE draft_upload_attempts SET stopped=1 WHERE id=?', id);
  }
}
