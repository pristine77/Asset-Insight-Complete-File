import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { ReportActivity, ReportActivityEvent, ReportActivityDeletion } from "../models/reportActivity.model.js";
import { activityChanges, activityHash, activitySnapshot, CLIENT_ACTIVITY_ACTIONS } from "../utils/reportActivitySnapshot.js";
import { currentActivityContext } from "../utils/reportActivityContext.js";

export class ActivityError extends Error {
  constructor(message: string, public statusCode = 400, public code = "INVALID_ACTIVITY") { super(message); }
}
export type ActivityEntry = { stream: any; event: any };
const objectId = (value: unknown) => typeof value === "string" && /^[a-f\d]{24}$/i.test(value);
const text = (value: unknown, max = 160) => typeof value === "string" && value.length <= max && !/[\u0000-\u001f]/.test(value) ? value : "";
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

export function buildServerActivity(beforeDoc: any, afterDoc: any, model: string, deleted = false): ActivityEntry[] {
  const context = currentActivityContext();
  const before = beforeDoc ? activitySnapshot(beforeDoc, model) : null;
  const after = activitySnapshot(afterDoc || beforeDoc, model);
  if (!objectId(after.owner) || !["asset", "lotListing"].includes(after.reportType)) return [];
  const activityId = beforeDoc?.activity_id || afterDoc?.activity_id || context.activityId || after.activityId;
  const streamId = beforeDoc?.activity_stream_id || afterDoc?.activity_stream_id || activityHash(`${after.owner}\0${after.reportType}\0${activityId}`);
  const changes = activityChanges(before, after);
  const oldLots = new Map((before?.lots || []).map((lot: any) => [lot.id, lot]));
  const nextLots = new Map(after.lots.map((lot: any) => [lot.id, lot]));
  const lotChanges: any[] = [];
  for (const id of new Set([...oldLots.keys(), ...nextLots.keys()])) {
    const old = oldLots.get(id) as any, next = nextLots.get(id) as any;
    if (same(old, next)) continue;
    const positions = [];
    for (const slot of ["main", "extra"]) {
      const oldPhotos = new Map<string, number>((old?.[slot] || []).map((photo: string, position: number) => [photo, position]));
      const nextPhotos = new Map<string, number>((next?.[slot] || []).map((photo: string, position: number) => [photo, position]));
      for (const photo of new Set([...oldPhotos.keys(), ...nextPhotos.keys()])) if (oldPhotos.get(photo) !== nextPhotos.get(photo)) positions.push({ id: photo, slot, before: oldPhotos.get(photo) ?? null, after: nextPhotos.get(photo) ?? null });
    }
    // Chunk large photo changes; no event repeats an entire report manifest.
    for (let offset = 0; offset < Math.max(positions.length, 1); offset += 100) lotChanges.push({
      id, lotNumber: next?.lotNumber || old?.lotNumber, beforePosition: old?.position ?? null, afterPosition: next?.position ?? null,
      before: old ? { mainPhotos: old.main.length, extraPhotos: old.extra.length, cover: old.cover } : null,
      after: next ? { mainPhotos: next.main.length, extraPhotos: next.extra.length, cover: next.cover } : null,
      photos: positions.slice(offset, offset + 100),
    });
  }
  const actions = new Set<string>();
  if (!beforeDoc?.activity_stream_id) actions.add("history_started");
  if (deleted) actions.add(model === "ReportDraft" ? "draft_deleted" : beforeDoc?.is_draft_preview ? "preview_deleted" : "report_deleted");
  else if (model === "AuctioneerWorkItem") {
    if (before?.deliveryStatus !== after.deliveryStatus && !["not_ready", "ready", null].includes(after.deliveryStatus)) actions.add("auction_delivery");
  }
  else {
    if (changes.length || lotChanges.length) actions.add(model === "ReportDraft" ? "draft_saved" : model === "ReportUploadSession" ? "upload_started" : "preview_saved");
    if (before && before.watermark !== after.watermark) actions.add("logo_changed");
    if (model === "ReportUploadSession" && before?.uploadedPhotos !== after.uploadedPhotos) actions.add("upload_progress");
    if (before?.status !== after.status || before?.jobStatus !== after.jobStatus) {
      if (after.status === "uploading" && model === "ReportUploadSession") actions.add("upload_started");
      if (["queued", "processed"].includes(after.status) && model === "ReportUploadSession") actions.add("upload_accepted");
      if (after.status === "preview") actions.add("preview_ready");
      if (after.status === "approved") actions.add("approved");
      if (after.status === "declined") actions.add("declined");
      if ([after.status, after.jobStatus].some(status => ["error", "failed"].includes(status))) actions.add("generation_failed");
      if (["queued", "processing"].includes(after.jobStatus)) actions.add("generation_started");
      if (["completed", "done"].includes(after.jobStatus) && after.filesReady) actions.add("generation_completed");
      if ([after.status, after.jobStatus].includes("cancelled")) actions.add("cancelled");
    }
    if (after.submitted && !before?.submitted) actions.add("preview_submitted");
    if (after.filesReady && !before?.filesReady) actions.add("generation_completed");
    if (after.status === "approved" && after.filesReady && after.release === "released" && (before?.release !== after.release || before?.status !== "approved" || !before?.filesReady)) actions.add("released");
    if (before && before.owner !== after.owner) actions.add("reassigned");
    if (context.path.includes("resubmit") || context.path.includes("retry-processing")) actions.add("retry_requested");
  }
  if (!actions.size) return [];
  const now = new Date();
  const stream = { _id: streamId, activityId, owner: after.owner, reportType: after.reportType, contract: after.contract,
    reportId: after.reportId, draftId: after.draftId, captureId: after.captureId, submissionId: after.submissionId, uploadSessionId: after.uploadSessionId, source: context.source, latestCounts: after.counts };
  const operationId = randomUUID();
  const entries: ActivityEntry[] = [];
  const detailAction = [...actions].find(action => action !== "history_started");
  const fieldChunks: any[][] = [[]];
  for (const change of changes) {
    let current = fieldChunks[fieldChunks.length - 1];
    if (current.length && (current.length >= 30 || Buffer.byteLength(JSON.stringify([...current, change])) > 150 * 1024)) { current = []; fieldChunks.push(current); }
    current.push(change);
  }
  for (const action of actions) {
    const includeChanges = action === detailAction;
    const chunks = includeChanges ? Math.max(1, fieldChunks.length, lotChanges.length) : 1;
    for (let chunk = 0; chunk < chunks; chunk++) {
      const eventId = `${operationId}:${action}:${chunk}`;
      const data = { beforeCounts: before?.counts ?? null, afterCounts: after.counts,
        fields: includeChanges ? fieldChunks[chunk] || [] : [], lots: includeChanges && lotChanges[chunk] ? [lotChanges[chunk]] : [],
        uploadLogo: after.watermark, previousUploadLogo: before?.watermark ?? null,
        cameraStamp: "not_recorded", destination: after.deliveryDestination || after.destination, generationId: after.generationId,
        deliveryStatus: after.deliveryStatus,
        error: after.error, verifiedLogoReceipts: context.verifiedLogoReceipts,
        status: after.status, previousStatus: before?.status ?? null, uploadedPhotos: after.uploadedPhotos,
        operationId, part: chunk + 1, parts: chunks,
      };
      entries.push({ stream, event: { _id: activityHash(`${streamId}\0${eventId}`), activity: streamId, eventId,
        owner: after.owner, actor: context.actor, actorRole: context.actorRole, source: context.source,
        authority: "server", action, outcome: action === "auction_delivery" ? (after.deliveryStatus === "sent" ? "completed" : ["failed", "needs_reconciliation"].includes(after.deliveryStatus) ? "failed" : "accepted") : action === "generation_failed" ? "failed" : action === "generation_started" || action === "preview_submitted" ? "accepted" : "completed",
        observedAt: now, receivedAt: now, device: context.device, appVersion: context.appVersion, data,
        contentHash: activityHash(JSON.stringify({ action, data })),
      } });
    }
  }
  return entries;
}

export async function persistActivityEntry({ stream, event }: ActivityEntry) {
  const existing = await ReportActivity.findById(stream._id).lean() as any;
  if (existing?.removedAt) return { removed: true };
  if (!existing) {
    try { await ReportActivity.create({ ...stream, lastReceivedAt: event.receivedAt, revision: 0 }); }
    catch (error: any) { if (error?.code !== 11000) throw error; }
  }
  const active = await ReportActivity.findOne({ _id: stream._id, removedAt: null }).select("+deviceSequences").lean() as any;
  if (!active) return { removed: true };
  if (event.authority === "device" && String(active.owner) !== String(event.owner)) throw new ActivityError("This activity belongs to a different owner.", 403, "ACTIVITY_OWNER_CHANGED");
  const prior = await ReportActivityEvent.findById(event._id).select("+contentHash +projected").lean() as any;
  if (prior) {
    if (prior.contentHash !== event.contentHash) throw new ActivityError("The event ID was reused with different content.", 409, "ACTIVITY_EVENT_CONFLICT");
    if (prior.projected) return { idempotent: true };
    event = prior; // A retry must not replace the original server receipt time.
  }
  try { if (!prior) await ReportActivityEvent.create(event); }
  catch (error: any) {
    if (error?.code !== 11000) throw error;
    const duplicate = await ReportActivityEvent.findById(event._id).select("+contentHash").lean() as any;
    if (duplicate?.contentHash !== event.contentHash) throw new ActivityError("Conflicting event retry.", 409, "ACTIVITY_EVENT_CONFLICT");
  }
  // Device observations never overwrite a confirmed report's owner, counts or stage.
  const confirmed = event.authority === "server";
  const backupOnly = event.action.startsWith("backup_") || ["upload_queued", "upload_paused", "upload_resumed", "upload_interrupted", "upload_failed"].includes(event.action);
  const sequenceKey = event.authority === "device" ? activityHash(String(event.sequenceScope)) : "";
  const currentSequence = active.deviceSequences?.[sequenceKey];
  if (sequenceKey && currentSequence === undefined && Object.keys(active.deviceSequences || {}).length >= 100) throw new ActivityError("Too many independent device sequences for this report.", 409);
  const update: any = { $max: { lastReceivedAt: event.receivedAt }, $inc: { revision: 1 }, $addToSet: { contracts: stream.contract } };
  if (confirmed && !backupOnly) update.$set = { ...Object.fromEntries(Object.entries(stream).filter(([key, value]) => !["_id", "activityId"].includes(key) && value != null)), latestAction: event.action, latestOutcome: event.outcome, lastConfirmedAt: event.receivedAt,
    ...(["report_deleted", "preview_deleted"].includes(event.action) && event.outcome === "completed" ? { deleted: true } : {}) };
  else if (!active.lastConfirmedAt && (currentSequence == null || currentSequence <= event.sequence)) update.$set = { contract: stream.contract, source: stream.source,
    ...(!backupOnly ? { latestCounts: stream.latestCounts } : {}), latestAction: event.action, latestOutcome: event.outcome };
  // Backup completion confirms only stored bytes. It must never replace a
  // submitted report's counts, owner or workflow stage in the shared timeline.
  if (confirmed && update.$set?.source === "unknown" && active.source !== "unknown") delete update.$set.source;
  if (sequenceKey) update.$max[`deviceSequences.${sequenceKey}`] = event.sequence;
  const sequenceFence = sequenceKey && update.$set ? { $or: [{ [`deviceSequences.${sequenceKey}`]: { $lte: event.sequence } }, { [`deviceSequences.${sequenceKey}`]: { $exists: false } }], lastConfirmedAt: null } : {};
  const projected = await ReportActivity.updateOne({ _id: stream._id, removedAt: null, ...sequenceFence, ...(confirmed ? { $or: [{ lastConfirmedAt: { $lte: event.receivedAt } }, { lastConfirmedAt: null }] } : {}) }, update);
  if (!projected.matchedCount) await ReportActivity.updateOne({ _id: stream._id, removedAt: null }, { $max: { lastReceivedAt: event.receivedAt }, $inc: { revision: 1 } });
  await ReportActivityEvent.updateOne({ _id: event._id }, { $set: { projected: true } });
  // Removal may race insertion. Redact a delayed insert after the permanent tombstone wins.
  if (await ReportActivity.exists({ _id: stream._id, removedAt: { $ne: null } })) await ReportActivityEvent.deleteMany({ activity: stream._id });
  return { idempotent: false };
}

const safeCount = (value: any) => Number.isSafeInteger(value) && value >= 0 && value <= 5000;
function clientCounts(raw: any) {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !["lots", "photos", "mainPhotos", "extraPhotos"].includes(key)) || !Object.values(raw).every(safeCount)) throw new ActivityError("Invalid photo counts.");
  if (![raw.lots, raw.photos, raw.mainPhotos, raw.extraPhotos].every(safeCount) || raw.photos !== raw.mainPhotos + raw.extraPhotos) throw new ActivityError("Photo counts do not add up.");
  return { lots: raw.lots, photos: raw.photos, mainPhotos: raw.mainPhotos, extraPhotos: raw.extraPhotos };
}
export function normalizeClientActivity(raw: any, actor: { id: string; role: string; device?: string }): ActivityEntry {
  const allowed = new Set(["eventId", "activityId", "reportType", "contract", "source", "sequence", "sequenceScope", "observedAt", "appVersion", "action", "outcome", "data"]);
  if (!raw || Object.keys(raw).some(key => !allowed.has(key))) throw new ActivityError("Unsupported activity fields.");
  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(raw.activityId || "") || !/^[a-zA-Z0-9._:-]{1,200}$/.test(raw.eventId || "") || !["asset", "lotListing"].includes(raw.reportType) || !["web", "android", "ios"].includes(raw.source) || !CLIENT_ACTIVITY_ACTIONS.has(raw.action) || !["requested", "completed", "failed"].includes(raw.outcome)) throw new ActivityError("Invalid activity identity or action.");
  if (!Number.isSafeInteger(raw.sequence) || raw.sequence < 1 || !text(raw.sequenceScope) || !text(raw.observedAt, 50) || !Number.isFinite(Date.parse(raw.observedAt))) throw new ActivityError("Invalid device sequence or time.");
  const data = raw.data || {};
  const dataKeys = ["beforeCounts", "afterCounts", "fields", "lots", "uploadLogo", "cameraStamp", "captureMode", "fromLotId", "toLotId", "destination"];
  if (Object.keys(data).some(key => !dataKeys.includes(key))) throw new ActivityError("Only operational metadata may be synchronized.");
  if (!Array.isArray(data.fields || []) || (data.fields || []).length > 100 || (data.fields || []).some((field: any) => !text(field, 160))) throw new ActivityError("Only changed field names may be synchronized.");
  if (![true, false, null, undefined].includes(data.uploadLogo)) throw new ActivityError("Invalid logo selection.");
  if (!["camera_reported", "not_recorded", undefined].includes(data.cameraStamp)) throw new ActivityError("The device cannot assert server verification.");
  const lots = data.lots || [];
  if (!Array.isArray(lots) || lots.length > 100) throw new ActivityError("Too many lot changes in one event.");
  for (const lot of lots) {
    if (!lot || Object.keys(lot).some(key => !["id", "lotNumber", "before", "after", "photos", "beforePosition", "afterPosition", "beforeCover", "afterCover"].includes(key)) || !text(lot.id) || /^(?:file|content|data):/i.test(lot.id)) throw new ActivityError("Invalid lot change.");
    for (const key of ["before", "after"]) if (lot[key] != null && (typeof lot[key] !== "object" || Array.isArray(lot[key]) || !Object.keys(lot[key]).every(field => ["mainPhotos", "extraPhotos"].includes(field)) || ![lot[key].mainPhotos, lot[key].extraPhotos].every(safeCount))) throw new ActivityError("Invalid lot counts.");
    if (!Array.isArray(lot.photos || []) || (lot.photos || []).length > 100) throw new ActivityError("Too many photo changes.");
    for (const photo of lot.photos || []) if (!photo || Object.keys(photo).some(key => !["id", "before", "after", "slot"].includes(key)) || !/^[a-zA-Z0-9._:-]{1,160}$/.test(photo.id || "") || ![photo.before, photo.after].every(value => value === null || safeCount(value)) || (photo.slot && !["main", "extra"].includes(photo.slot))) throw new ActivityError("Invalid photo position.");
    for (const key of ["beforePosition", "afterPosition", "beforeCover", "afterCover"]) if (lot[key] !== undefined && lot[key] !== null && !safeCount(lot[key])) throw new ActivityError("Invalid lot position.");
    if (lot.lotNumber !== undefined && (typeof lot.lotNumber !== "string" || lot.lotNumber.length > 80 || /[\u0000-\u001f]/.test(lot.lotNumber))) throw new ActivityError("Invalid lot number.");
  }
  for (const key of ["captureMode", "fromLotId", "toLotId", "destination"]) if (data[key] != null && (!text(data[key]) || /^(?:file|content|data):/i.test(data[key]))) throw new ActivityError("Invalid operational metadata.");
  const normalized = { ...data, beforeCounts: clientCounts(data.beforeCounts), afterCounts: clientCounts(data.afterCounts) };
  const id = activityHash(`${actor.id}\0${raw.reportType}\0${raw.activityId}`);
  return {
    stream: { _id: id, activityId: raw.activityId, owner: actor.id, reportType: raw.reportType, contract: text(raw.contract), source: raw.source, latestCounts: normalized.afterCounts },
    event: { _id: activityHash(`${id}\0${raw.eventId}`), activity: id, eventId: raw.eventId, owner: actor.id, actor: actor.id, actorRole: actor.role,
      authority: "device", source: raw.source, action: raw.action, outcome: raw.outcome, sequence: raw.sequence, sequenceScope: raw.sequenceScope,
      observedAt: new Date(raw.observedAt), receivedAt: new Date(), device: actor.device || null, appVersion: text(raw.appVersion, 80), data: normalized,
      contentHash: activityHash(JSON.stringify(raw)),
    },
  };
}

export async function drainReportActivity(model: any, id: any) {
  const row = await model.collection.findOne({ _id: id }, { projection: { activity_outbox: 1 } });
  for (const entry of row?.activity_outbox || []) {
    await persistActivityEntry(entry);
    await model.collection.updateOne({ _id: id }, { $pull: { activity_outbox: { "event._id": entry.event._id } } });
  }
}

/** Failure observation only. Actual accepted/completed changes use the mutation outbox. */
export async function recordRejectedActivityRequest(req: any, status: number, attempt = 0): Promise<void> {
  const context = currentActivityContext();
  if (!context.actor) return; // Never record unauthenticated attempts against another user's ID.
  const match = String(req.originalUrl).split("?")[0].match(/^\/api\/(asset|lot-listing)\/([a-f\d]{24})(?:\/(preview|submit-approval|resubmit|retry-processing|cancel-processing))?$/i);
  if (!match) return;
  const model = mongoose.models[match[1] === "asset" ? "AssetReport" : "LotListing"];
  if (!model) return;
  const row = await model.collection.findOne({ _id: new mongoose.Types.ObjectId(match[2]), user: new mongoose.Types.ObjectId(context.actor) });
  if (!row) return; // No disclosure of a rejected target belonging to somebody else.
  const snapshot = activitySnapshot(row, model.modelName);
  const streamId = row.activity_stream_id || activityHash(`${snapshot.owner}\0${snapshot.reportType}\0${snapshot.activityId}`);
  const action = req.method === "DELETE" ? (row.is_draft_preview ? "preview_deleted" : "report_deleted") :
    match[3] === "preview" ? "preview_saved" : match[3] === "cancel-processing" ? "cancelled" :
      ["resubmit", "retry-processing"].includes(match[3]) ? "retry_requested" : "submission_requested";
  const eventId = randomUUID(), now = new Date();
  const data = { beforeCounts: snapshot.counts, afterCounts: snapshot.counts, fields: [], lots: [], uploadLogo: snapshot.watermark,
    cameraStamp: "not_recorded", error: `Request rejected (HTTP ${status}). No successful ${action.includes("deleted") ? "deletion" : "operation"} was confirmed.` };
  const entry: ActivityEntry = { stream: { _id: streamId, activityId: row.activity_id || snapshot.activityId, owner: snapshot.owner,
    reportType: snapshot.reportType, contract: snapshot.contract, reportId: snapshot.reportId, source: context.source, latestCounts: snapshot.counts },
    event: { _id: activityHash(`${streamId}\0${eventId}`), activity: streamId, eventId, owner: snapshot.owner,
      actor: context.actor, actorRole: context.actorRole, source: context.source, authority: "server", action, outcome: "failed",
      observedAt: now, receivedAt: now, device: context.device, appVersion: context.appVersion, data, contentHash: activityHash(JSON.stringify({ action, data })) } };
  // Append, don't replace; a concurrent successful save keeps all of its audit intent.
  const staged = await model.collection.updateOne({ _id: row._id, user: row.user, activity_delete_token: { $exists: false },
    activity_revision: row.activity_revision ?? { $exists: false } },
    { $set: { activity_id: entry.stream.activityId, activity_stream_id: streamId }, $inc: { activity_revision: 1 }, $push: { activity_outbox: entry } } as any);
  if (staged.matchedCount) scheduleReportActivity(model, row._id);
  else if (attempt < 3) await recordRejectedActivityRequest(req, status, attempt + 1);
}
const dispatchQueue = new Map<string, { model: any; id: any }>();
const dispatches = new Set<Promise<void>>();
export function scheduleReportActivity(model: any, id: any) {
  dispatchQueue.set(`${model.modelName}:${id}`, { model, id });
  pumpActivityDispatch();
}
function pumpActivityDispatch() {
  while (dispatches.size < 4 && dispatchQueue.size) {
    const [key, task] = dispatchQueue.entries().next().value!;
    dispatchQueue.delete(key);
    const flight = drainReportActivity(task.model, task.id)
      .catch(() => { console.warn("Report activity dispatch deferred; durable history remains queued."); })
      .finally(() => { dispatches.delete(flight); pumpActivityDispatch(); });
    dispatches.add(flight);
  }
}
export async function waitForActivityDispatch() {
  while (dispatches.size) await Promise.all([...dispatches]);
}
export async function recoverReportActivity() {
  for (const name of ["AssetReport", "LotListing", "ReportDraft", "ReportUploadSession", "AuctioneerWorkItem", "CaptureBackupPlan", "ReportTransferGrant"]) {
    const model = mongoose.models[name];
    if (!model) continue;
    const rows = await model.collection.find({ "activity_outbox.0": { $exists: true } }, { projection: { _id: 1 } }).limit(25).toArray();
    for (const row of rows) await drainReportActivity(model, row._id);
  }
  const deletions = await ReportActivityDeletion.find({ state: "claimed" }).limit(25).lean();
  for (const receipt of deletions as any[]) {
    const model = mongoose.models[receipt.model];
    if (!model) continue;
    const target = await model.collection.findOne({ _id: receipt.target }, { projection: { activity_delete_token: 1 } });
    if (target) continue; // A receipt alone is never permission to delete anything.
    for (const entry of receipt.event || []) await persistActivityEntry(entry);
    await ReportActivityDeletion.updateOne({ _id: receipt._id, state: "claimed" }, { $set: { state: "completed" }, $unset: { event: 1, stream: 1 } });
  }
}
