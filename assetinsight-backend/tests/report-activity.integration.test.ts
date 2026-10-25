import { randomUUID } from "node:crypto";
import express from "express";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from "vitest";
import { ReportActivity, ReportActivityEvent, ReportActivityDeletion } from "../src/models/reportActivity.model.js";
import { reportActivityPlugin } from "../src/utils/reportActivityPlugin.js";
import { reportActivityContext, reportActivityRequestContext } from "../src/utils/reportActivityContext.js";
import { recoverReportActivity, normalizeClientActivity, persistActivityEntry, buildServerActivity, waitForActivityDispatch, recordRejectedActivityRequest } from "../src/service/reportActivityService.js";
import * as controller from "../src/controller/reportActivity.controller.js";
import CaptureInventory from "../src/models/captureInventory.model.js";
import ReportDraft from "../src/models/reportDraft.model.js";

let mongo: MongoMemoryServer, Asset: any, Lot: any, app: express.Express;
const owner = new mongoose.Types.ObjectId(), other = new mongoose.Types.ObjectId();
const run = (work: () => any, actor = String(owner)) => reportActivityContext.run({ actor, source: "web" }, async () => { const result = await work(); await waitForActivityDispatch(); return result; });
const rawEvent = (changes: any = {}) => ({ eventId: randomUUID(), activityId: "capture-one", reportType: "asset", contract: "93530", source: "android", sequence: 1, sequenceScope: "installation-one", observedAt: "2026-09-17T10:00:00Z", appVersion: "1", action: "photo_captured", outcome: "completed", data: { beforeCounts: { lots: 1, photos: 0, mainPhotos: 0, extraPhotos: 0 }, afterCounts: { lots: 1, photos: 1, mainPhotos: 1, extraPhotos: 0 }, uploadLogo: false, cameraStamp: "camera_reported" }, ...changes });
async function fixture(model = Asset, extra: any = {}) {
  const row = { _id: new mongoose.Types.ObjectId(), user: owner, contract_no: "93530", status: "preview", preview_data: { lots: [{ id: "lot-a", title: "Original", description: "First description", image_urls: ["https://media.example.test/a"] }] }, ...extra };
  await model.collection.insertOne(row); return row;
}
beforeAll(async () => {
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  for (const name of ["AssetReport", "LotListing"]) {
    const schema = new mongoose.Schema({ user: mongoose.Schema.Types.ObjectId, contract_no: String, status: String, preview_submitted_at: Date, preview_data: mongoose.Schema.Types.Mixed, job_status: String, watermark_images: Boolean }, { strict: false });
    schema.plugin(reportActivityPlugin, { model: name });
    const model = mongoose.model(name, schema); if (name === "AssetReport") Asset = model; else Lot = model;
  }
  await Promise.all(Object.values(mongoose.models).map(model => model.init()));
  app = express(); app.use(express.json({ limit: "256kb" })); app.use(reportActivityRequestContext);
  // Route tests focus on authorization of projections; authentication is independently covered by composition tests.
  app.use((req: any, res, next) => { if (!req.get("test-role")) return res.sendStatus(401); req.userId = String(owner); req.user = { _id: owner, role: req.get("test-role") }; next(); });
  app.post("/events", controller.postReportActivityEvents);
  app.get("/activity", controller.listReportActivity);
  app.get("/activity/:id", controller.getReportActivity);
  app.get("/activity/:id/events", controller.getReportActivityEvents);
  app.get("/activity/:id/lots", controller.getReportActivityLots);
  app.delete("/activity/:id", controller.removeReportActivity);
});
beforeEach(async () => { vi.restoreAllMocks(); await Promise.all(Object.values(mongoose.models).map(model => model.collection.deleteMany({}))); });
afterAll(async () => { await waitForActivityDispatch(); await mongoose.disconnect(); await mongo.stop(); });

describe("durable report activity", () => {
  it("shows the last received mobile version in bounded admin list/detail without guessing for legacy history", async () => {
    await persistActivityEntry(normalizeClientActivity(rawEvent({ appVersion: "1.0.1 (build 3)" }), { id: String(owner), role: "user" }));
    const stream = await ReportActivity.findOne().lean() as any;
    const listing = await request(app).get("/activity?limit=1").set("test-role", "admin");
    expect(listing.body.data.items[0].lastReportedApp).toMatchObject({ appVersion: "1.0.1 (build 3)", source: "android" });
    const detail = await request(app).get(`/activity/${stream._id}`).set("test-role", "admin");
    expect(detail.body.data.lastReportedApp).toEqual(listing.body.data.items[0].lastReportedApp);
    await persistActivityEntry(normalizeClientActivity(rawEvent({ sequence: 2, source: "web", appVersion: "web-build" }), { id: String(owner), role: "user" }));
    expect((await request(app).get(`/activity/${stream._id}`).set("test-role", "admin")).body.data.lastReportedApp.appVersion).toBe("1.0.1 (build 3)");
    // Receiving an old offline event is explicitly labelled by receipt, not current installation.
    await persistActivityEntry(normalizeClientActivity(rawEvent({ sequence: 1, sequenceScope: "older-device", appVersion: "1.0.0" }), { id: String(owner), role: "user" }));
    expect((await request(app).get(`/activity/${stream._id}`).set("test-role", "admin")).body.data.lastReportedApp.appVersion).toBe("1.0.0");
    const legacy = await fixture();
    expect((await request(app).get(`/activity/${"a".repeat(40)}${legacy._id}`).set("test-role", "admin")).body.data.lastReportedApp).toBeNull();
  });
  it("captures installed app version on server transitions and ignores malformed/non-mobile headers", async () => {
    const row = await fixture();
    const build = (headers: Record<string, string>) => reportActivityContext.run({ request: { userId: String(owner), user: { role: "user" }, get: (key: string) => headers[key] } },
      () => buildServerActivity(row, { ...row, preview_submitted_at: new Date() }, "AssetReport"));
    expect(build({ "X-Activity-Source": "android", "X-App-Version": "1.0.1 (build 3)" })[0].event.appVersion).toBe("1.0.1 (build 3)");
    expect(build({ "X-Activity-Source": "web", "X-App-Version": "1.0.1" })[0].event.appVersion).toBeNull();
    expect(build({ "X-Activity-Source": "android", "X-App-Version": "bad\nheader" })[0].event.appVersion).toBeNull();
    expect(build({ "X-Activity-Source": "ios" })[0].event.appVersion).toBeNull();
  });
  it.each(["asset", "lotListing"])("retains %s offline review opens as device observations without report submission", async reportType => {
    const event = rawEvent({ action: "draft_opened", reportType, data: { captureMode: "offline",
      beforeCounts: { lots: 2, photos: 23, mainPhotos: 20, extraPhotos: 3 },
      afterCounts: { lots: 2, photos: 23, mainPhotos: 20, extraPhotos: 3 }, uploadLogo: false } });
    for (let i = 0; i < 2; i++) {
      const saved = await request(app).post("/events").set("test-role", "user").send({ ownerId: String(owner), events: [event] });
      expect(saved.status).toBe(200);
      expect(saved.body.data.acknowledgements[0].eventId).toBe(event.eventId);
    }
    const stream = await ReportActivity.findOne().lean() as any;
    const timeline = await request(app).get(`/activity/${stream._id}/events`).set("test-role", "admin");
    expect(timeline.body.data.items).toHaveLength(1);
    expect(timeline.body.data.items[0]).toMatchObject({ action: "draft_opened", authority: "device", outcome: "completed",
      data: { captureMode: "offline", afterCounts: { lots: 2, photos: 23 } } });
    const filtered = await request(app).get("/activity?action=draft_opened").set("test-role", "admin");
    expect(filtered.body.data.total).toBe(1);
    expect(await Asset.countDocuments()).toBe(0); expect(await Lot.countDocuments()).toBe(0); expect(await ReportDraft.countDocuments()).toBe(0);
    expect((await request(app).post("/events").set("test-role", "user").send({ ownerId: String(other), events: [event] })).status).toBe(403);
  });
  it.each(["asset", "lotListing"])("pages current per-lot counts for legacy %s without exposing fields or reconstructing history", async type => {
    const model = type === "asset" ? Asset : Lot;
    const lots = Array.from({ length: 43 }, (_, position) => ({ id: `lot-${position}`, lot_number: ["1", "2", "3", "5", "X"][position] || String(position + 1),
      description: "PRIVATE DESCRIPTION", image_urls: Array.from({ length: position === 0 ? 10 : 13 }, (_, n) => `https://private.example.test/${position}/${n}`),
      extra_image_urls: position === 1 ? ["private-extra"] : [], cover_image_index: 2 }));
    const row = await fixture(model, { user: other, preview_data: { lots } });
    const id = (type === "asset" ? "a" : "b").repeat(40) + row._id;
    const response = await request(app).get(`/activity/${id}/lots?limit=10`).set("test-role", "admin");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.body.data).toMatchObject({ total: 43, source: "report", page: 1, limit: 10 });
    expect(response.body.data.items).toHaveLength(10);
    expect(response.body.data.items[0]).toMatchObject({ lotNumber: "1", photos: 10, mainPhotos: 10, extraPhotos: 0 });
    expect(response.body.data.items[1]).toMatchObject({ lotNumber: "2", photos: 14, mainPhotos: 13, extraPhotos: 1 });
    expect(response.body.data.items[3].lotNumber).toBe("5"); expect(response.body.data.items[4].lotNumber).toBe("X");
    expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE|private|image_urls|cover_image/);
    const last = await request(app).get(`/activity/${id}/lots?page=5&limit=10`).set("test-role", "superadmin");
    expect(last.body.data.items).toHaveLength(3); expect(last.body.data.items[0].position).toBe(40);
    expect((await request(app).get(`/activity/${id}/lots?limit=101`).set("test-role", "admin")).status).toBe(400);
    expect((await request(app).get(`/activity/${id}/lots`).set("test-role", "user")).status).toBe(403);
    expect((await request(app).get(`/activity/${id}/lots`)).status).toBe(401);
    expect(await ReportActivity.countDocuments()).toBe(0); expect(await ReportActivityEvent.countDocuments()).toBe(0);
  });
  it("counts 5000 media references, not cover/thumbnail copies, and refreshes changed lot order", async () => {
    const lots = Array.from({ length: 100 }, (_, i) => ({ id: `lot-${i}`, lot_number: i + 1,
      image_indexes: Array.from({ length: 49 }, (_, p) => i * 50 + p), extra_image_indexes: [i * 50 + 49],
      cover_image_index: 0, thumbnail: "thumbnail-is-not-an-original" }));
    const row = await fixture(Asset, { preview_data: { lots } });
    const id = "a".repeat(40) + row._id;
    const counts = (await request(app).get(`/activity/${id}/lots?limit=100`).set("test-role", "admin")).body.data;
    expect(counts.items.reduce((n: number, lot: any) => n + lot.photos, 0)).toBe(5000);
    expect(Buffer.byteLength(JSON.stringify(counts))).toBeLessThan(32000);
    await Asset.collection.updateOne({ _id: row._id }, { $set: { "preview_data.lots": [{ ...lots[1], image_indexes: [], extra_image_indexes: [] }, lots[0]] } });
    const updated = (await request(app).get(`/activity/${id}/lots`).set("test-role", "admin")).body.data;
    expect(updated.total).toBe(2); expect(updated.items[0]).toMatchObject({ lotNumber: "2", photos: 0, position: 0 });
    expect(updated.items[1]).toMatchObject({ lotNumber: "1", photos: 50, position: 1 });
  });
  it("does not guess complete per-lot counts after deletion or restore removed activity", async () => {
    const row = await fixture(); await run(() => Asset.updateOne({ _id: row._id }, { $set: { status: "approved" } }));
    const stream = await ReportActivity.findOne().lean() as any;
    await run(() => Asset.deleteOne({ _id: row._id }));
    expect((await request(app).get(`/activity/${stream._id}/lots`).set("test-role", "admin")).body.data)
      .toMatchObject({ source: "unavailable", total: 0, items: [] });
    await ReportActivity.updateOne({ _id: stream._id }, { $set: { removedAt: new Date() } });
    expect((await request(app).get(`/activity/${stream._id}/lots`).set("test-role", "superadmin")).status).toBe(404);
  });
  it("uses owner-scoped synchronized capture counts, keeping missing photos in the total", async () => {
    await request(app).post("/events").set("test-role", "user").send({ events: [rawEvent()] });
    const stream = await ReportActivity.findOne().lean() as any;
    const capture = { _id: "c".repeat(64), user: other, captureId: "capture-one", reportType: "asset", removedAt: null,
      lastReceivedAt: new Date("2026-09-17T10:00:00Z"), lots: [{ id: "capture-lot", lotNumber: "X", mainPhotoCount: 10, extraPhotoCount: 3, missingPhotoCount: 2 }] };
    await CaptureInventory.collection.insertOne(capture);
    const get = () => request(app).get(`/activity/${stream._id}/lots`).set("test-role", "admin");
    expect((await get()).body.data.source).toBe("unavailable");
    await CaptureInventory.collection.updateOne({ _id: capture._id }, { $set: { user: owner } });
    const result = (await get()).body.data;
    expect(result).toMatchObject({ source: "capture", asOf: capture.lastReceivedAt.toISOString(), total: 1 });
    expect(result.items[0]).toMatchObject({ lotNumber: "X", photos: 13, mainPhotos: 10, extraPhotos: 3, missingPhotos: 2 });
    await CaptureInventory.collection.updateOne({ _id: capture._id }, { $set: { removedAt: new Date() } });
    expect((await get()).body.data.source).toBe("unavailable");
  });
  it("reads an exact owner's draft manifest without counting videos or another report on the same contract", async () => {
    await request(app).post("/events").set("test-role", "user").send({ events: [rawEvent()] });
    const stream = await ReportActivity.findOne().lean() as any;
    const draft = { user: owner, type: "asset", clientDraftId: "capture-one", contractNo: "93530", updatedAt: new Date(),
      lots: [{ id: "lot-d", lotNumber: "5" }], media: [{ lotId: "lot-d", slot: "main", clientFileId: "a" }, { lotId: "lot-d", slot: "extra", clientFileId: "b" }, { lotId: "lot-d", slot: "video", clientFileId: "c" }] };
    await ReportDraft.collection.insertOne(draft);
    await ReportDraft.collection.insertOne({ ...draft, _id: new mongoose.Types.ObjectId(), clientDraftId: "another-draft", lots: [] });
    const result = (await request(app).get(`/activity/${stream._id}/lots`).set("test-role", "admin")).body.data;
    expect(result).toMatchObject({ source: "draft", total: 1 });
    expect(result.items[0]).toMatchObject({ lotNumber: "5", photos: 2, mainPhotos: 1, extraPhotos: 1 });
  });
  it.each(["AssetReport", "LotListing"])("captures canonical report-only images and condition specifications for %s", model => {
    const before = { _id: new mongoose.Types.ObjectId(), user: owner, preview_submitted_at: new Date(), preview_data: { lots: [{ lot_id: "canonical-lot", image_urls: ["main"], extra_image_urls: ["report-only"], condition_report_specs: { Engine: "Old" }, quantity: 1 }] } };
    const after = { ...before, preview_data: { lots: [{ ...before.preview_data.lots[0], condition_report_specs: { Engine: "New" }, quantity: 2 }] } };
    const events = buildServerActivity(before, after, model);
    expect(events[0].event.data.afterCounts).toEqual({ lots: 1, photos: 2, mainPhotos: 1, extraPhotos: 1 });
    expect(events.flatMap(event => event.event.data.fields)).toEqual(expect.arrayContaining([
      { field: "lots.canonical-lot.condition_report_specs.Engine", before: "Old", after: "New" },
      { field: "lots.canonical-lot.quantity", before: 1, after: 2 },
    ]));
  });
  it("a failed deletion records failure, never removal or successful completion", async () => {
    const row = await fixture();
    await run(() => recordRejectedActivityRequest({ originalUrl: `/api/asset/${row._id}`, method: "DELETE" }, 409));
    const event = await ReportActivityEvent.findOne().lean() as any;
    expect(event).toMatchObject({ action: "report_deleted", outcome: "failed" });
    expect((await ReportActivity.findOne().lean() as any).deleted).toBe(false);
    expect(await Asset.findById(row._id)).not.toBeNull();
  });
  it("fences an account change between reading a local outbox and sending it", async () => {
    const response = await request(app).post("/events").set("test-role", "user").send({ ownerId: String(other), events: [rawEvent()] });
    expect(response.status).toBe(403); expect(await ReportActivity.countDocuments()).toBe(0);
  });
  it("keeps 5000 photo positions bounded and report-only positions independent", () => {
    const row = { _id: new mongoose.Types.ObjectId(), user: owner, status: "preview", preview_data: { lots: Array.from({ length: 25 }, (_, i) => ({ id: `lot-${i}`, image_urls: Array.from({ length: 199 }, (_, p) => `main-${i}-${p}`), extraImages: [`extra-${i}`] })) } };
    const entries = buildServerActivity(null, row, "AssetReport");
    for (const entry of entries) {
      expect(entry.event.data.afterCounts).toEqual({ lots: 25, photos: 5000, mainPhotos: 4975, extraPhotos: 25 });
      expect(Buffer.byteLength(JSON.stringify(entry.event))).toBeLessThan(256 * 1024);
      for (const lot of entry.event.data.lots) {
        expect(lot.photos.length).toBeLessThanOrEqual(100);
        for (const photo of lot.photos.filter((p: any) => p.slot === "extra")) expect(photo.after).toBe(0);
      }
    }
  });
  it("reports per-spec changes and bounds large before/after event payloads", () => {
    const before = { _id: new mongoose.Types.ObjectId(), user: owner, preview_submitted_at: new Date(), preview_data: { lots: [{ id: "v", specs: { Engine: "Old" } }] } };
    const after = { ...before, preview_data: { lots: [{ id: "v", specs: { Engine: "New", Notes: "界".repeat(50000) } }] } };
    const events = buildServerActivity(before, after, "AssetReport");
    expect(events.flatMap(e => e.event.data.fields)).toContainEqual({ field: "lots.v.specs.Engine", before: "Old", after: "New" });
    for (const event of events) expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(256 * 1024);
  });
  it("does not report release or completion from schema release defaults without artifacts", () => {
    const row = { _id: new mongoose.Types.ObjectId(), user: owner, status: "preview", release_status: "released", job_status: "done" };
    expect(buildServerActivity(null, row, "LotListing").map(e => e.event.action)).not.toContain("released");
    expect(buildServerActivity(null, row, "LotListing").map(e => e.event.action)).not.toContain("generation_completed");
    const completed = { ...row, status: "approved", files: { excel: "sheet.xlsx", images: "photos.zip" } };
    expect(buildServerActivity(row, completed, "LotListing").map(e => e.event.action)).toEqual(expect.arrayContaining(["approved", "released", "generation_completed"]));
  });
  it("accepts bounded empty lot-number observations but rejects incomplete counts", () => {
    const lot = { id: "new-lot", lotNumber: "", before: null, after: { mainPhotos: 0, extraPhotos: 0 } };
    expect(() => normalizeClientActivity(rawEvent({ data: { lots: [lot] } }), { id: String(owner), role: "user" })).not.toThrow();
    expect(() => normalizeClientActivity(rawEvent({ data: { lots: [{ ...lot, after: {} }] } }), { id: String(owner), role: "user" })).toThrow();
  });
  it("allows only existing report access, and deleted field values are superadmin-only", async () => {
    const row = await fixture(Asset, { user: other, status: "approved", preview_submitted_at: new Date() });
    await run(() => Asset.updateOne({ _id: row._id }, { $set: { "preview_data.lots.0.description": "Permitted approved value" } }));
    const stream = await ReportActivity.findOne().lean() as any;
    expect((await request(app).get(`/activity/${stream._id}`).set("test-role", "admin")).body.data.canViewValues).toBe(true);
    await run(() => Asset.deleteOne({ _id: row._id }));
    const deleted = await request(app).get(`/activity/${stream._id}/events`).set("test-role", "admin");
    expect(JSON.stringify(deleted.body)).not.toContain("Permitted approved value");
    expect(deleted.body.data.canOpenPreview).toBe(false);
  });
  it("shows current-state baselines without writing or reconstructing old events", async () => {
    await fixture();
    const response = await request(app).get("/activity").set("test-role", "admin");
    expect(response.status).toBe(200);
    expect(response.body.data.items[0]).toMatchObject({ baseline: true, lastReceivedAt: null, latestAction: "history_started" });
    const detail = await request(app).get(`/activity/${response.body.data.items[0].id}/events`).set("test-role", "superadmin");
    expect(detail.body.data.items[0].data.baseline).toBe(true);
    expect(await ReportActivity.countDocuments()).toBe(0);
    expect(await ReportActivityEvent.countDocuments()).toBe(0);
  });
  it("preserves delete return values and does not execute the database deletion twice", async () => {
    const row = await fixture();
    const remove = vi.spyOn(Asset.collection, "findOneAndDelete");
    const deleted = await run(() => Asset.findOneAndDelete({ _id: row._id }));
    expect(String(deleted._id)).toBe(String(row._id)); expect(remove).toHaveBeenCalledTimes(1);
    const row2 = await fixture(); const result = await run(() => Asset.deleteOne({ _id: row2._id }));
    expect(result.deletedCount).toBe(1);
  });
  it("captures an inserted upsert durably and reuses its stable activity stream", async () => {
    const filter = { _id: new mongoose.Types.ObjectId(), user: owner };
    await run(() => Asset.updateOne(filter, { $setOnInsert: { contract_no: "Repeated", status: "preview" } }, { upsert: true }));
    const doc = await Asset.collection.findOne({ _id: filter._id });
    expect(doc.activity_stream_id).toMatch(/^[a-f\d]{64}$/);
    expect(await ReportActivityEvent.countDocuments({ action: "history_started" })).toBe(1);
    await run(() => Asset.updateOne(filter, { $setOnInsert: { contract_no: "Repeated", status: "preview" } }, { upsert: true }));
    expect(await ReportActivityEvent.countDocuments({ action: "history_started" })).toBe(1);
  });
  it("does not let out-of-order device batches replace newer counts", async () => {
    const latest = rawEvent({ sequence: 8 });
    await persistActivityEntry(normalizeClientActivity(latest, { id: String(owner), role: "user" }));
    const older = rawEvent({ sequence: 2, data: { afterCounts: { lots: 0, photos: 0, mainPhotos: 0, extraPhotos: 0 } } });
    await persistActivityEntry(normalizeClientActivity(older, { id: String(owner), role: "user" }));
    expect((await ReportActivity.findOne().lean() as any).latestCounts.photos).toBe(1);
    expect(await ReportActivityEvent.countDocuments()).toBe(2);
  });
  it.each(["asset", "lotListing"])("records exact saved changes and retains them after %s deletion", async type => {
    const model = type === "asset" ? Asset : Lot;
    const row = await fixture(model, { preview_submitted_at: new Date() });
    await run(() => model.updateOne({ _id: row._id }, { $set: { "preview_data.lots.0.description": "Edited description" } }));
    const edited = await ReportActivityEvent.findOne({ action: "preview_saved" }).lean() as any;
    expect(edited.data.fields).toContainEqual({ field: "lots.lot-a.description", before: "First description", after: "Edited description" });
    const stream = await ReportActivity.findOne().lean() as any;
    await run(() => model.findOneAndDelete({ _id: row._id }));
    expect(await model.findById(row._id)).toBeNull();
    expect(await ReportActivityEvent.countDocuments({ action: "report_deleted" })).toBe(1);
    expect((await ReportActivity.findById(stream._id).lean() as any).deleted).toBe(true);
    expect(await ReportActivityDeletion.countDocuments({ state: "completed" })).toBe(1);
  });
  it("keeps unsent text private while recording changed field names", async () => {
    const row = await fixture();
    await run(() => Asset.updateOne({ _id: row._id }, { $set: { "preview_data.lots.0.description": "Private unsent note" } }));
    const events = await ReportActivityEvent.find().lean();
    expect(JSON.stringify(events)).not.toContain("Private unsent note");
    expect(JSON.stringify(events)).not.toContain("First description");
    expect(JSON.stringify(events)).toContain("lots.lot-a.description");
  });
  it("does not invent changes for rejected workflow CAS writes", async () => {
    const row = await fixture();
    const result = await run(() => Asset.updateOne({ _id: row._id, status: "approved" }, { $set: { status: "processing" } }));
    expect(result.matchedCount).toBe(0); expect(await ReportActivityEvent.countDocuments()).toBe(0);
  });
  it("serializes concurrent independent changes without losing either preimage", async () => {
    const row = await fixture(Asset, { preview_submitted_at: new Date() });
    await Promise.all([
      run(() => Asset.updateOne({ _id: row._id }, { $set: { "preview_data.lots.0.title": "Changed title" } })),
      run(() => Asset.updateOne({ _id: row._id }, { $set: { "preview_data.lots.0.description": "Changed text" } })),
    ]);
    const report = await Asset.findById(row._id).lean();
    expect(report.preview_data.lots[0]).toMatchObject({ title: "Changed title", description: "Changed text" });
    const events = await ReportActivityEvent.find({ action: "preview_saved" }).lean();
    expect(events.flatMap((event: any) => event.data.fields)).toHaveLength(2);
  });
  it("retains the outbox after an event storage outage and drains it on recovery", async () => {
    const row = await fixture();
    const failure = vi.spyOn(ReportActivityEvent, "create").mockRejectedValue(new Error("isolated outage"));
    await run(() => Asset.updateOne({ _id: row._id }, { $set: { status: "approved" } }));
    expect((await Asset.collection.findOne({ _id: row._id })).activity_outbox.length).toBeGreaterThan(0);
    failure.mockRestore(); await recoverReportActivity();
    expect(await ReportActivityEvent.countDocuments({ action: "approved" })).toBe(1);
    expect((await Asset.collection.findOne({ _id: row._id })).activity_outbox).toEqual([]);
  });
  it("protects private outbox fields from normal serialized report responses", async () => {
    const row = await fixture();
    await run(() => Asset.updateOne({ _id: row._id }, { $set: { status: "approved" } }));
    const doc = await Asset.findById(row._id).select("+activity_outbox +activity_stream_id +activity_revision");
    expect(JSON.stringify(doc)).not.toContain("activity_outbox");
    expect(JSON.stringify(doc)).not.toContain("activity_stream_id");
  });
  it("deduplicates device events and rejects conflicting reuse", async () => {
    const event = rawEvent();
    expect((await request(app).post("/events").set("test-role", "user").send({ events: [event] })).status).toBe(200);
    expect((await request(app).post("/events").set("test-role", "user").send({ events: [event] })).status).toBe(200);
    expect(await ReportActivityEvent.countDocuments()).toBe(1);
    expect((await request(app).post("/events").set("test-role", "user").send({ events: [{ ...event, action: "lot_added" }] })).status).toBe(409);
  });
  it("rejects private values, forged verification, paths and oversized batches", async () => {
    for (const data of [{ fields: [{ field: "description", before: "secret" }] }, { cameraStamp: "verified" }, { photos: ["content://private"] }]) {
      expect((await request(app).post("/events").set("test-role", "user").send({ events: [rawEvent({ data })] })).status).toBe(400);
    }
    expect((await request(app).post("/events").set("test-role", "user").send({ events: Array.from({ length: 101 }, () => rawEvent()) })).status).toBe(400);
  });
  it("keeps same-contract reports separate and isolates owners", async () => {
    const first = normalizeClientActivity(rawEvent(), { id: String(owner), role: "user" });
    const second = normalizeClientActivity(rawEvent({ activityId: "capture-two" }), { id: String(owner), role: "user" });
    const third = normalizeClientActivity(rawEvent(), { id: String(other), role: "user" });
    for (const entry of [first, second, third]) await persistActivityEntry(entry);
    expect(await ReportActivity.countDocuments()).toBe(3);
  });
  it("redacts values for admins without report access and allows superadmin history removal", async () => {
    const row = await fixture(Asset, { user: other, preview_submitted_at: new Date() });
    await run(() => Asset.updateOne({ _id: row._id }, { $set: { "preview_data.lots.0.description": "Confidential saved edit" } }));
    const stream = await ReportActivity.findOne().lean() as any;
    const admin = await request(app).get(`/activity/${stream._id}/events`).set("test-role", "admin");
    expect(JSON.stringify(admin.body)).not.toContain("Confidential saved edit");
    const superadmin = await request(app).get(`/activity/${stream._id}/events`).set("test-role", "superadmin");
    expect(JSON.stringify(superadmin.body)).toContain("Confidential saved edit");
    expect((await request(app).delete(`/activity/${stream._id}`).set("test-role", "admin").send({ revision: stream.revision })).status).toBe(403);
    expect((await request(app).delete(`/activity/${stream._id}`).set("test-role", "superadmin").send({ revision: stream.revision })).status).toBe(200);
    const entries = buildServerActivity(row, { ...row, status: "approved", activity_id: stream.activityId, activity_stream_id: stream._id }, "AssetReport");
    for (const entry of entries) await persistActivityEntry(entry);
    expect(await ReportActivityEvent.countDocuments()).toBe(0);
    expect(await Asset.findById(row._id)).not.toBeNull();
  });
  it("does not infer logo off from absent historical evidence", () => {
    const row = { _id: new mongoose.Types.ObjectId(), user: owner, status: "preview" };
    const [entry] = buildServerActivity(null, row, "AssetReport");
    expect(entry.event.data.uploadLogo).toBeNull();
  });
});
