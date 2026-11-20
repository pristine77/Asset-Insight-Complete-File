import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SQLiteDatabase } from 'expo-sqlite';
import { beginDraftUpload, draftUploadSchema, recoverDraftUploads, updateDraftUpload } from './draftUploadJournal';

const { DatabaseSync } = require('node:sqlite');
const context = { activityId: 'capture-a', reportType: 'asset' as const, contract: 'TEST', source: 'android' as const };
function open(file: string) {
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE IF NOT EXISTS report_activity_outbox(owner_id TEXT, event_id TEXT, data TEXT, PRIMARY KEY(owner_id,event_id));' + draftUploadSchema);
  const tx = {
    getFirstAsync: async (sql: string, ...args: unknown[]) => db.prepare(sql).get(...args),
    getAllAsync: async (sql: string, ...args: unknown[]) => db.prepare(sql).all(...args),
    runAsync: async (sql: string, ...args: unknown[]) => {
      const result = db.prepare(sql).run(...args);
      return { changes: result.changes, lastInsertRowId: result.lastInsertRowid };
    },
  } as unknown as SQLiteDatabase;
  return { db, tx, events: () => db.prepare('SELECT data FROM report_activity_outbox ORDER BY rowid').all().map((row: {data: string}) => JSON.parse(row.data)) };
}

it('preserves the exact receipt checkpoint across database close/reopen and reports the unknown stop once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-upload-test-'));
  const file = path.join(dir, 'draft.db');
  const first = open(file);
  const attempt = await beginDraftUpload(first.tx, 'a', 'draft', 'runtime-1', context);
  await updateDraftUpload(first.tx, 'a', attempt, { verified: 490, total: 1109 });
  await updateDraftUpload(first.tx, 'a', attempt, { verified: 493, total: 1109 });
  await recoverDraftUploads(first.tx, 'a', 'runtime-1');
  first.db.close();
  const next = open(file);
  try {
    await recoverDraftUploads(next.tx, 'other', 'runtime-2');
    expect(next.events().map((e: any) => e.action)).toEqual(['draft_upload_started', 'draft_upload_progress']);
    await recoverDraftUploads(next.tx, 'a', 'runtime-2');
    await recoverDraftUploads(next.tx, 'a', 'runtime-2');
    expect(next.events().at(-1)).toMatchObject({action:'draft_upload_interrupted', data:{draftUploadReason:'no_completion_record',draftUploadCounts:{verified:493,total:1109}}});
    const resumed = await beginDraftUpload(next.tx, 'a', 'draft', 'runtime-2', context);
    await updateDraftUpload(next.tx, 'a', attempt, 'finished'); // terminal callback from an obsolete attempt
    await updateDraftUpload(next.tx, 'other', resumed, 'finished');
    expect(next.events().at(-1).action).toBe('draft_upload_resumed');
    await updateDraftUpload(next.tx, 'a', resumed, {verified:1109,total:1109});
    await updateDraftUpload(next.tx, 'a', resumed, 'finished');
    await recoverDraftUploads(next.tx, 'a', 'runtime-3');
    const events = next.events();
    expect(events.filter((e:any) => e.action==='draft_upload_interrupted')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({action:'draft_upload_finished',data:{draftUploadCounts:{verified:1109,total:1109}}});
    expect(new Set(events.map((e:any) => e.eventId)).size).toBe(events.length);
  } finally {next.db.close(); fs.rmSync(dir,{recursive:true,force:true});}
});

it('omits a stale partial count when the final verification succeeds after a missed progress write', async () => {
  const store = open(':memory:');
  try {
    const attempt = await beginDraftUpload(store.tx, 'owner', 'draft', 'runtime', context);
    await updateDraftUpload(store.tx, 'owner', attempt, { verified: 10, total: 24 });
    await updateDraftUpload(store.tx, 'owner', attempt, 'finished');
    expect(store.events().at(-1)).toMatchObject({ action: 'draft_upload_finished', data: {} });
    expect(store.events().at(-1).data).not.toHaveProperty('draftUploadCounts');
  } finally {
    store.db.close();
  }
});
