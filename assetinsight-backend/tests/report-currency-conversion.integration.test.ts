import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
const provider = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../src/utils/openaiClient.js", () => ({ default: { responses: { create: provider.create } } }));
let withRevision: (r: any, p?: any) => any;
let mongo: MongoMemoryServer, app: any, Asset: any, Lot: any, User: any, ReportJob: any, resetQuota: () => void;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function auth(id: unknown) { return { Authorization: `Bearer ${jwt.sign({ id: String(id), role: "user" }, process.env.JWT_SECRET!, { expiresIn: "30m" })}` }; }
function rateResponse(input: any) {
  const [, from, to] = String(input.input).match(/1 ([A-Z]{3}) in ([A-Z]{3})/) || [];
  const url = "https://www.bankofcanada.ca/rates/exchange/daily-exchange-rates/";
  return { status: "completed", output_text: JSON.stringify({ fromCurrency: from, toCurrency: to, rate: .5, asOf: new Date().toISOString().slice(0, 10), sourceUrl: url, sourceTitle: "Bank of Canada daily rates" }), output: [{ type: "web_search_call", action: { sources: [{ url }] } }] };
}
function preview() { return { currency: "CAD", contract_no: "CURRENCY-QA", owner_name: "Original", client_name: "Currency QA", total_value: 1000, total_appraised_value: 1000, lots: [{ id: "lot-1", lot_id: "lot-1", lot_number: "1", mode: "bundle", title: "QA Equipment", description: "Saved text only", estimated_value: "CAD 1000", opening_bid: 10, image_urls: ["https://example.test/one.jpg"], condition_report_specs: { Hours: "1234" } }], admin_schedule_sheet: { evaluator_columns: [{ id: "owner", name: "Owner" }], rows: [{ lot_id: "lot-1", asset_id: "1", evaluator_values: { owner: 2000 }, asset_insight: "CAD 1000", lien_search: 10 }], file_summary: { buyers_premium_basis: "uncapped", offer2_nmg_percent: .785, capped_threshold_percent: .1 } } }; }
async function account(name = "owner") { return User.create({ email: `${name}@example.test`, username: name, companyName: "QA", password: await bcrypt.hash("Testing123!", 4), authProvider: "email", isVerified: true, isReportApprover: true }); }
async function report(kind: "asset" | "lot-listing", user: any, extra: any = {}) {
  const p = preview(); if (kind === "lot-listing") delete (p as any).admin_schedule_sheet;
  const Model = kind === "asset" ? Asset : Lot;
  return Model.create({ user: user._id, status: "preview", job_status: "done", grouping_mode: "mixed", currency: "CAD", location: "Regina, Canada", sales_date: new Date(), contract_no: "CURRENCY-QA", imageUrls: ["https://example.test/one.jpg"], lots: p.lots, total_value: 1000, total_appraised_value: 1000, preview_data: p, ...extra });
}
beforeAll(async () => {
  process.env.DEVICE_APPROVAL_ENFORCEMENT = "off";
  mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js")); ({ default: Asset } = await import("../src/models/asset.model.js")); ({ default: Lot } = await import("../src/models/lotListing.model.js")); ({ default: User } = await import("../src/models/user.model.js")); ({ default: ReportJob } = await import("../src/models/reportJob.model.js")); ({ resetCurrencyConversionQuotaForTests: resetQuota } = await import("../src/controller/reportCurrencyConversion.controller.js"));
  ({ withCurrencyBaseRevision: withRevision } = await import("../src/service/reportCurrencyConversionService.js"));
});
beforeEach(async () => { await mongoose.connection.db!.dropDatabase(); resetQuota(); provider.create.mockReset().mockImplementation(async (input: any) => rateResponse(input)); });
afterAll(async () => { process.env.DEVICE_APPROVAL_ENFORCEMENT = "on"; await mongoose.disconnect(); await mongo.stop(); });

describe("guarded currency preview conversion API", () => {
  it("quotes a refreshed legacy Lot preview whose missing nested defaults are hydrated by Mongoose", async () => {
    const owner = await account(), _id = new mongoose.Types.ObjectId(), now = new Date();
    const lot = { lot_id: "legacy-1", lot_number: "1", title: "Legacy equipment", estimated_value: "CAD 100" };
    await Lot.collection.insertOne({ _id, user: owner._id, status: "preview", job_status: "done", currency: "CAD", contract_no: "LEGACY-QA", location: "Regina, Canada", sales_date: now, lots: [lot], imageUrls: [], preview_data: { currency: "CAD", location: "Regina, Canada", lots: [lot], total_value: 100 }, createdAt: now, updatedAt: now });
    const get = await request(app).get(`/api/lot-listing/${_id}/preview`).set(auth(owner._id));
    expect(get.status).toBe(200);
    const raw = clone(await Lot.collection.findOne({ _id }));
    const quoted = await request(app).post(`/api/lot-listing/${_id}/preview/currency-conversion`).set(auth(owner._id)).send({ targetCurrency: "USD", preview_data: get.body.data.preview_data });
    expect(quoted.status, JSON.stringify(quoted.body)).toBe(200);
    expect(clone(await Lot.collection.findOne({ _id }))).toEqual(raw);
    const saved = await request(app).put(`/api/lot-listing/${_id}/preview`).set(auth(owner._id)).send({ preview_data: quoted.body.data.preview_data });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect((await Lot.findById(_id).lean()).currency).toBe("USD");
  });
  it("stamps editable GETs and refuses stale-at-quote snapshots before paying for lookup", async () => {
    const owner = await account(), saved = await report("asset", owner);
    const get = await request(app).get(`/api/asset/${saved._id}/preview`).set(auth(owner._id));
    expect(get.status).toBe(200); expect(get.body.data.preview_data._currency_base_revision).toMatch(/^[a-f0-9]{64}$/);
    await Asset.updateOne({ _id: saved._id }, { $set: { "preview_data.owner_name": "New authoritative value", updatedAt: new Date(Date.now() + 1000) } }, { timestamps: false });
    const before = clone(await Asset.findById(saved._id).lean());
    const stale = await request(app).post(`/api/asset/${saved._id}/preview/currency-conversion`).set(auth(owner._id)).send({ targetCurrency: "USD", preview_data: get.body.data.preview_data });
    expect(stale.status).toBe(409); expect(provider.create).not.toHaveBeenCalled();
    expect(clone(await Asset.findById(saved._id).lean())).toEqual(before);
  });
  it.each(["asset", "lot-listing"] as const)("quotes %s without writes and persists complete conversion through normal Save", async kind => {
    const owner = await account(), saved = await report(kind, owner), Model = kind === "asset" ? Asset : Lot;
    const before = clone(await Model.findById(saved._id).lean());
    const quoted = await request(app).post(`/api/${kind}/${saved._id}/preview/currency-conversion`).set(auth(owner._id)).send({ targetCurrency: "USD", preview_data: withRevision(before) });
    expect(quoted.status).toBe(200); expect(quoted.body.data.quote.rate).toBe(.5);
    expect(clone(await Model.findById(saved._id).lean())).toEqual(before);
    expect(await ReportJob.countDocuments()).toBe(0);
    const converted = quoted.body.data.preview_data; converted.lots[0].title = "Edited after conversion";
    const response = await request(app).put(`/api/${kind}/${saved._id}/preview`).set(auth(owner._id)).send({ preview_data: converted });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const after = await Model.findById(saved._id).lean();
    expect(after.currency).toBe("USD"); expect(after.preview_data.currency).toBe("USD");
    expect(after.total_value).toBe(500); expect(after.lots[0].estimated_value).toMatch(/USD.*500/);
    expect(after.preview_data.lots[0].opening_bid).toBe(5); expect(after.preview_data.lots[0].title).toBe("Edited after conversion");
    expect(after.preview_data.currency_conversion.token).toBe(converted.currency_conversion.token);
    expect(after.preview_data._currency_base_revision).toBeUndefined();
    expect(after.imageUrls).toEqual(saved.imageUrls); expect(await ReportJob.countDocuments()).toBe(0);
    if (kind === "asset") {
      expect(after.preview_data.admin_schedule_sheet.rows[0].evaluator_values.owner).toBe(1000);
      expect(after.proposal_valuation_revision).toBe(1);
      const again = clone(after.preview_data); again.owner_name = "Ordinary next edit";
      const edited = await request(app).put(`/api/asset/${saved._id}/preview`).set(auth(owner._id)).send({ preview_data: again });
      expect(edited.status).toBe(200);
      expect((await Asset.findById(saved._id).lean()).preview_data.admin_schedule_sheet.rows[0].evaluator_values.owner).toBe(1000);
    }
  });
  it.each(["asset", "lot-listing"] as const)("rejects a stale %s quote on Save without partial writes", async kind => {
    const owner = await account(), saved = await report(kind, owner), Model = kind === "asset" ? Asset : Lot;
    const quoted = await request(app).post(`/api/${kind}/${saved._id}/preview/currency-conversion`).set(auth(owner._id)).send({ targetCurrency: "USD", preview_data: withRevision(saved) });
    expect(quoted.status).toBe(200);
    await Model.updateOne({ _id: saved._id }, { $set: { "preview_data.owner_name": "Concurrent edit", updatedAt: new Date(Date.now() + 1000) } }, { timestamps: false });
    const before = clone(await Model.findById(saved._id).lean());
    const response = await request(app).put(`/api/${kind}/${saved._id}/preview`).set(auth(owner._id)).send({ preview_data: quoted.body.data.preview_data });
    expect(response.status).toBe(409); expect(clone(await Model.findById(saved._id).lean())).toEqual(before); expect(await ReportJob.countDocuments()).toBe(0);
  });
  it("allows only the current owner or assigned approver, with recheck after a lookup", async () => {
    const owner = await account(), approver = await account("approver"), stranger = await account("stranger");
    const saved = await report("asset", owner, { status: "pending_approval", approval_assigned_to: approver._id });
    const body = { targetCurrency: "USD", preview_data: withRevision(saved) };
    expect((await request(app).post(`/api/asset/${saved._id}/preview/currency-conversion`).set(auth(stranger._id)).send(body)).status).toBe(404);
    expect((await request(app).post(`/api/reports/assigned-approvals/${saved._id}/preview/currency-conversion`).set(auth(stranger._id)).send(body)).status).toBe(404);
    expect(provider.create).not.toHaveBeenCalled();
    const quoted = await request(app).post(`/api/reports/assigned-approvals/${saved._id}/preview/currency-conversion`).set(auth(approver._id)).send(body);
    expect(quoted.status).toBe(200);
    const edited = await request(app).put(`/api/reports/assigned-approvals/${saved._id}/preview`).set(auth(approver._id)).send({ preview_data: quoted.body.data.preview_data });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect((await Asset.findById(saved._id).lean()).currency).toBe("USD");
    let finish!: (value: any) => void;
    provider.create.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const current = await Asset.findById(saved._id).lean();
    const pending = request(app).post(`/api/reports/assigned-approvals/${saved._id}/preview/currency-conversion`).set(auth(approver._id)).send({ targetCurrency: "EUR", preview_data: withRevision(current) }).then(r => r);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await Asset.updateOne({ _id: saved._id }, { $set: { approval_assigned_to: stranger._id } });
    finish(rateResponse({ input: "1 USD in EUR" }));
    expect((await pending).status).toBe(409);
  });
  it("converts only a merged derivative, preserving every source parent", async () => {
    const owner = await account(), parent = await report("asset", owner), merged = await report("asset", owner, { is_merged_report: true, merged_from_report_ids: [parent._id], preview_files: { excel: "https://example.test/already.xlsx" } });
    const original = clone(await Asset.findById(parent._id).lean());
    const quoted = await request(app).post(`/api/asset/${merged._id}/preview/currency-conversion`).set(auth(owner._id)).send({ targetCurrency: "USD", preview_data: withRevision(merged) });
    expect(quoted.status).toBe(200);
    const edited = await request(app).put(`/api/asset/${merged._id}/preview`).set(auth(owner._id)).send({ preview_data: quoted.body.data.preview_data });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect((await Asset.findById(merged._id).lean()).currency).toBe("USD");
    expect(clone(await Asset.findById(parent._id).lean())).toEqual(original);
  });
  it("blocks active file generation before paying for a lookup", async () => {
    const owner = await account(), saved = await report("lot-listing", owner, { files_generating: true });
    const response = await request(app).post(`/api/lot-listing/${saved._id}/preview/currency-conversion`).set(auth(owner._id)).send({ targetCurrency: "USD", preview_data: withRevision(saved) });
    expect(response.status).toBe(409); expect(provider.create).not.toHaveBeenCalled();
  });
});
