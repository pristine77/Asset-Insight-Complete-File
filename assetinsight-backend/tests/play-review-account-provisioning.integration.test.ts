import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import User from "../src/models/user.model.js";
import Audit from "../src/models/securityAuditEvent.model.js";
import Boundary from "../src/models/reviewAccountBoundary.model.js";
import Asset from "../src/models/asset.model.js";
import CrmLead from "../src/models/crmLead.model.js";
import { preparePlayReviewAccount } from "../src/service/reviewAccountProvisioningService.js";
import { assertReviewWorkflowAssignment, resolveIsolatedWorkflowAssignee } from "../src/service/reviewWorkflowAssignmentService.js";
import { updateUserProfile } from "../src/controller/user.controller.js";
import { pushAuctionsoftLotListingIfReady } from "../src/service/auctionsoftLotListingPush.js";
import { parsePlayReviewArguments } from "../src/scripts/preparePlayReviewAccount.js";

let mongo: MongoMemoryServer;
let reviewer: any;
let admin: any;
let ordinary: any;
const input = (apply = false) => ({ userId: String(reviewer._id), email: reviewer.email, actorId: String(admin._id), reason: "Isolated store review fixture", apply });
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
beforeEach(async () => {
  vi.restoreAllMocks();
  await mongoose.connection.db!.dropDatabase();
  [reviewer, admin, ordinary] = await User.create([
    { email: "review@example.test", username: "Reviewer", password: "hashed-fixture", role: "user", isVerified: true, deviceApprovalMode: "all_devices" },
    { email: "admin@example.test", username: "Admin", password: "hashed-fixture", role: "superadmin", isVerified: true },
    { email: "ordinary@example.test", username: "Ordinary", password: "hashed-fixture", role: "user", isVerified: true },
  ]);
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

describe("audited reviewer-only enrollment", () => {
  it("makes command application explicit and rejects ambiguous arguments", () => {
    const args = ["--user-id=" + reviewer._id, "--email=" + reviewer.email, "--actor-id=" + admin._id, "--reason=Fixture"];
    expect(parsePlayReviewArguments(args).apply).toBe(false);
    expect(parsePlayReviewArguments([...args, "--apply"]).apply).toBe(true);
    expect(() => parsePlayReviewArguments([...args, "--apply", "--apply"])).toThrow();
    expect(() => parsePlayReviewArguments([...args, "--email=other@example.test"])).toThrow();
    expect(() => parsePlayReviewArguments([...args, "--force"])).toThrow();
  });
  it("defaults ordinary accounts to non-review and dry-runs without any writes", async () => {
    expect(ordinary.isReviewAccount).toBe(false);
    expect(await preparePlayReviewAccount(input())).toMatchObject({ status: "dry_run", state: { isReviewAccount: true, isCrmAgent: true } });
    expect((await User.findById(reviewer._id))!.isReviewAccount).toBe(false);
    expect(await Audit.countDocuments()).toBe(0);
    expect(await Boundary.countDocuments()).toBe(0);
  });
  it("enrolls only the exact account, audits both phases and is idempotent", async () => {
    const ordinaryBefore = (await User.findById(ordinary._id))!.toObject();
    expect(await preparePlayReviewAccount(input(true))).toMatchObject({ status: "configured" });
    const saved = (await User.findById(reviewer._id))!;
    expect(saved).toMatchObject({ isReviewAccount: true, isCrmAgent: true, isVerified: true, deviceApprovalMode: "all_devices", role: "user" });
    expect(String(saved.reportApprover)).toBe(String(saved._id));
    expect(String(saved.releaseManager)).toBe(String(saved._id));
    expect(await Audit.countDocuments({ targetUser: saved._id })).toBe(2);
    expect(await Boundary.countDocuments({ _id: saved._id, enrollmentAudit: saved.reviewAccountSetupAudit })).toBe(1);
    expect(await preparePlayReviewAccount(input(true))).toMatchObject({ status: "already_configured" });
    expect(await Audit.countDocuments()).toBe(2);
    expect((await User.findById(ordinary._id))!.toObject()).toEqual(ordinaryBefore);
  });
  it("requires exact identity and an active superadmin", async () => {
    await expect(preparePlayReviewAccount({ ...input(true), email: ordinary.email })).rejects.toThrow();
    await expect(preparePlayReviewAccount({ ...input(true), actorId: String(ordinary._id) })).rejects.toThrow("superadmin");
    await expect(preparePlayReviewAccount({ ...input(true), userId: "invalid" })).rejects.toThrow("Exact");
    expect(await Audit.countDocuments()).toBe(0);
  });
  it("refuses a forged or foreign enrollment receipt on resume", async () => {
    await User.updateOne({ _id: reviewer._id }, { $set: { isReviewAccount: true, reviewAccountSetupAudit: new mongoose.Types.ObjectId() } });
    await expect(preparePlayReviewAccount(input(true))).rejects.toThrow("matching audited enrollment");
    expect((await User.findById(reviewer._id))!.isCrmAgent).toBe(false);
  });
  it.each([
    { isVerified: false }, { deviceApprovalMode: "manual" }, { isBlocked: true },
    { role: "admin" }, { proposalValuationEnabled: true }, { canManageSupport: true },
    { msOutlookCalendarConnected: true }, { isCrmAgent: true },
  ])("refuses ineligible enrollment without security bypass: %j", async (update) => {
    await User.collection.updateOne({ _id: reviewer._id }, { $set: update });
    await expect(preparePlayReviewAccount(input(true))).rejects.toThrow();
    expect((await User.findById(reviewer._id))!.isReviewAccount).toBe(false);
    expect(await Audit.countDocuments()).toBe(0);
  });
  it("rejects existing report data without removing it", async () => {
    await Asset.create({ user: reviewer._id, grouping_mode: "single_lot", imageUrls: [], lots: [], status: "preview", contract_no: "Fixture" });
    await expect(preparePlayReviewAccount(input(true))).rejects.toThrow("already owns data");
    expect(await Asset.countDocuments()).toBe(1);
    expect(await Audit.countDocuments()).toBe(0);
  });
  it("rejects existing CRM assignments and workflow assignments", async () => {
    await CrmLead.collection.insertOne({ assignedTo: reviewer._id });
    await expect(preparePlayReviewAccount(input(true))).rejects.toThrow("operational assignments");
    expect(await CrmLead.countDocuments()).toBe(1);
    await User.updateOne({ _id: ordinary._id }, { $set: { reportApprover: reviewer._id } });
    await expect(preparePlayReviewAccount(input(true))).rejects.toThrow();
  });
  it("does not grant isolation or CRM if the intent audit fails", async () => {
    vi.spyOn(Audit, "create").mockRejectedValueOnce(new Error("fixture audit failure") as never);
    await expect(preparePlayReviewAccount(input(true))).rejects.toThrow("fixture audit failure");
    expect(await User.findById(reviewer._id)).toMatchObject({ isReviewAccount: false, isCrmAgent: false });
  });
  it("leaves CRM disabled behind isolation after a grant failure and safely resumes", async () => {
    const realUpdate = User.findOneAndUpdate.bind(User);
    let calls = 0;
    const intercepted = vi.spyOn(User, "findOneAndUpdate").mockImplementation(((...args: any[]) => {
      calls++;
      return calls === 2 ? Promise.resolve(null) : (realUpdate as any)(...args);
    }) as any);
    await expect(preparePlayReviewAccount(input(true))).rejects.toThrow("remains isolated");
    expect(await User.findById(reviewer._id)).toMatchObject({ isReviewAccount: true, isCrmAgent: false });
    intercepted.mockRestore();
    expect(await preparePlayReviewAccount(input(true))).toMatchObject({ status: "configured" });
    expect(await Audit.countDocuments()).toBe(2);
  });
  it("makes reviewer workflow self-only and leaves ordinary assignments intact", async () => {
    await preparePlayReviewAccount(input(true));
    reviewer = await User.findById(reviewer._id);
    await expect(assertReviewWorkflowAssignment(reviewer, reviewer._id)).resolves.toBeUndefined();
    await expect(assertReviewWorkflowAssignment(reviewer, ordinary._id)).rejects.toThrow("own test reports");
    await expect(assertReviewWorkflowAssignment(ordinary, reviewer._id)).rejects.toThrow("own test reports");
    expect(String(await resolveIsolatedWorkflowAssignee(reviewer._id, "reportApprover"))).toBe(String(reviewer._id));
    await User.updateOne({ _id: ordinary._id }, { $set: { reportApprover: reviewer._id } });
    expect(await resolveIsolatedWorkflowAssignee(ordinary._id, "reportApprover")).toBeNull();
    await User.updateOne({ _id: ordinary._id }, { $set: { reportApprover: admin._id } });
    expect(String(await resolveIsolatedWorkflowAssignee(ordinary._id, "reportApprover"))).toBe(String(admin._id));
  });
  it("self-service cannot opt into review privileges or escape existing isolation", async () => {
    await preparePlayReviewAccount(input(true));
    for (const [user, desired] of [[ordinary, true], [reviewer, false]] as const) {
      const res: any = { json: vi.fn(), status: vi.fn().mockReturnThis() };
      await updateUserProfile({ userId: String(user._id), body: { username: "Updated", isReviewAccount: desired, isCrmAgent: desired, reportApprover: admin._id, reviewAccountSetupAudit: null } } as any, res);
      expect(res.status).not.toHaveBeenCalled();
      expect((await User.findById(user._id))!.isReviewAccount).toBe(!desired);
    }
  });
  it("does not let reviewer reports start legacy provider delivery from stored metadata", async () => {
    await preparePlayReviewAccount(input(true));
    const save = vi.fn(() => { throw new Error("No review provider write permitted"); });
    await expect(pushAuctionsoftLotListingIfReady({ user: reviewer._id, status: "approved", auctionsoft: { taskId: "fixture-forged-task" }, save })).resolves.toBeUndefined();
    await User.deleteOne({ _id: reviewer._id });
    await expect(pushAuctionsoftLotListingIfReady({ user: reviewer._id, status: "approved", auctionsoft: { taskId: "fixture-forged-task" }, save })).resolves.toBeUndefined();
    expect(save).not.toHaveBeenCalled();
  });
});
