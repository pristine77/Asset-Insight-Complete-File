import { createOfflineCaptureStore, countOfflineDraft } from './offlineCaptureStore';
import type { OfflineReportDraft } from './autoSaveService';
import type { DurableContinuationIntent } from './durableContinuationTypes';
import { canResumeDraftSnapshot, uploadResumeDraftKey } from './uploadResumeDraft';

jest.mock('@react-native-async-storage/async-storage', () => ({ multiGet: jest.fn(async () => []) }));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'capture-uuid' }));

// Exercise the actual SQL against SQLite, not a mock of the store's behaviour.
const { DatabaseSync } = require('node:sqlite');
function fixtureStore(legacy: Array<[string, string]> = []) {
  const database = new DatabaseSync(':memory:');
  const statements: string[] = [];
  const adapter: any = {
    execAsync: async (sql: string) => database.exec(sql),
    runAsync: async (sql: string, ...values: any[]) => { statements.push(sql); return database.prepare(sql).run(...values); },
    getFirstAsync: async (sql: string, ...values: any[]) => database.prepare(sql).get(...values) || null,
    getAllAsync: async (sql: string, ...values: any[]) => { statements.push(sql); return database.prepare(sql).all(...values); },
    withExclusiveTransactionAsync: async (work: (tx: any) => Promise<void>) => {
      database.exec('BEGIN IMMEDIATE');
      try { await work(adapter); database.exec('COMMIT'); }
      catch (error) { database.exec('ROLLBACK'); throw error; }
    },
  };
  const store = createOfflineCaptureStore(async () => adapter, { multiGet: async () => legacy } as any);
  store.setOwner('owner-one');
  return { store, statements, database };
}
const draft = (id = 'draft-one', count = 2): OfflineReportDraft => ({
  id, type: 'asset', captureMode: 'offline', title: '93530', contractNo: '93530',
  formData: { contractNo: '93530', clientSubmissionId: `submission-${id}` },
  lots: [{ id: 'lot-one', mainImages: Array.from({ length: count }, (_, i) => ({
    uri: `content://media/external/images/media/${i}`, name: `${i}.jpg`, type: 'image/jpeg', mediaId: `photo-${i}`,
  })), extraImages: [], videoFiles: [], coverIndex: 0 }], activeLotIdx: 0,
  createdAt: '2026-09-17T10:00:00Z', updatedAt: '2026-09-17T10:00:00Z',
});

describe('owner-scoped offline capture metadata', () => {
  test('foreground retry keeps exact content through real ready/paused revision bumps, but rejects edited or accepted drafts', async () => {
    const { store } = fixtureStore();
    const saved = await store.saveDraft(draft());
    const authority = uploadResumeDraftKey(saved);
    await store.setSubmissionState(saved.id, 'ready');
    await store.setSubmissionState(saved.id, 'paused');
    const paused = (await store.getDraft(saved.id))!;
    expect(paused.localRevision).toBeGreaterThan(saved.localRevision!);
    expect(canResumeDraftSnapshot(paused, authority)).toBe(true);
    await store.saveDraft({ ...paused, formData: { ...paused.formData, ownerName: 'Later typed work' } });
    await store.setSubmissionState(saved.id, 'paused');
    expect(canResumeDraftSnapshot(await store.getDraft(saved.id), authority)).toBe(false);
    const fresh = await store.saveDraft(draft('second'));
    await store.setSubmissionState(fresh.id, 'accepted', 'report');
    expect(canResumeDraftSnapshot(await store.getDraft(fresh.id), uploadResumeDraftKey(fresh))).toBe(false);
  });
  test('Continue journal checkpoints never alter frozen parent revision, originals or accepted visibility', async () => {
    const { store } = fixtureStore();
    const saved = await store.saveDraft({ ...draft(), formData: { ...draft().formData, auctioneerWorkItemId: 'work-parent' } });
    const intent: DurableContinuationIntent = { id: 'intent', ownerId: 'owner-one', type: 'asset', parentDraftId: saved.id,
      parentCaptureId: saved.captureId!, parentRevision: saved.localRevision!, parentClientSubmissionId: saved.formData.clientSubmissionId!, parentWorkItemId: 'work-parent',
      parentSetup: {} as any, details: { ownerName: 'Carried detail' }, successorDraftId: 'child', successorCaptureId: 'child-capture', stage: 'prepared', createdAt: saved.createdAt, updatedAt: saved.updatedAt };
    await store.prepareContinuation(intent);
    const retry = await store.prepareContinuation({ ...intent, id: 'another-intent', successorDraftId: 'different-child', successorCaptureId: 'different-capture' });
    expect(retry).toEqual(intent);
    await store.updateContinuation(intent.id, row => ({ ...row, stage: 'staging', sessionId: 'exact-session' }));
    await expect(store.prepareContinuation(intent)).rejects.toThrow('already staged');
    await store.updateContinuation(intent.id, row => ({ ...row, stage: 'staged' }));
    expect(await store.getDraft(saved.id)).toEqual(saved);
    expect(await store.getProtectedMediaUris()).toHaveLength(2);
    await store.recordTransferAcceptance(saved.id, saved.localRevision!, saved.captureId!, saved.formData.clientSubmissionId!, 'report');
    expect(await store.listDrafts()).toEqual([]);
    expect(await store.listContinuations()).toEqual([expect.objectContaining({ id: 'intent', parentRevision: saved.localRevision, sessionId: 'exact-session' })]);
    store.setOwner('owner-two'); expect(await store.listContinuations()).toEqual([]);
    await expect(store.updateContinuation(intent.id, row => row)).rejects.toThrow('unavailable');
    store.setOwner('owner-one'); expect(await store.getProtectedMediaUris()).toHaveLength(2);
    await expect(store.updateContinuation(intent.id, row => ({ ...row, successorCaptureId: 'other' }))).rejects.toThrow('identity changed');
  });
  test('native transfer acceptance atomically requires its frozen capture, submission and revision while retaining originals', async () => {
    const { store } = fixtureStore();
    const saved = await store.saveDraft(draft());
    await expect(store.recordTransferAcceptance(saved.id, saved.localRevision!, 'other-capture', saved.formData.clientSubmissionId!, 'report')).rejects.toThrow('earlier saved capture');
    const edited = await store.saveDraft({ ...saved, title: 'New edit' });
    await expect(store.recordTransferAcceptance(saved.id, saved.localRevision!, saved.captureId!, saved.formData.clientSubmissionId!, 'report')).rejects.toThrow('draft changed');
    expect((await store.listDrafts())[0].title).toBe('New edit');
    await store.recordTransferAcceptance(edited.id, edited.localRevision!, edited.captureId!, edited.formData.clientSubmissionId!, 'report');
    await store.recordTransferAcceptance(edited.id, edited.localRevision!, edited.captureId!, edited.formData.clientSubmissionId!, 'report');
    expect(await store.listDrafts()).toEqual([]);
    expect(await store.getProtectedMediaUris()).toHaveLength(2);
    expect((await store.getDraft(edited.id))?.reportId).toBe('report');
  });
  test('cloud-copy bookkeeping after Submit keeps the revision, so the queued upload is accepted (phone test 2026-10-11)', async () => {
    const { store } = fixtureStore();
    const queued = await store.saveDraft(draft());
    // The cloud copy finishes syncing after the upload was handed to Android.
    const synced = await store.updateDraftSyncState(queued.id, () => ({ cloudId: 'cloud-1', cloudSyncedAt: '2026-10-11T21:24:50Z', title: 'ignored' } as any));
    expect(synced).toMatchObject({ cloudId: 'cloud-1', localRevision: queued.localRevision, title: queued.title });
    expect(await store.getDraft(queued.id)).toMatchObject({ cloudId: 'cloud-1', localRevision: queued.localRevision, title: '93530' });
    await store.recordTransferAcceptance(queued.id, queued.localRevision!, queued.captureId!, queued.formData.clientSubmissionId!, 'report');
    expect((await store.getDraft(queued.id))?.reportId).toBe('report');
  });
  test('a cloud-sync note never overwrites a save that landed first', async () => {
    const { store } = fixtureStore();
    const first = await store.saveDraft(draft());
    const unchanged = await store.updateDraftSyncState(first.id, () => null);
    expect(unchanged).toMatchObject({ localRevision: first.localRevision });
    // A write that lands between the read and this update (another process or
    // an older code path) moves the revision: the note is dropped, the edit stays.
    const { store: other, database } = fixtureStore();
    const base = await other.saveDraft(draft('raced'));
    await other.updateDraftSyncState(base.id, (current) => {
      database.prepare('UPDATE capture_drafts SET revision = revision + 1, data = ? WHERE id = ?')
        .run(JSON.stringify({ ...current, title: 'Edited meanwhile', localRevision: current.localRevision! + 1 }), base.id);
      return { cloudSyncError: 'stale note' };
    });
    const latest = await other.getDraft(base.id);
    expect(latest).toMatchObject({ title: 'Edited meanwhile', localRevision: base.localRevision! + 1 });
    expect(latest?.cloudSyncError).toBeUndefined();
  });
  test('backup intent commits with the draft and stale native acknowledgements cannot discard a later save', async () => {
    const { store } = fixtureStore();
    const first = await store.saveDraft(draft('backup', 224));
    expect(await store.pendingBackups()).toEqual([first]);
    const next = await store.saveDraft({ ...first, title: 'Edited while backing up' });
    await store.acknowledgeBackupQueue(first.id, first.localRevision!, 'owner-one');
    expect(await store.pendingBackups()).toEqual([next]);
    await store.acknowledgeBackupQueue(next.id, next.localRevision!, 'owner-one');
    expect(await store.pendingBackups()).toEqual([]);
    expect((await store.getDraft(first.id))!.lots[0].mainImages).toHaveLength(224);
  });
  test('unchanged receipt metadata never feeds a backup enqueue loop; new owners cannot acknowledge', async () => {
    const { store } = fixtureStore();
    const first = await store.saveDraft(draft());
    await store.acknowledgeBackupQueue(first.id, first.localRevision!, 'owner-one');
    await store.updateDraft(first.id, item => ({ ...item, cloudSyncedAt: '2026-10-06T00:00:00Z' }));
    expect(await store.pendingBackups()).toEqual([]);
    store.setOwner('owner-two');
    await expect(store.acknowledgeBackupQueue(first.id, first.localRevision!, 'owner-one')).rejects.toThrow('account changed');
  });
  test('a deleted draft produces a durable stop while pending backup originals remain protected', async () => {
    const { store } = fixtureStore();
    const first = await store.saveDraft(draft());
    await store.acknowledgeBackupQueue(first.id, first.localRevision!, 'owner-one');
    const changed = await store.saveDraft({ ...first, lots: [{ ...first.lots[0], mainImages: [] }] });
    expect(await store.getProtectedMediaUris()).toHaveLength(2);
    await store.deleteDraft(changed.id);
    expect((await store.pendingBackups()).some(item => item.submissionState === 'discarded')).toBe(true);
    expect(await store.getProtectedMediaUris()).toHaveLength(2);
  });
  test('seed queues only this owner’s editable offline captures without un-hiding accepted drafts', async () => {
    const { store, database } = fixtureStore();
    const active = await store.saveDraft(draft());
    await store.saveDraft(draft('accepted'));
    await store.setSubmissionState('accepted', 'accepted');
    database.exec('DELETE FROM capture_backup_outbox');
    database.exec('DELETE FROM capture_backup_seeded'); // Simulate captures saved before this feature existed.
    await store.seedBackups();
    expect((await store.pendingBackups()).map(item => item.id)).toEqual([active.id]);
    store.setOwner('other'); await store.seedBackups(); expect(await store.pendingBackups()).toEqual([]);
  });
  test('a shorter save cannot replace original backup intent before Android acknowledges the earlier revision', async () => {
    const { store } = fixtureStore();
    const first = await store.saveDraft(draft('pending-originals', 224));
    const second = await store.saveDraft({ ...first, lots: [{ ...first.lots[0], mainImages: [] }] });
    const pending = await store.pendingBackups();
    expect(pending.map(item => item.localRevision)).toEqual([first.localRevision, second.localRevision]);
    expect(pending[0].lots[0].mainImages).toHaveLength(224);
    expect(pending[1].lots[0].mainImages).toHaveLength(0);
    await store.acknowledgeBackupQueue(second.id, second.localRevision!, 'owner-one');
    expect((await store.pendingBackups())[0].lots[0].mainImages).toHaveLength(224);
  });

  test('reopening after metadata-only receipt updates never seeds an already queued capture again', async () => {
    const { store } = fixtureStore();
    const saved = await store.saveDraft(draft('seed-once'));
    await store.acknowledgeBackupQueue(saved.id, saved.localRevision!, 'owner-one');
    await store.saveDraft({ ...saved, cloudSyncedAt: '2026-10-06T12:00:00Z' });
    await store.seedBackups();
    expect(await store.pendingBackups()).toEqual([]);
    const latest = await store.getDraft(saved.id);
    await store.saveDraft({ ...latest!, title: 'Changed by owner' });
    expect(await store.pendingBackups()).toHaveLength(1);
  });
  test('cloud restore cannot replace a concurrently saved 224-photo draft or its activity', async () => {
    const { store, database } = fixtureStore();
    const captured = await store.saveDraft(draft('nick-shaped-fixture', 224));
    const events = await store.pendingActivity();
    await expect(store.createCloudDraft({ ...draft('nick-shaped-fixture', 50), ownerId: 'owner-one' }, 'owner-one'))
      .rejects.toThrow('already saved');
    expect(await store.getDraft(captured.id)).toEqual(captured);
    expect(await store.pendingActivity()).toEqual(events);
    expect(database.prepare('SELECT count(*) AS count FROM capture_media').get().count).toBe(224);
    expect(await store.getProtectedMediaUris()).toHaveLength(224);
  });
  test('only creates a missing cloud draft, fences owner and keeps hidden accepted originals', async () => {
    const { store } = fixtureStore();
    const saved = await store.createCloudDraft({ ...draft(), ownerId: 'owner-one' }, 'owner-one');
    expect(saved.lots[0].mainImages).toHaveLength(2);
    await store.setSubmissionState(saved.id, 'accepted');
    await expect(store.createCloudDraft({ ...draft(), ownerId: 'owner-one' }, 'owner-one')).rejects.toThrow('already saved');
    store.setOwner('owner-two');
    await expect(store.createCloudDraft({ ...draft('foreign'), ownerId: 'owner-one' }, 'owner-one')).rejects.toThrow('account changed');
    expect(await store.getDraft('foreign')).toBeNull();
    store.setOwner('owner-one');
    expect((await store.getDraft(saved.id))?.submissionState).toBe('accepted');
  });
  test('a no-op stale cloud acknowledgement does not increment the local revision', async () => {
    const { store } = fixtureStore();
    const saved = await store.saveDraft(draft());
    const result = await store.updateDraft(saved.id, current => current);
    expect(result).toEqual(saved);
    expect(await store.getDraft(saved.id)).toEqual(saved);
  });
  test.each(['asset', 'lotListing'] as const)('%s review opens record only metadata and replay safely after acknowledgement', async type => {
    const { store, database, statements } = fixtureStore();
    const saved = await store.saveDraft({ ...draft(), type, formData: { factorsAnalysis: 'Do not send this', watermarkImages: true } });
    await store.acknowledgeActivity((await store.pendingActivity()).map(event => event.eventId), 'owner-one');
    statements.length = 0;
    await store.recordDraftOpened(saved.id, 'review-session-one');
    const events = await store.pendingActivity();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'draft_opened', outcome: 'completed', reportType: type, activityId: saved.captureId,
      data: { beforeCounts: { photos: 2 }, afterCounts: { photos: 2 }, uploadLogo: true, captureMode: 'offline' } });
    expect(JSON.stringify(events)).not.toMatch(/content:\/\/|privateNote|Do not send|\.jpg/);
    expect(await store.getDraft(saved.id)).toEqual(saved);
    expect(statements.some(sql => /INSERT.*capture_(drafts|media)|UPDATE capture_/i.test(sql))).toBe(false);
    await store.recordDraftOpened(saved.id, 'review-session-one');
    expect(await store.pendingActivity()).toEqual(events);
    await store.acknowledgeActivity(['review-session-one'], 'owner-one');
    await store.recordDraftOpened(saved.id, 'review-session-one');
    expect(await store.pendingActivity()).toEqual([]);
    expect(database.prepare('SELECT count(*) AS count FROM report_activity_seen WHERE event_id=?').get('review-session-one').count).toBe(1);
    await store.recordDraftOpened(saved.id, 'review-session-two');
    expect((await store.pendingActivity())[0].eventId).toBe('review-session-two');
    store.setOwner('other-owner');
    await expect(store.recordDraftOpened(saved.id, 'foreign-open')).rejects.toThrow('unavailable');
    store.setOwner('owner-one');
    await store.setSubmissionState(saved.id, 'accepted');
    await expect(store.recordDraftOpened(saved.id, 'accepted-open')).rejects.toThrow('unavailable');
  });
  test('explicit saves record field names without recording each text autosave or private values', async () => {
    const { store } = fixtureStore();
    let saved = await store.saveDraft(draft());
    await store.acknowledgeActivity((await store.pendingActivity()).map(event => event.eventId), 'owner-one');
    saved = await store.saveDraft({ ...saved, formData: { ...saved.formData, factorsAnalysis: 'Private unfinished note' } });
    expect(await store.pendingActivity()).toEqual([]);
    saved = await store.saveDraft({ ...saved, formData: { ...saved.formData, factorsAnalysis: 'Private saved note' } }, true);
    const events = await store.pendingActivity();
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('draft_saved');
    expect(events[0].data.fields).toContain('factorsAnalysis');
    expect(JSON.stringify(events)).not.toContain('Private');
    expect(events[0].data.afterCounts).toMatchObject({ photos: 2 });
  });
  test('commits activity atomically, preserves stable positions, and fences acknowledgements by owner', async () => {
    const { store, database } = fixtureStore();
    let saved = await store.saveDraft(draft());
    const first = await store.pendingActivity();
    expect(first.map(event => event.action)).toContain('photos_imported');
    expect(JSON.stringify(first)).not.toMatch(/content:\/\/|\.jpg/);
    await store.acknowledgeActivity(first.map(event => event.eventId), 'owner-one');
    saved.lots[0].mainImages.reverse(); saved.lots[0].coverIndex = 1;
    saved = await store.saveDraft(saved);
    const reordered = await store.pendingActivity();
    expect(reordered.map(event => event.action)).toEqual(expect.arrayContaining(['photos_reordered', 'cover_changed']));
    const oldPending = database.prepare('SELECT count(*) AS count FROM report_activity_outbox').get().count;
    await expect(store.saveDraft({ ...saved, localRevision: 1 })).rejects.toThrow();
    expect(database.prepare('SELECT count(*) AS count FROM report_activity_outbox').get().count).toBe(oldPending);
    store.setOwner('other'); expect(await store.pendingActivity()).toEqual([]);
    await expect(store.acknowledgeActivity(reordered.map(event => event.eventId), 'owner-one')).rejects.toThrow();
    store.setOwner('owner-one'); expect(await store.pendingActivity()).toEqual(reordered);
  });
  test('native journal replay after acknowledgement cannot duplicate camera actions', async () => {
    const { store } = fixtureStore();
    const journal = { ownerId: 'owner-one', draftId: 'draft-one', sessionId: 'camera-one', revision: 7, lots: [],
      activity: [{ eventId: 'camera-one:7:0', sequence: 7, observedAt: '2026-09-18T00:00:00Z', action: 'photo_captured', outcome: 'completed', data: {} }] };
    await store.stageCameraActivity(journal);
    let saved = await store.saveDraft(draft());
    const events = await store.pendingActivity();
    expect(events.filter(event => event.eventId === 'camera:camera-one:7:0')).toHaveLength(1);
    await store.acknowledgeActivity(events.map(event => event.eventId), 'owner-one');
    await store.stageCameraActivity(journal);
    saved = await store.saveDraft({ ...saved, formData: { ...saved.formData, watermarkImages: true } });
    expect((await store.pendingActivity()).some(event => event.eventId === 'camera:camera-one:7:0')).toBe(false);
  });
  test('fallback camera journals survive a draft failure, protect original references and reject stale acknowledgements', async () => {
    const { store } = fixtureStore();
    const context = { ownerId: 'owner-one', draftId: 'draft-one', sessionId: 'camera-one' };
    const videoFile = { uri: 'content://media/external/video/media/720', name: 'walkthrough.mp4', type: 'video/mp4', size: 8_000_000, mediaId: 'stable-video' };
    const lots = [{ id: 'lot-one', files: [{ uri: 'file:///documents/camera-photos/original.jpg', name: 'original.jpg', type: 'image/jpeg' }], extraFiles: [], coverIndex: 0, videoFile }];
    const first = await store.savePendingCapture(context, lots);
    expect(await store.getPendingCapture(context)).toMatchObject({ revision: first.revision, lots });
    expect(await store.getProtectedMediaUris()).toContain(lots[0].files[0].uri);
    expect(await store.getProtectedMediaUris()).toContain(videoFile.uri);
    await expect(store.savePendingCapture({ ...context, sessionId: 'another' }, lots)).rejects.toThrow('Recover');
    const second = await store.savePendingCapture(context, lots);
    expect(await store.acknowledgePendingCapture(context, first.revision)).toBe(false);
    store.setOwner('owner-two');
    await expect(store.getPendingCapture(context)).rejects.toThrow('another account');
    expect(await store.getPendingCapture({ ...context, ownerId: 'owner-two' })).toBeNull();
    store.setOwner('owner-one');
    expect(await store.acknowledgePendingCapture(context, second.revision)).toBe(true);
    expect(await store.getPendingCapture(context)).toBeNull();
    const third = await store.savePendingCapture(context, lots);
    expect(third.revision).toBeGreaterThan(second.revision);
    expect(await store.acknowledgePendingCapture(context, second.revision)).toBe(false);
  });

  test('same contracts remain separate and retries retain capture identity', async () => {
    const { store } = fixtureStore();
    const a = await store.saveDraft(draft());
    await store.saveDraft(draft('draft-two'));
    const saved = await store.saveDraft({ ...a, title: 'edited' });
    expect(await store.listDrafts()).toHaveLength(2);
    expect(saved.captureId).toBe(a.captureId);
    expect(saved.localRevision).toBe(2);
    await expect(store.saveDraft(a)).rejects.toThrow('changed while saving');
  });

  test('account changes cannot read or mutate another owner partition', async () => {
    const { store } = fixtureStore();
    const a = await store.saveDraft(draft());
    store.setOwner('owner-two');
    expect(await store.listDrafts()).toEqual([]);
    expect(await store.getDraft(a.id)).toBeNull();
    await expect(store.saveDraft(a)).rejects.toThrow('another account');
    store.setOwner(null);
    await expect(store.saveDraft(draft())).rejects.toThrow('Sign in');
  });

  test('5000-photo metadata uses bounded SQL batches and text-only edits do not rewrite media', async () => {
    const { store, statements } = fixtureStore();
    const saved = await store.saveDraft(draft('large', 5000));
    expect(statements.filter((sql) => sql.startsWith('INSERT INTO capture_media'))).toHaveLength(50);
    statements.length = 0;
    await store.saveDraft({ ...saved, title: 'new title' });
    expect(statements.some((sql) => sql.includes('DELETE FROM capture_media') || sql.startsWith('INSERT INTO capture_media'))).toBe(false);
    statements.length = 0;
    const summaries = await store.listSummaries();
    expect(summaries[0].counts.images).toBe(5000);
    expect(statements.some((sql) => sql.includes('FROM capture_drafts'))).toBe(false);
  });

  test('revision-bound acknowledgement cannot erase a later metadata change', async () => {
    const { store } = fixtureStore();
    const saved = await store.saveDraft(draft());
    await store.saveDraft({ ...saved, title: 'updated' });
    await store.acknowledgeInventory(saved.id, 1);
    expect((await store.inventoryCandidates())[0].revision).toBe(2);
    await store.acknowledgeInventory(saved.id, 2);
    expect(await store.inventoryCandidates()).toEqual([]);
  });

  test('terminal inventory errors stop retrying only that revision and clear on the next save', async () => {
    const { store } = fixtureStore();
    const saved = await store.saveDraft(draft());
    await store.saveDraft(draft('unblocked'));
    await store.recordInventoryError(saved.id, 1, 'Review the saved inventory details.');
    expect((await store.inventoryCandidates()).map((item) => item.draftId)).toEqual(['unblocked']);
    expect((await store.listSummaries()).find((item) => item.id === saved.id)?.inventoryError).toContain('Review');
    expect((await store.getDraft(saved.id))?.localRevision).toBe(1);
    await store.saveDraft({ ...saved, title: 'Reviewed' });
    expect((await store.inventoryCandidates()).map((item) => item.draftId)).toContain(saved.id);
    expect((await store.listSummaries()).find((item) => item.id === saved.id)?.inventoryError).toBeUndefined();
    await store.recordInventoryError(saved.id, 1, 'Delayed old failure');
    expect((await store.listSummaries()).find((item) => item.id === saved.id)?.inventoryError).toBeUndefined();
  });

  test('keeps an existing inventory current after switching back to Online and supports bounded reads', async () => {
    const { store } = fixtureStore();
    const saved = await store.saveDraft(draft());
    await store.acknowledgeInventory(saved.id, 1);
    await store.saveDraft({ ...saved, captureMode: 'online', title: 'Updated online' });
    expect((await store.getDraft(saved.id))?.manualSubmissionRequired).toBe(true);
    expect((await store.getDraft(saved.id))?.formData.manualSubmissionRequired).toBe(true);
    await store.saveDraft(draft('next'));
    const [first] = await store.inventoryCandidates(1);
    expect(first.revision).toBe(2);
    expect(first.draft.inventoryAppVersion).toBeDefined();
    expect((await store.inventoryCandidates(1, [first.draftId]))[0].draftId).toBe('next');
  });

  test('accepted and discarded records leave the UI but keep metadata outbox and original references', async () => {
    const { store } = fixtureStore();
    await store.saveDraft(draft());
    await store.setSubmissionState('draft-one', 'accepted', 'report-one');
    await store.setSubmissionState('draft-one', 'paused', undefined, 'Late refresh failure');
    expect((await store.getDraft('draft-one'))?.submissionState).toBe('accepted');
    expect(await store.listDrafts()).toEqual([]);
    expect((await store.inventoryCandidates())[0].draft.reportId).toBe('report-one');
    expect(await store.getProtectedMediaUris()).toHaveLength(2);
    await store.saveDraft(draft('discard'));
    await store.deleteDraft('discard');
    expect((await store.getDraft('discard'))?.submissionState).toBe('discarded');
    expect(await store.listSummaries()).toEqual([]);
  });

  test('legacy sources remain quarantined until explicit claim, preserve missing media and stable IDs', async () => {
    const legacy = draft();
    legacy.lots[0].mainImages[0] = { uri: 'file:///missing.jpg', name: 'missing.jpg', type: 'image/jpeg', missing: true };
    const { store } = fixtureStore([['@clearvalue_offline_report_drafts_v1', JSON.stringify([legacy])]]);
    expect(await store.listDrafts()).toEqual([]);
    expect((await store.listLegacyDrafts())[0].id).toBe('draft:draft-one');
    const claimed = await store.claimLegacyDraft('draft:draft-one');
    expect(claimed.id).toBe('draft-one');
    expect(claimed.ownerId).toBe('owner-one');
    expect(countOfflineDraft(claimed).missingImages).toBe(1);
    await expect(store.claimLegacyDraft('draft:draft-one')).rejects.toThrow('already');
    store.setOwner('owner-two');
    expect(await store.listLegacyDrafts()).toEqual([]);
    expect(await store.getProtectedMediaUris()).toContain('file:///missing.jpg');
  });

  test('known legacy owners cannot be bypassed by the recovery confirmation', async () => {
    const legacy = { ...draft(), ownerId: 'owner-two' };
    const { store } = fixtureStore([['@clearvalue_offline_report_drafts_v1', JSON.stringify([legacy])]]);
    expect(await store.listLegacyDrafts()).toEqual([]);
    await expect(store.claimLegacyDraft('draft:draft-one')).rejects.toThrow('another account');
    store.setOwner('owner-two');
    expect(await store.listLegacyDrafts()).toHaveLength(1);
    expect((await store.claimLegacyDraft('draft:draft-one')).ownerId).toBe('owner-two');
  });

  test('reordered unchanged lots update positions without rewriting images and retain display labels', async () => {
    const { store, database, statements } = fixtureStore();
    const input = draft();
    input.lots[0] = { ...input.lots[0], lotNumber: '157', title: 'Trailer' };
    input.lots.push({ ...input.lots[0], id: 'lot-two', lotNumber: '999', title: 'Tractor' });
    const saved = await store.saveDraft(input);
    statements.length = 0;
    await store.saveDraft({ ...saved, lots: [...saved.lots].reverse() });
    expect(database.prepare('SELECT id FROM capture_lots ORDER BY position').all().map((row: any) => row.id)).toEqual(['lot-two', 'lot-one']);
    expect(statements.some((sql) => sql.startsWith('INSERT INTO capture_media'))).toBe(false);
    expect((await store.listSummaries())[0].counts.perLot[0]).toMatchObject({ lotNumber: '999', title: 'Tractor' });
  });

  test('legacy queued submissions recover as paused review-only drafts without losing mappings or bytes', async () => {
    const { store } = fixtureStore([['@clearvalue_offline_submit_queue_v1', JSON.stringify([{
      id: 'queue-one', type: 'lotListing', details: { contract_no: '93530', client_submission_id: 'original-submit', auctioneer_work_item_id: 'remote-item' },
      lots: [{ id: 'original-lot', files: ['content://media/external/images/media/3'], extraFiles: [], coverIndex: 0 }],
    }])]]);
    const saved = await store.claimLegacyJobAsDraft('queue:queue-one');
    expect(saved.submissionState).toBe('paused');
    expect(saved.formData.clientSubmissionId).toBe('original-submit');
    expect(saved.formData.legacyRequiresIncomingReview).toBe(true);
    expect(saved.lots[0].id).toBe('original-lot');
    expect(saved.lots[0].mainImages).toEqual(['content://media/external/images/media/3']);
    expect(await store.listLegacyJobs()).toEqual([]);
  });

  test.each([
    { auctioneerWorkItemId: 'incoming-one' },
    { auctionManagementTaskId: 'auctionsoft-task' },
    { auctionsoft: { taskId: 'auctionsoft-task', contractId: 'auctionsoft-contract' } },
    { auction_payload: { taskId: 'auctionsoft-task' } },
  ])('legacy imported drafts without their mapping snapshot require Incoming review: %j', async (incoming) => {
    const legacy = { ...draft(), formData: { ...draft().formData, ...incoming } };
    const { store } = fixtureStore([['@clearvalue_offline_report_drafts_v1', JSON.stringify([legacy])]]);
    const recovered = await store.claimLegacyDraft('draft:draft-one');
    expect(recovered.formData.legacyRequiresIncomingReview).toBe(true);
    expect(recovered.formData.captureMode).toBe('offline');
    expect(recovered.manualSubmissionRequired).toBe(true);
    expect(recovered.lots).toEqual(legacy.lots);
  });

  test('a snapshot for the wrong integration does not bypass legacy recovery review', async () => {
    const legacy = { ...draft(), formData: { ...draft().formData, auctionsoft: { taskId: 'task' }, auctioneerSnapshot: { workItemId: 'unrelated' } } };
    const { store } = fixtureStore([['@clearvalue_offline_report_drafts_v1', JSON.stringify([legacy])]]);
    expect((await store.claimLegacyDraft('draft:draft-one')).formData.legacyRequiresIncomingReview).toBe(true);
  });

  test('a failed transaction retains previous complete draft and outbox revision', async () => {
    const { store } = fixtureStore();
    const saved = await store.saveDraft(draft());
    const invalid = { ...saved, lots: [saved.lots[0], { ...saved.lots[0], mainImages: ['file:///different.jpg'] }] };
    // Repeated stable lot IDs are invalid at the API boundary, not collapsed silently.
    await expect(store.saveDraft(invalid)).rejects.toThrow();
    expect((await store.getDraft(saved.id))?.localRevision).toBe(1);
  });
});
