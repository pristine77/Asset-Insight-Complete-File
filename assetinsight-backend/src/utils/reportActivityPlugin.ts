import mongoose, { type Schema } from "mongoose";
import { randomUUID } from "node:crypto";
import { ReportActivityDeletion } from "../models/reportActivity.model.js";
import { buildServerActivity, scheduleReportActivity, persistActivityEntry } from "../service/reportActivityService.js";
import { currentActivityContext } from "./reportActivityContext.js";

const state = Symbol("reportActivityMutation");
const copy = (value: any): any => value == null ? value : JSON.parse(JSON.stringify(value));
const relevant = /^(preview_data|lots|media|formData|details|files|imageUrls|smartGrouping|status|job_status|release_status|submitted|approval|watermark_images|user|assigned|client_submission_id|clientSubmissionId|capture_id|contract|previewStatus|promoted|delivery|linkedReport)/;
function at(object: any, path: string) { return path.split(".").reduce((value, key) => value?.[key], object); }
function put(object: any, path: string, value: any, remove = false) {
  const parts = path.split("."); let target = object;
  for (const key of parts.slice(0, -1)) target = target[key] ??= {};
  if (remove) delete target[parts[parts.length - 1]]; else target[parts[parts.length - 1]] = value;
}
function predicted(before: any, update: any) {
  const result = copy(before);
  for (const [operator, fields] of Object.entries(update || {})) for (const [path, value] of Object.entries(fields as any || {})) {
    if (operator === "$set") put(result, path, copy(value));
    else if (operator === "$unset") put(result, path, null, true);
    else if (operator === "$inc") put(result, path, Number(at(result, path) || 0) + Number(value));
    else if (operator === "$push" || operator === "$addToSet") {
      const previous = at(result, path) || [], additions = (value as any)?.$each || [value];
      let next = operator === "$push" ? [...previous, ...additions] : [...previous, ...additions.filter((item: any) => !previous.some((old: any) => JSON.stringify(old) === JSON.stringify(item)))];
      if ((value as any)?.$slice !== undefined) { const size = (value as any).$slice; next = size < 0 ? next.slice(size) : next.slice(0, size); }
      put(result, path, next);
    }
    else if (operator === "$pull") put(result, path, (at(result, path) || []).filter((item: any) => {
      if (typeof value !== "object" || value == null) return item !== value;
      return !Object.entries(value).every(([key, expected]: any) => expected?.$in ? expected.$in.includes(item?.[key]) : JSON.stringify(item?.[key]) === JSON.stringify(expected));
    }));
    else if (!operator.startsWith("$")) result[operator] = copy(fields);
  }
  return result;
}
const revisionFilter = (before: any) => before.activity_revision === undefined ? { activity_revision: { $exists: false } } : { activity_revision: before.activity_revision };
const privateFields = ["activity_outbox", "activity_revision", "activity_delete_token", "activity_stream_id", "activity_id"];
async function drain(model: any, id: any) {
  scheduleReportActivity(model, id);
}

/**
 * Audit intent is part of the same parent write as the state change. A separate
 * revision CAS protects the captured preimage; it does not replace workflow fences.
 * Reads, progress-only writes and idempotent/no-op writes produce no edit events.
 */
export function reportActivityPlugin(schema: Schema, options: { model: string }) {
  const name = options.model;
  async function linkedIdentity(doc: any) {
    if (name !== "AuctioneerWorkItem" || !doc?.linkedReportId || doc.activity_stream_id) return doc;
    const report = await mongoose.models[doc.linkedReportModel]?.collection.findOne({ _id: doc.linkedReportId },
      { projection: { activity_id: 1, activity_stream_id: 1 } });
    if (report?.activity_stream_id) Object.assign(doc, { activity_id: report.activity_id, activity_stream_id: report.activity_stream_id });
    return doc;
  }
  schema.add({ activity_id: { type: String, select: false }, activity_stream_id: { type: String, select: false },
    activity_revision: { type: Number, select: false }, activity_delete_token: { type: String, select: false },
    activity_outbox: { type: [mongoose.Schema.Types.Mixed], select: false, default: undefined } });
  schema.index({ "activity_outbox.event._id": 1 }, { sparse: true });
  for (const key of ["toJSON", "toObject"] as const) {
    const prior = schema.get(key) || {};
    schema.set(key, { ...prior, transform(doc: any, ret: any, opts: any) {
      const transformed = typeof prior.transform === "function" ? prior.transform(doc, ret, opts) || ret : ret;
      for (const field of privateFields) delete transformed[field];
      return transformed;
    } });
  }
  schema.pre("save", async function(this: any) {
    const context = currentActivityContext();
    if (context.disabled) return;
    const model = this.constructor;
    const before = this.isNew ? null : await linkedIdentity(await model.collection.findOne({ _id: this._id }));
    const after = await linkedIdentity(this.toObject({ transform: false }));
    if (!context.enabled && !before?.activity_stream_id && !after?.activity_stream_id) return;
    if (name === "AuctioneerWorkItem" && !after.linkedReportId) return;
    if (before?.activity_delete_token) throw Object.assign(new Error("This report is being deleted. Reload before making changes."), { statusCode: 409 });
    if (before && before.watermark_images === undefined && !this.isModified("watermark_images")) delete after.watermark_images;
    // A document selected without private fields must retain the established stream.
    if (before) { after.activity_id = before.activity_id; after.activity_stream_id = before.activity_stream_id; }
    const entries = buildServerActivity(before, after, name);
    if (!entries.length) return;
    this.activity_id = entries[0].stream.activityId;
    this.activity_stream_id = entries[0].stream._id;
    this.activity_revision = (before?.activity_revision || 0) + 1;
    this.activity_outbox = [...(before?.activity_outbox || []), ...entries];
    if (before) this.$where = { $and: [this.$where || {}, revisionFilter(before), { activity_delete_token: { $exists: false } }] };
    this[state] = true;
  });
  schema.post("save", async function(this: any, doc: any) { if (this[state]) await drain(this.constructor, doc._id); });

  for (const operation of ["updateOne", "findOneAndUpdate"] as const) {
    schema.pre(operation, async function(this: any) {
      if (currentActivityContext().disabled) return;
      const originalUpdate = this.getUpdate();
      // Per-object upload acknowledgements use positional paths. Do not attempt to
      // predict Mongo's array-filter matching; completion records verified totals.
      if (originalUpdate && Object.values(originalUpdate).some(fields => fields && typeof fields === "object" && Object.keys(fields).some(path => /\.\$(?:\.|\[)/.test(path)))) return;
      if (!originalUpdate || Array.isArray(originalUpdate) || !Object.entries(originalUpdate).some(([key, fields]) => relevant.test(key) || (key.startsWith("$") && Object.keys(fields as any || {}).some(field => relevant.test(field))))) return;
      const originalFilter = this.getFilter();
      const before = await linkedIdentity(await this.model.findOne(originalFilter).select("+activity_id +activity_stream_id +activity_revision +activity_outbox +activity_delete_token").lean());
      if (name === "AuctioneerWorkItem" && !before?.linkedReportId) return;
      if (!before && this.getOptions().upsert && currentActivityContext().enabled) {
        const seed = { ...Object.fromEntries(Object.entries(originalFilter).filter(([key, value]) => !key.startsWith("$") && (typeof value !== "object" || value instanceof mongoose.Types.ObjectId))), ...(originalUpdate.$setOnInsert || {}) };
        const initial = new this.model(predicted(seed, originalUpdate)).toObject({ transform: false });
        const entries = buildServerActivity(null, initial, name);
        if (!entries.length) return;
        this.setUpdate({ ...originalUpdate, $setOnInsert: { ...(originalUpdate.$setOnInsert || {}), _id: initial._id,
          activity_id: entries[0].stream.activityId, activity_stream_id: entries[0].stream._id, activity_revision: 1, activity_outbox: entries } });
        this[state] = { id: initial._id, insert: true };
        return;
      }
      if (!before || (!currentActivityContext().enabled && !before.activity_stream_id)) return;
      if (before.activity_delete_token) throw Object.assign(new Error("This report is being deleted."), { statusCode: 409 });
      const entries = buildServerActivity(before, predicted(before, originalUpdate), name);
      if (!entries.length) return;
      this[state] = { originalFilter, originalUpdate, originalOptions: { ...this.getOptions() }, id: before._id };
      this.setQuery({ $and: [originalFilter, revisionFilter(before), { activity_delete_token: { $exists: false } }] });
      this.setUpdate({ ...originalUpdate,
        $set: { ...(originalUpdate.$set || {}), activity_id: entries[0].stream.activityId, activity_stream_id: entries[0].stream._id },
        $inc: { ...(originalUpdate.$inc || {}), activity_revision: 1 },
        $push: { ...(originalUpdate.$push || {}), activity_outbox: { $each: entries } },
      });
    });
    schema.post(operation, async function(this: any, result: any) {
      const tracked = this[state];
      if (!tracked) return;
      if (tracked.insert) { await drain(this.model, tracked.id); return; }
      const matched = operation === "updateOne" ? result?.matchedCount : result != null;
      if (matched) { await drain(this.model, tracked.id); return; }
      // Preserve the caller's original workflow/CAS predicate. Only retry an audit
      // revision collision, never relax status, ownership, job or preview revisions.
      if (await this.model.exists(tracked.originalFilter)) {
        const retries = Number(this.__activityRetries || 0);
        if (retries >= 4) throw Object.assign(new Error("The report changed while saving. Refresh and retry."), { statusCode: 409 });
        const retry = this.model[operation](tracked.originalFilter, tracked.originalUpdate, tracked.originalOptions);
        retry.__activityRetries = retries + 1;
        return mongoose.overwriteMiddlewareResult(await retry);
      }
    });
  }

  async function deleteTracked(model: any, filter: any) {
    // Removing an integration claim is not deleting its linked report.
    if (name === "AuctioneerWorkItem") return undefined;
    const before = await model.findOne(filter).select("+activity_id +activity_stream_id +activity_revision +activity_outbox +activity_delete_token").lean();
    if (!before || (!currentActivityContext().enabled && !before.activity_stream_id)) return undefined;
    const token = before.activity_delete_token || randomUUID();
    const entries = buildServerActivity(before, before, name, true);
    if (!entries.length) return undefined;
    // Keep a durable receipt before removing the only source of the report identity.
    if (!before.activity_delete_token) await ReportActivityDeletion.create({ _id: token, model: name, target: before._id, event: [...(before.activity_outbox || []), ...entries] });
    const claimed = before.activity_delete_token ? before : await model.collection.findOneAndUpdate(
      { $and: [model.findOne(filter).cast(model), revisionFilter(before), { activity_delete_token: { $exists: false } }] },
      { $set: { activity_delete_token: token } }, { returnDocument: "after" });
    if (!claimed) {
      await ReportActivityDeletion.updateOne({ _id: token }, { $set: { state: "aborted" }, $unset: { event: 1 } });
      return null;
    }
    const receipt = await ReportActivityDeletion.findOneAndUpdate({ _id: token, state: { $in: ["prepared", "claimed"] } }, { $set: { state: "claimed" } }, { new: true }).lean() as any;
    if (!receipt) throw new Error("The deletion receipt could not be confirmed.");
    const deleted = await model.collection.findOneAndDelete({ _id: before._id, activity_delete_token: token });
    if (!deleted) return null;
    try {
      for (const entry of receipt.event) await persistActivityEntry(entry);
      await ReportActivityDeletion.updateOne({ _id: token }, { $set: { state: "completed" }, $unset: { event: 1 } });
    } catch { console.warn("Deletion history dispatch deferred; durable receipt retained."); }
    return deleted;
  }
  for (const operation of ["deleteOne", "findOneAndDelete"] as const) schema.pre(operation, { query: true, document: false }, async function(this: any) {
    if (currentActivityContext().disabled) return;
    const deleted = await deleteTracked(this.model, this.getFilter());
    if (deleted === undefined) return;
    const value = operation === "deleteOne" ? { acknowledged: true, deletedCount: deleted ? 1 : 0 } : deleted ? this.model.hydrate(deleted) : null;
    throw mongoose.skipMiddlewareFunction(value);
  });
  schema.pre("deleteOne", { document: true, query: false }, async function(this: any) {
    if (currentActivityContext().disabled) return;
    const deleted = await deleteTracked(this.constructor, { _id: this._id });
    if (deleted !== undefined) throw mongoose.skipMiddlewareFunction({ acknowledged: true, deletedCount: deleted ? 1 : 0 });
  });
  for (const operation of ["updateMany", "deleteMany"] as const) schema.pre(operation, async function(this: any) {
    if (currentActivityContext().disabled || !currentActivityContext().enabled) return;
    if (name === "AuctioneerWorkItem" && operation === "deleteMany") return;
    if (operation === "updateMany" && this.getOptions().upsert) return;
    const filter = this.getFilter();
    const cursor = this.model.find(filter).select("_id").lean().cursor();
    let count = 0, changed = 0;
    for await (const item of cursor) {
      const narrowed = { $and: [filter, { _id: item._id }] };
      const result = operation === "deleteMany" ? await this.model.deleteOne(narrowed) : await this.model.updateOne(narrowed, this.getUpdate(), this.getOptions());
      count += result.matchedCount || result.deletedCount || 0;
      changed += result.modifiedCount || 0;
    }
    throw mongoose.skipMiddlewareFunction(operation === "deleteMany" ? { acknowledged: true, deletedCount: count } : { acknowledged: true, matchedCount: count, modifiedCount: changed, upsertedCount: 0, upsertedId: null });
  });
}
