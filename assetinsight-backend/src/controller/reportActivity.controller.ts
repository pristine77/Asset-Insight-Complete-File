import type { Request, Response } from "express";
import mongoose from "mongoose";
import { ReportActivity, ReportActivityEvent, ReportActivityDeletion } from "../models/reportActivity.model.js";
import { ActivityError, normalizeClientActivity, persistActivityEntry } from "../service/reportActivityService.js";
import { ACTIVITY_ACTIONS, activitySnapshot } from "../utils/reportActivitySnapshot.js";
import { canInspectAdminReport } from "../utils/adminReportAccessPolicy.js";
import { readActivityLotCounts } from "../service/reportActivityLotCounts.js";

function handle(res: Response, work: () => Promise<unknown>) {
  res.setHeader("Cache-Control", "no-store, private");
  return work().then(data => res.json({ data })).catch(error => {
    if (error instanceof ActivityError) return res.status(error.statusCode).json({ message: error.message, code: error.code });
    return res.status(503).json({ message: "Activity history is temporarily unavailable. Refresh to try again.", code: "ACTIVITY_UNAVAILABLE" });
  });
}
function id(value: any) { if (!/^[a-f\d]{64}$/.test(String(value))) throw new ActivityError("Invalid activity ID."); return String(value); }
function pageQuery(query: any) {
  const page = Number(query.page || 1), limit = Number(query.limit || 25);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ActivityError("Invalid page.");
  return { page, limit };
}
function listFilters(query: any) {
  const match: any = { removedAt: null };
  const events: any = {};
  if (query.userId) {
    if (!/^[a-f\d]{24}$/i.test(query.userId)) throw new ActivityError("Select a valid user.");
    match.owner = new mongoose.Types.ObjectId(query.userId);
  }
  if (query.reportType) {
    if (!["asset", "lotListing"].includes(query.reportType)) throw new ActivityError("Invalid report type.");
    match.reportType = query.reportType;
  }
  if (query.search) {
    if (typeof query.search !== "string" || query.search.length > 100) throw new ActivityError("Search is too long.");
    match.contracts = { $regex: query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
  }
  for (const [key, allowed] of Object.entries({ source: ["web", "android", "ios", "admin", "unknown"], action: ACTIVITY_ACTIONS, outcome: ["requested", "accepted", "completed", "failed"] })) if (query[key]) {
    if (!(allowed as readonly string[]).includes(query[key])) throw new ActivityError(`Invalid ${key}.`);
    events[key] = query[key];
  }
  if (query.from || query.to) {
    events.receivedAt = {};
    for (const key of ["from", "to"]) if (query[key]) {
      const date = query[key];
      if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new ActivityError("Invalid date filter.");
      events.receivedAt[key === "from" ? "$gte" : "$lt"] = new Date(Date.parse(date) + (key === "to" ? 86400000 : 0));
    }
    if (query.from && query.to && query.from > query.to) throw new ActivityError("The start date must be before the end date.");
  }
  return { match, events };
}
async function withUsers(rows: any[]) {
  const ids = [...new Set(rows.flatMap(row => [String(row.owner || ""), String(row.actor || "")]).filter(value => /^[a-f\d]{24}$/i.test(value)))];
  const users = mongoose.models.User ? await mongoose.models.User.find({ _id: { $in: ids } }).select("username email").lean() : [];
  const map = new Map(users.map((user: any) => [String(user._id), { id: String(user._id), name: user.username || "", email: user.email || "" }]));
  return rows.map(row => ({ ...row, id: String(row._id), owner: map.get(String(row.owner)) || { id: String(row.owner), name: "Former user", email: "" }, actor: row.actor ? map.get(String(row.actor)) || { id: String(row.actor), name: "Former user", email: "" } : null }));
}
const recordedAppFilter = { source: { $in: ["android", "ios"] }, appVersion: { $type: "string", $nin: ["", "unknown"] } };
// Use the existing activity/receivedAt index, after pagination. Receipt order is
// explicit: a late offline sync is evidence about that activity, not a claim
// about which version is installed on every device now.
const appVersionStages: any[] = [
  { $lookup: { from: ReportActivityEvent.collection.name, localField: "_id", foreignField: "activity", let: { owner: "$owner" },
    pipeline: [{ $match: { ...recordedAppFilter, $expr: { $eq: ["$owner", "$$owner"] } } }, { $sort: { receivedAt: -1, _id: -1 } }, { $limit: 1 },
      { $project: { _id: 0, appVersion: 1, source: 1, receivedAt: 1 } }], as: "reportedApp" } },
  { $set: { lastReportedApp: { $ifNull: [{ $arrayElemAt: ["$reportedApp", 0] }, null] } } },
  { $unset: "reportedApp" },
];
async function getStream(req: any) {
  let stream = await ReportActivity.findOne({ _id: id(req.params.id), removedAt: null }).lean() as any;
  if (!stream && /^(?:a{40}|b{40})[a-f\d]{24}$/.test(req.params.id)) {
    const kind = req.params.id.startsWith("a") ? "asset" : "lotListing";
    const model = mongoose.models[kind === "asset" ? "AssetReport" : "LotListing"];
    const row = model ? await model.findById(req.params.id.slice(40)).select("+activity_stream_id").lean() : null;
    if (row?.activity_stream_id) {
      stream = await ReportActivity.findOne({ _id: row.activity_stream_id, removedAt: null }).lean();
    } else if (row) {
      const snapshot = activitySnapshot(row, model.modelName);
      stream = { _id: req.params.id, activityId: `baseline:${kind}:${row._id}`, owner: row.user, reportType: kind,
        contract: snapshot.contract, reportId: String(row._id), source: "unknown", latestCounts: snapshot.counts,
        latestAction: "history_started", latestOutcome: "completed", lastReceivedAt: null, revision: 0, deleted: false, baseline: true };
    }
  }
  if (!stream) throw new ActivityError("Activity history was not found.", 404, "ACTIVITY_NOT_FOUND");
  return stream;
}
async function access(req: any, stream: any) {
  const role = req.user?.role;
  const model = mongoose.models[stream.reportType === "asset" ? "AssetReport" : "LotListing"];
  const report = !stream.deleted && stream.reportId && model ? await model.findById(stream.reportId).select("user approval_assigned_to release_assigned_to status").lean() : null;
  const actor = String(req.userId || req.user?._id || "");
  const values = role === "superadmin" || !!(report && canInspectAdminReport(report, actor));
  return { canViewValues: values, canOpenPreview: !!report && values, canRemove: role === "superadmin" && !stream.baseline, reportExists: !!report,
    previewPath: !!report && values ? (role === "superadmin" ? "/preview-reports" : `/reports/${stream.reportId}/data`) : null };
}

export const postReportActivityEvents = (req: any, res: Response) => handle(res, async () => {
  if (Buffer.byteLength(JSON.stringify(req.body || {})) > 256 * 1024) throw new ActivityError("Activity batch exceeds 256 KiB.", 413);
  if (!req.body || Object.keys(req.body).some(key => !["events", "ownerId"].includes(key)) || !Array.isArray(req.body.events) || req.body.events.length < 1 || req.body.events.length > 100) throw new ActivityError("Send between 1 and 100 activity events.");
  if (req.body.ownerId !== undefined && req.body.ownerId !== String(req.userId)) throw new ActivityError("Activity belongs to a different signed-in account.", 403, "ACTIVITY_OWNER_MISMATCH");
  const actor = { id: String(req.userId), role: req.user?.role || "user", device: req.deviceId };
  const entries = req.body.events.map((raw: any) => normalizeClientActivity(raw, actor));
  const acknowledgements = [];
  for (const entry of entries) {
    const result = await persistActivityEntry(entry);
    acknowledgements.push({ eventId: entry.event.eventId, activityId: entry.stream.activityId, removed: result.removed === true });
  }
  return { acknowledgements };
});
export const listReportActivity = (req: Request, res: Response) => handle(res, async () => {
  const { page, limit } = pageQuery(req.query), { match, events } = listFilters(req.query);
  const pipeline: any[] = [{ $match: match }];
  if (Object.keys(events).length) pipeline.push({ $lookup: { from: ReportActivityEvent.collection.name, localField: "_id", foreignField: "activity", pipeline: [{ $match: events }, { $limit: 1 }, { $project: { _id: 1 } }], as: "matching" } }, { $match: { "matching.0": { $exists: true } } });
  // Read-only current-state baselines; never fabricate old actions or mutate reports.
  if (!Object.keys(events).length) for (const [kind, name, prefix] of [["asset", "AssetReport", "a"], ["lotListing", "LotListing", "b"]]) {
    if (match.reportType && match.reportType !== kind) continue;
    const model = mongoose.models[name!]; if (!model) continue;
    const currentMatch: any = { activity_stream_id: { $exists: false }, ...(match.owner ? { user: match.owner } : {}),
      ...(match.contracts ? { contract_no: match.contracts } : {}) };
    pipeline.push({ $unionWith: { coll: model.collection.name, pipeline: [{ $match: currentMatch }, { $project: {
      _id: { $concat: [prefix!.repeat(40), { $toString: "$_id" }] }, activityId: { $concat: ["baseline:", kind, ":", { $toString: "$_id" }] },
      owner: "$user", reportType: { $literal: kind }, contract: { $ifNull: ["$contract_no", ""] }, reportId: { $toString: "$_id" },
      source: { $literal: "unknown" }, latestAction: { $literal: "history_started" }, latestOutcome: { $literal: "completed" },
      latestCounts: { $literal: null }, lastReceivedAt: { $literal: null }, revision: { $literal: 0 }, deleted: { $literal: false }, baseline: { $literal: true },
    } }] } });
  }
  pipeline.push({ $sort: { lastReceivedAt: -1, _id: -1 } }, { $facet: { items: [{ $skip: (page - 1) * limit }, { $limit: limit }, ...appVersionStages, { $project: { matching: 0, removedBy: 0, deviceSequences: 0 } }], total: [{ $count: "count" }] } });
  const [result] = await ReportActivity.aggregate(pipeline);
  return { items: await withUsers(result.items), total: result.total[0]?.count || 0, page, limit };
});
export const getReportActivity = (req: Request, res: Response) => handle(res, async () => {
  const stream = await getStream(req);
  stream.lastReportedApp = await ReportActivityEvent.findOne({ activity: stream._id, owner: stream.owner, ...recordedAppFilter })
    .sort({ receivedAt: -1, _id: -1 }).select("-_id appVersion source receivedAt").lean();
  return { ...(await withUsers([stream]))[0], ...await access(req, stream) };
});
export const getReportActivityLots = (req: any, res: Response) => handle(res, async () => {
  if (!["admin", "superadmin"].includes(req.user?.role)) throw new ActivityError("Administrator access required.", 403);
  const { page, limit } = pageQuery(req.query);
  return readActivityLotCounts(await getStream(req), page, limit);
});
export const getReportActivityEvents = (req: Request, res: Response) => handle(res, async () => {
  const stream = await getStream(req), permissions = await access(req, stream);
  const { page, limit } = pageQuery(req.query);
  if (stream.baseline) return { items: page === 1 ? [{ id: stream._id, action: "history_started", outcome: "completed", authority: "server", source: "unknown", actor: null, actorRole: "system",
    receivedAt: null, observedAt: null, sequence: null, data: { beforeCounts: null, afterCounts: stream.latestCounts, baseline: true, fields: [], lots: [], uploadLogo: null, cameraStamp: "not_recorded" } }] : [], total: 1, page, limit, ...permissions };
  const filter = { activity: stream._id };
  const [events, total] = await Promise.all([ReportActivityEvent.find(filter).sort({ receivedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(), ReportActivityEvent.countDocuments(filter)]);
  const rows = events.map((event: any) => {
    const data = { ...event.data };
    if (!permissions.canViewValues) data.fields = (data.fields || []).map((field: any) => typeof field === "string" ? field : { field: field.field });
    return { ...event, data };
  });
  return { items: await withUsers(rows), total, page, limit, ...permissions };
});
export const removeReportActivity = (req: any, res: Response) => handle(res, async () => {
  if (req.user?.role !== "superadmin") throw new ActivityError("Only a superadmin can remove activity history.", 403);
  const streamId = id(req.params.id);
  if (!req.body || Object.keys(req.body).length !== 1 || !Number.isSafeInteger(req.body.revision) || req.body.revision < 0) throw new ActivityError("Reload the history before removing it.");
  const existing = await ReportActivity.findById(streamId).lean() as any;
  if (!existing) throw new ActivityError("Activity history was not found.", 404);
  if (existing.removedAt) {
    await ReportActivityEvent.deleteMany({ activity: streamId });
    await ReportActivityDeletion.updateMany({ "event.stream._id": streamId }, { $unset: { event: 1, stream: 1 } });
    return { id: streamId, removed: true };
  }
  const changed = await ReportActivity.updateOne({ _id: streamId, removedAt: null, revision: req.body.revision }, {
    $set: { removedAt: new Date(), removedBy: req.userId, contract: "", contracts: [], latestCounts: null },
    $unset: { reportId: 1, draftId: 1, captureId: 1, submissionId: 1, uploadSessionId: 1, latestAction: 1, latestOutcome: 1, deviceSequences: 1 }, $inc: { revision: 1 },
  });
  if (changed.modifiedCount !== 1) throw new ActivityError("New activity arrived. Reload and review before removing history.", 409, "ACTIVITY_REVISION_CONFLICT");
  await ReportActivityEvent.deleteMany({ activity: streamId });
  await ReportActivityDeletion.updateMany({ "event.stream._id": streamId }, { $unset: { event: 1, stream: 1 } });
  return { id: streamId, removed: true };
});
