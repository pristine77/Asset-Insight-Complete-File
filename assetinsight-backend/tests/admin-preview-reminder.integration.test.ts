import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const providers = vi.hoisted(() => ({ email: vi.fn(), legacy: vi.fn(), push: vi.fn() }));
vi.mock("../src/utils/sendVerificationEmail.js", async (load) => ({
  ...await load<typeof import("../src/utils/sendVerificationEmail.js")>(),
  sendTransactionalEmail: providers.email, sendEmail: providers.legacy,
}));
vi.mock("../src/utils/expoPush.js", async (load) => ({
  ...await load<typeof import("../src/utils/expoPush.js")>(), sendExpoPushNotifications: providers.push,
}));

type Kind = "asset" | "lotListing";
let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let AssetReport: typeof import("../src/models/asset.model.js")["default"];
let LotListing: typeof import("../src/models/lotListing.model.js")["default"];
let ReportJob: typeof import("../src/models/reportJob.model.js")["default"];
let Delivery: typeof import("../src/models/previewReminderDelivery.model.js")["default"];
let Notification: typeof import("../src/models/notification.model.js")["default"];
let reminders: typeof import("../src/service/previewReminderService.js");
const ownerId = new mongoose.Types.ObjectId(), adminId = new mongoose.Types.ObjectId(), otherAdminId = new mongoose.Types.ObjectId();
const headers = (id: unknown = adminId) => ({ Authorization: `Bearer ${jwt.sign({ id: String(id), role: "superadmin" }, process.env.JWT_SECRET!, { expiresIn: "30m" })}` });
const model = (kind: Kind): any => kind === "asset" ? AssetReport : LotListing;
const route = (id: unknown) => `/api/admin/preview-reports/${id}/reminder`;
const lot = (number: string, value = "") => ({
  lot_id: `saved-${number}`, lot_number: number, title: "Saved vehicle", description: "Saved reviewed description.\nSecond paragraph.",
  estimated_value: value, image_urls: ["https://assetinsight.test/fixture/original.jpg"], image_indexes: [0],
  condition_report_selections: { condition: "N/A", completeness: "N/A", legal: "N/A" },
});
async function report(kind: Kind = "lotListing", overrides: Record<string, any> = {}) {
  const lots = [lot("750", kind === "asset" ? "CAD 1000" : ""), lot("751", kind === "asset" ? "CAD 2000" : "")];
  return model(kind).create({ user: ownerId, contract_no: "91019", grouping_mode: "single_lot", currency: "CAD",
    sales_date: new Date("2026-09-01"), location: "Regina, SK", imageUrls: lots[0].image_urls, lots, total_value: 0,
    preview_data: { contract_no: "91019", currency: "CAD", total_value: 0, lots }, status: "error", job_status: "error",
    job_id: `fixture-${randomUUID()}`, job_error: kind === "lotListing" ? "Please enter FMV for Lot 750, Lot 751" : "Internal provider detail should not be shared",
    preview_submitted_at: new Date("2026-09-01"), files_generating: false, files_regenerating: false, ...overrides });
}
async function draft(id: unknown) {
  const response = await request(app).get(route(id)).set(headers());
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.headers["cache-control"]).toContain("no-store");
  return response.body;
}
const reviewed = (value: any, overrides: Record<string, any> = {}) => ({ subject: value.subject, message: value.message,
  baseRevision: value.baseRevision, requestId: randomUUID(), ...overrides });
const send = (id: unknown, body: any, actor: unknown = adminId) => request(app).post(route(id)).set(headers(actor)).send(body);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: AssetReport } = await import("../src/models/asset.model.js"));
  ({ default: LotListing } = await import("../src/models/lotListing.model.js"));
  ({ default: ReportJob } = await import("../src/models/reportJob.model.js"));
  ({ default: Delivery } = await import("../src/models/previewReminderDelivery.model.js"));
  ({ default: Notification } = await import("../src/models/notification.model.js"));
  reminders = await import("../src/service/previewReminderService.js");
});
beforeEach(async () => {
  vi.restoreAllMocks();
  providers.email.mockReset().mockResolvedValue("fixture-provider-ack");
  providers.legacy.mockReset().mockResolvedValue(undefined);
  providers.push.mockReset().mockResolvedValue([]);
  await mongoose.connection.db!.dropDatabase();
  await User.collection.insertMany([
    { _id: ownerId, username: "Fixture Appraiser", email: "appraiser@example.test", role: "user", isVerified: true,
      expoPushTokens: ["ExponentPushToken[fixture-owner-device]"] },
    { _id: adminId, username: "Fixture Operations", email: "admin@example.test", role: "superadmin", isVerified: true },
    { _id: otherAdminId, username: "Other Operations", email: "other-admin@example.test", role: "superadmin", isVerified: true },
  ] as any);
});
afterAll(async () => { vi.restoreAllMocks(); await mongoose.disconnect(); await mongo.stop(); });

describe.sequential("reviewed owner notifications from saved preview errors", () => {
  it("GET is side-effect-free and explains the retired Lot Listing FMV requirement", async () => {
    const saved = await report();
    const before = await LotListing.collection.findOne({ _id: saved._id });
    const value = await draft(saved._id);
    expect(value).toMatchObject({ eligible: true, reportType: "LotListing", contractNo: "91019",
      recipient: { id: String(ownerId), email: "appraiser@example.test" }, affectedLots: [] });
    expect(value.subject).toContain("91019");
    expect(value.reportError).toContain("FMV and appraisal condition selections are now optional");
    expect(value.message).toContain("Hello Fixture Appraiser");
    expect(value.message).not.toContain(value.reportError);
    expect(value.correctionSteps.join(" ")).toMatch(/review every lot.*Save.*resubmit/);
    expect(value.correctionSteps.join(" ")).not.toContain("Enter a positive");
    expect(value.baseRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(value).not.toHaveProperty("job_error");
    expect(await LotListing.collection.findOne({ _id: saved._id })).toEqual(before);
    expect(await Delivery.countDocuments()).toBe(0);
    expect(await Notification.countDocuments()).toBe(0);
    expect(providers.email).not.toHaveBeenCalled();
  });

  it.each(["asset", "lotListing"] as const)("%s sends reviewed text plus immutable guidance once to the authoritative owner", async (kind) => {
    const saved = await report(kind);
    const before = await model(kind).findById(saved._id).lean();
    const value = await draft(saved._id);
    const body = reviewed(value, { subject: "Review report 91019", message: "Hello appraiser,\n\nPlease review <script>alert('x')</script> and save your corrections.\n\nOperations" });
    const response = await send(saved._id, body);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ deliveryStatus: "sent", inAppStatus: "sent", requestId: body.requestId });
    expect(providers.email).toHaveBeenCalledTimes(1);
    const email = providers.email.mock.calls[0][0];
    expect(email).toMatchObject({ to: "appraiser@example.test", subject: body.subject });
    expect(email.idempotencyKey).toMatch(/^preview-reminder-[a-f0-9]{64}$/);
    expect(email.htmlContent).toContain("&lt;script&gt;");
    expect(email.htmlContent).not.toContain("<script>");
    expect(email.htmlContent).toContain(value.reportError);
    expect(email.htmlContent).toContain(value.correctionSteps[0]);
    const note: any = await Notification.findOne().lean();
    expect(note.body).toBe(body.message);
    expect(note.data).toMatchObject({ subject: body.subject, message: body.message, reportError: value.reportError,
      correctionSteps: value.correctionSteps, reportId: String(saved._id), kind: "preview", route: "/previews" });
    expect(String(note.user)).toBe(String(ownerId));
    const after = await model(kind).findById(saved._id).lean();
    for (const field of ["user", "status", "job_id", "job_status", "job_error", "preview_data", "imageUrls", "preview_submitted_at"]) expect(after[field]).toEqual(before[field]);
    expect(await ReportJob.countDocuments()).toBe(0);
    expect(providers.legacy).not.toHaveBeenCalled();
  });

  it("keeps authentication and database-backed superadmin authorization on GET and POST", async () => {
    const saved = await report();
    const value = await draft(saved._id);
    expect((await request(app).get(route(saved._id))).status).toBe(401);
    expect((await request(app).post(route(saved._id)).send(reviewed(value))).status).toBe(401);
    await User.updateOne({ _id: otherAdminId }, { $set: { role: "admin" } });
    expect((await request(app).get(route(saved._id)).set(headers(otherAdminId))).status).toBe(403);
    expect((await send(saved._id, reviewed(value), otherAdminId)).status).toBe(403);
    expect(providers.email).not.toHaveBeenCalled();
  });

  it.each([
    { status: "approved", job_status: "done", release_status: "released" },
    { job_status: "processing" }, { files_generating: true }, { files_regenerating: true },
    { excel_regenerating: true }, { files_regeneration_pending: true }, { is_draft_preview: true },
    { adminArchivedAt: new Date() }, { proposal_valuation_regeneration_claim_token: "active-claim" },
    { proposal_valuation_artifact_publish_token: "publishing", proposal_valuation_artifact_publish_expires_at: new Date(Date.now() + 60_000) },
    { report_job_outbox: { id: "accepted-intent" } }, { preview_data: { lots: [] } },
  ])("does not send for nonactionable report state %j", async (fields) => {
    const saved = await report("asset", fields);
    const value = await draft(saved._id);
    expect(value.eligible).toBe(false);
    expect((await send(saved._id, reviewed(value))).status).toBe(409);
    expect(providers.email).not.toHaveBeenCalled();
  });

  it("blocks any live job and blocked owner, while ready unsubmitted previews remain supported", async () => {
    const saved = await report("lotListing", { status: "preview", job_status: "done", job_error: null, preview_submitted_at: null });
    expect((await draft(saved._id)).eligible).toBe(true);
    await ReportJob.create({ type: "lot-listing-excel-cr-files", status: "queued", reportId: String(saved._id), payload: {} });
    expect((await draft(saved._id)).eligible).toBe(false);
    await ReportJob.deleteMany({});
    await User.updateOne({ _id: ownerId }, { $set: { isBlocked: true } });
    expect((await draft(saved._id)).eligible).toBe(false);
  });

  it.each([
    { message: "unreviewed legacy body" }, { recipient: "attacker@example.test" }, { actorId: "attacker" },
    { subject: "Report\nBcc: attacker@example.test" }, { message: "unsafe\u0000content" },
    { message: "a".repeat(10_001) }, { subject: "a".repeat(181) }, { baseRevision: "stale" }, { requestId: "unbound" },
  ])("rejects unreviewed/header-injected/oversized request %j", async (invalid) => {
    const saved = await report();
    const value = await draft(saved._id);
    const body = invalid.message === "unreviewed legacy body" ? invalid : reviewed(value, invalid);
    expect((await send(saved._id, body)).status).toBe(400);
    expect(await Delivery.countDocuments()).toBe(0);
    expect(providers.email).not.toHaveBeenCalled();
  });

  it.each(["owner", "email", "error", "preview"])("rejects a stale draft after %s changes", async (field) => {
    const saved = await report();
    const body = reviewed(await draft(saved._id));
    if (field === "owner") await LotListing.updateOne({ _id: saved._id }, { $set: { user: otherAdminId } });
    if (field === "email") await User.updateOne({ _id: ownerId }, { $set: { email: "corrected@example.test" } });
    if (field === "error") await LotListing.updateOne({ _id: saved._id }, { $set: { job_error: "Different failure" } });
    if (field === "preview") await LotListing.updateOne({ _id: saved._id }, { $set: { "preview_data.lots.0.description": "New saved owner text" } });
    expect((await send(saved._id, body)).body.code).toBe("REMINDER_REVISION_CONFLICT");
    expect(providers.email).not.toHaveBeenCalled();
  });

  it("fences a same-timestamp edit racing the parent claim", async () => {
    const saved = await report();
    const body = reviewed(await draft(saved._id));
    const original = LotListing.updateOne.bind(LotListing);
    vi.spyOn(LotListing, "updateOne").mockImplementationOnce((async (filter: any, update: any, options: any) => {
      await LotListing.collection.updateOne({ _id: saved._id }, { $set: { "preview_data.lots.0.description": "Racing owner correction" } });
      return original(filter, update, options);
    }) as any);
    const response = await send(saved._id, body);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("REMINDER_REVISION_CONFLICT");
    expect(providers.email).not.toHaveBeenCalled();
    expect((await LotListing.findById(saved._id).lean())?.preview_data?.lots[0].description).toBe("Racing owner correction");
  });

  it("coalesces concurrent and repeated checks without another provider send or inbox item", async () => {
    const saved = await report();
    const body = reviewed(await draft(saved._id));
    let release!: (value: string) => void;
    providers.email.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    const first = send(saved._id, body).then((response) => response);
    await vi.waitFor(() => expect(providers.email).toHaveBeenCalledTimes(1));
    const concurrent = await send(saved._id, body);
    expect(concurrent.status).toBe(202);
    expect(concurrent.body.deliveryStatus).toBe("processing");
    const secondRequest = await send(saved._id, { ...body, requestId: randomUUID() });
    expect(secondRequest.body.code).toBe("REMINDER_DELIVERY_PENDING");
    release("ack");
    expect((await first).status).toBe(200);
    expect((await send(saved._id, body, otherAdminId)).status).toBe(200);
    expect((await send(saved._id, { ...body, requestId: randomUUID() })).status).toBe(200);
    expect((await send(saved._id, { ...body, message: "Different reviewed content" })).status).toBe(409);
    expect(await Notification.countDocuments()).toBe(1);
    expect(await Delivery.countDocuments()).toBe(1);
    expect((await Delivery.findOne().lean())?.actorId).toBe(String(adminId));
    expect(providers.email).toHaveBeenCalledTimes(1);
  });

  it("accepts only one simultaneous fresh request and canonicalizes report ID aliases", async () => {
    const saved = await report();
    const body = reviewed(await draft(saved._id));
    const otherBody = { ...body, requestId: randomUUID() };
    const responses = await Promise.all([send(saved._id, body), send(saved._id, otherBody)]);
    expect(responses.some((response) => response.status === 200)).toBe(true);
    expect(responses.every((response) => [200, 202, 409].includes(response.status))).toBe(true);
    expect(providers.email).toHaveBeenCalledTimes(1);
    const accepted: any = await Delivery.findOne({ state: "sent" }).lean();
    const acceptedBody = { ...body, requestId: accepted.requestId };
    expect((await send(String(saved._id).toUpperCase(), acceptedBody)).status).toBe(200);
    expect(providers.email).toHaveBeenCalledTimes(1);
    expect(await Notification.countDocuments()).toBe(1);
  });

  it.each(["asset", "lotListing"] as const)("%s excludes an accepted manual send from scheduled reminder claims", async (kind) => {
    const { previewClaimFilter } = await import("../src/jobs/previewReviewReminderJob.js");
    const saved = await report(kind, { status: "preview", job_status: "done", job_error: null, preview_submitted_at: null,
      processing_completed_at: new Date("2026-09-01") });
    const body = reviewed(await draft(saved._id));
    let release!: (value: string) => void;
    providers.email.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve; }));
    const first = send(saved._id, body).then((response) => response);
    await vi.waitFor(() => expect(providers.email).toHaveBeenCalledTimes(1));
    const filter = { ...previewClaimFilter(new Date(Date.now() - 12 * 60 * 60_000), new Date(Date.now() - 30 * 60_000)), _id: saved._id };
    const claim = () => model(kind).findOneAndUpdate(filter, { $set: { preview_reminder_claimed_at: new Date() } }, { new: true, timestamps: false }).lean();
    expect(await claim()).toBeNull();
    release(""); // Missing acknowledgement remains quarantined after the call.
    expect((await first).body.deliveryStatus).toBe("uncertain");
    expect(await claim()).toBeNull();
    expect(providers.legacy).not.toHaveBeenCalled();
    // A different ordinary review-ready report is still claimable by cron.
    const untouched = await report(kind, { status: "preview", job_status: "done", preview_submitted_at: null,
      processing_completed_at: new Date("2026-09-01") });
    expect(await model(kind).findOne({ ...filter, _id: untouched._id }).lean()).not.toBeNull();
  });

  it.each(["asset", "lotListing"] as const)("%s blocks a manual send during a scheduled claim without relying on updatedAt", async (kind) => {
    const saved = await report(kind, { status: "preview", job_status: "done", job_error: null, preview_submitted_at: null });
    const body = reviewed(await draft(saved._id));
    const before = await model(kind).findById(saved._id).lean();
    await model(kind).updateOne({ _id: saved._id }, { $set: { preview_reminder_claimed_at: new Date() } }, { timestamps: false });
    expect((await model(kind).findById(saved._id).lean()).updatedAt).toEqual(before.updatedAt);
    const value = await draft(saved._id);
    expect(value.eligible).toBe(false);
    expect(value.ineligibleReason).toContain("scheduled reminder");
    expect((await send(saved._id, body)).status).toBe(409);
    expect(providers.email).not.toHaveBeenCalled();
  });

  it.each(["claimed", "completed"])("fences a scheduled reminder %s between review and manual CAS", async (mode) => {
    const saved = await report("asset", { status: "preview", job_status: "done", job_error: null, preview_submitted_at: null });
    const body = reviewed(await draft(saved._id));
    const original = AssetReport.updateOne.bind(AssetReport);
    vi.spyOn(AssetReport, "updateOne").mockImplementationOnce((async (filter: any, update: any, options: any) => {
      await AssetReport.collection.updateOne({ _id: saved._id }, { $set: mode === "claimed"
        ? { preview_reminder_claimed_at: new Date() }
        : { preview_reminder_claimed_at: null, preview_reminder_sent_at: new Date(), preview_reminder_recipient_ids: [ownerId] } });
      return original(filter, update, options);
    }) as any);
    const response = await send(saved._id, body);
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("REMINDER_REVISION_CONFLICT");
    expect(providers.email).not.toHaveBeenCalled();
  });

  it.each(["delivered", "failed"])("requires re-review if the scheduler %s after GET, even with timestamps disabled", async (outcome) => {
    const saved = await report("asset", { status: "preview", job_status: "done", job_error: null, preview_submitted_at: null });
    const value = await draft(saved._id);
    await AssetReport.updateOne({ _id: saved._id }, { $set: outcome === "delivered"
      ? { preview_reminder_claimed_at: null, preview_reminder_sent_at: new Date(), preview_reminder_recipient_ids: [ownerId] }
      : { preview_reminder_claimed_at: null, preview_reminder_error: "Fixture provider uncertainty; Operations review needed" }
    }, { timestamps: false });
    const current = await draft(saved._id);
    expect(current.baseRevision).not.toBe(value.baseRevision);
    if (outcome === "delivered") expect(current.lastSentAt).toBeTruthy();
    expect((await send(saved._id, reviewed(value))).body.code).toBe("REMINDER_REVISION_CONFLICT");
    expect(providers.email).not.toHaveBeenCalled();
  });

  it.each(["throw", "no-provider-id"])("quarantines %s instead of retrying email and retains a full inbox item", async (failure) => {
    const saved = await report();
    const value = await draft(saved._id);
    const body = reviewed(value);
    if (failure === "throw") providers.email.mockRejectedValueOnce(new Error("Request timed out after acceptance"));
    else providers.email.mockResolvedValueOnce(null);
    const response = await send(saved._id, body);
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ deliveryStatus: "uncertain", inAppStatus: "sent" });
    const pending = await draft(saved._id);
    expect(pending.pendingDelivery).toMatchObject({ requestId: body.requestId, status: "uncertain" });
    expect((await send(saved._id, { ...body, requestId: randomUUID() })).body.code).toBe("REMINDER_DELIVERY_PENDING");
    await LotListing.updateOne({ _id: saved._id }, { $set: { user: otherAdminId, job_error: "changed after send" } });
    const frozen = await draft(saved._id);
    expect(frozen.recipient.id).toBe(String(ownerId));
    expect(frozen.baseRevision).toBe(body.baseRevision);
    expect((await send(saved._id, body, otherAdminId)).body.deliveryStatus).toBe("uncertain");
    expect(providers.email).toHaveBeenCalledTimes(1);
    expect(await Notification.countDocuments()).toBe(1);
  });

  it("recovers an uncertain inbox insert using the same request without resending confirmed email", async () => {
    const saved = await report();
    const body = reviewed(await draft(saved._id));
    vi.spyOn(Notification, "updateOne").mockRejectedValueOnce(new Error("Temporary fixture DB failure"));
    const response = await send(saved._id, body);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ deliveryStatus: "sent", inAppStatus: "uncertain" });
    const pending = await draft(saved._id);
    expect(pending.pendingDelivery).toMatchObject({ requestId: body.requestId, status: "uncertain", deliveryStatus: "sent" });
    expect((await send(saved._id, body, otherAdminId)).body.inAppStatus).toBe("sent");
    expect(await Notification.countDocuments()).toBe(1);
    expect(providers.email).toHaveBeenCalledTimes(1);
    expect((await draft(saved._id)).pendingDelivery).toBeUndefined();
  });

  it("never retries the provider when its successful receipt write becomes uncertain", async () => {
    const saved = await report();
    const body = reviewed(await draft(saved._id));
    const update = Delivery.updateOne.bind(Delivery);
    vi.spyOn(Delivery, "updateOne").mockImplementation(((filter: any, value: any, options: any) => {
      if (value?.$set?.state === "sent") return Promise.reject(new Error("Receipt write lost"));
      return update(filter, value, options);
    }) as any);
    expect((await send(saved._id, body)).body.deliveryStatus).toBe("uncertain");
    await Delivery.collection.updateOne({ requestId: body.requestId }, { $set: { attemptedAt: new Date(Date.now() - 180_000) } });
    expect((await send(saved._id, body)).body.deliveryStatus).toBe("uncertain");
    expect(providers.email).toHaveBeenCalledTimes(1);
    expect(await Notification.countDocuments()).toBe(1);
  });

  it("retains large guidance in the inbox but keeps push envelopes under the Expo limit", async () => {
    const saved = await report();
    const body = reviewed(await draft(saved._id), { message: `Hello appraiser,\n${"Review the saved report carefully. ".repeat(280)}`.trim() });
    expect(body.message.length).toBeLessThan(10_000);
    expect((await send(saved._id, body)).status).toBe(200);
    expect((await Notification.findOne().lean())?.body).toBe(body.message);
    expect(providers.push).toHaveBeenCalledTimes(1);
    const push = providers.push.mock.calls[0][0][0];
    expect(Buffer.byteLength(JSON.stringify(push))).toBeLessThan(4096);
    expect(push.body).not.toContain(body.message);
    expect(push.data.notificationId).toMatch(/^[a-f0-9]{24}$/);
    expect(push.data).not.toHaveProperty("message");
    expect(push.data).not.toHaveProperty("reportError");
    expect(push.data).not.toHaveProperty("correctionSteps");
  });

  it("marks corrected FMV diagnostics historical and never exposes raw technical errors", async () => {
    const saved = await report();
    await LotListing.updateOne({ _id: saved._id }, { $set: { "preview_data.lots.0.estimated_value": "CAD 1200", "preview_data.lots.1.estimated_value": "CAD 1300" } });
    const corrected = await draft(saved._id);
    expect(corrected.reportError).toMatch(/previous generation.*older Lot Listing requirement/);
    expect(corrected.affectedLots).toEqual([]);
    const technical = await report("asset", { job_error: "Secret fixture-key at https://provider.example.test/token?key=fixture-key /private/internal/path stack trace" });
    const value = await draft(technical._id);
    expect(value.reportError).toContain("does not establish that any user-entered value is incorrect");
    expect(JSON.stringify(value)).not.toMatch(/fixture-key|private\/internal|provider\.example/);
  });

  it("keeps large Lot Listings bounded without inventing missing-FMV blockers", async () => {
    const lots = Array.from({ length: 600 }, (_, index) => lot(`${index + 1}-${"long-reference-".repeat(4)}`));
    const saved = await report("lotListing", { preview_data: { currency: "CAD", total_value: 0, lots } });
    const value = await draft(saved._id);
    expect(value.message.length).toBeLessThanOrEqual(10_000);
    expect(value.affectedLots).toEqual([]);
    expect(value.reportError).toContain("now optional");
    expect(value.reportError.length).toBeLessThan(1000);
    expect((await send(saved._id, reviewed(value))).status).toBe(200);
    expect(providers.email.mock.calls[0][0].htmlContent).toContain("now optional");
  });

  it("preserves the internal draft reminder route and full message without enabling automatic failure reminders", async () => {
    const message = "Hello appraiser,\n\nReview your saved draft before submitting it.\n\nOperations";
    await reminders.sendPreviewReminder({ reportId: String(new mongoose.Types.ObjectId()), reportType: "Asset", contractNo: "DRAFT-1",
      waitingSince: new Date(), message, owner: { _id: ownerId, username: "Fixture", email: "appraiser@example.test" }, kind: "draft" });
    const note: any = await Notification.findOne().lean();
    expect(note.body).toBe(message);
    expect(note.data).toMatchObject({ message, kind: "draft", route: "/drafts" });
    expect(providers.legacy).toHaveBeenCalledTimes(1);
    expect(providers.email).not.toHaveBeenCalled();
    expect(providers.push.mock.calls[0][0][0].data).not.toHaveProperty("message");
    expect(reminders.getPreviewReminderEligibility({ workflowStage: "error", previewSubmittedAt: new Date(),
      report: { job_status: "error" }, hasSavedPreview: true,
      owner: { _id: ownerId, email: "appraiser@example.test" } }).eligible).toBe(false);
  });
});
