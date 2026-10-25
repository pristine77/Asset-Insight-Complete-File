import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

/*
   "Close my part of this contract" without another delivery (owner,
   2026-10-02). A person may have nothing left to send, so the signed-in user
   can close their OWN part of a contract they hold work on — never another
   user's, and never on a contract they have no work on.
*/

const upstream = vi.hoisted(() => ({
  closeContractPartForUser: vi.fn(),
}));

vi.mock("../src/service/auctioneer2Client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/service/auctioneer2Client.js")>();
  return {
    ...actual,
    closeContractPartForUser: upstream.closeContractPartForUser,
  };
});

let mongo: MongoMemoryServer;
let User: typeof import("../src/models/user.model.js")["default"];
let AuctioneerWorkItem: typeof import("../src/models/auctioneerWorkItem.model.js")["default"];
let Auctioneer2ClientError: typeof import("../src/service/auctioneer2Client.js")["Auctioneer2ClientError"];
let getAuctioneerDeliverySummary: typeof import("../src/service/auctioneer2IntegrationService.js")["getAuctioneerDeliverySummary"];
let queueAuctioneerDelivery: typeof import("../src/service/auctioneer2IntegrationService.js")["queueAuctioneerDelivery"];
let ReportSubmissionAdmission: typeof import("../src/models/reportSubmissionAdmission.model.js")["default"];
let ReportJob: typeof import("../src/models/reportJob.model.js")["default"];
let app: Awaited<typeof import("../src/app.js")>["default"];

const originalEnv = {
  baseUrl: process.env.AUCTIONEER2_API_BASE_URL,
  apiKey: process.env.AUCTIONEER2_API_KEY,
  enabled: process.env.AUCTIONEER2_FEATURE_ENABLED,
  deviceApproval: process.env.DEVICE_APPROVAL_ENFORCEMENT,
};

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function createUser(suffix: string) {
  return User.create({
    email: `close-${suffix}@example.test`,
    username: `Close ${suffix}`,
    password: await bcrypt.hash("Password123!", 4),
    authProvider: "email",
    isVerified: true,
  });
}

function tokenFor(userId: unknown) {
  return jwt.sign({ id: String(userId), role: "user" }, process.env.JWT_SECRET!, {
    expiresIn: "30m",
  });
}

let workItemSequence = 0;
async function createWork(input: {
  userId: mongoose.Types.ObjectId;
  contractId: string;
  status?: "claimed" | "report_created" | "sent" | "abandoned";
  deliveryStatus?: string;
  /**
   * Who the work is assigned to: the claimant by default, null for older work
   * that predates per-user assignment and names nobody.
   */
  assignedTo?: mongoose.Types.ObjectId | null;
}) {
  workItemSequence += 1;
  const status = input.status ?? "sent";
  const assignedTo = input.assignedTo === undefined ? input.userId : input.assignedTo;
  return AuctioneerWorkItem.create({
    source: "auctioneer2",
    cycleKey: `close-cycle-${workItemSequence}`,
    ...(status === "claimed" || status === "report_created"
      ? { activeContractKey: `close-active-${workItemSequence}` }
      : {}),
    ...(assignedTo ? { assignmentUserId: assignedTo } : {}),
    contract: { id: input.contractId, contractNo: `No-${input.contractId}`, eventId: "event-1" },
    kind: "scheduleA",
    snapshot: { tasks: [], lots: [], capturedAt: new Date() },
    claimedBy: input.userId,
    selectedReportType: "asset",
    clientSubmissionId: `close-submission-${workItemSequence}`,
    ...(status === "claimed"
      ? {}
      : { linkedReportModel: "AssetReport", linkedReportId: new mongoose.Types.ObjectId() }),
    status,
    delivery: {
      status: input.deliveryStatus ?? (status === "sent" ? "sent" : "not_ready"),
      completeContract: false,
      attempts: status === "sent" ? 1 : 0,
      lots: [],
      reconciliation: { required: false },
    },
  });
}

function closeRoute(contractId: string) {
  return `/api/auctioneer/contracts/${encodeURIComponent(contractId)}/close-my-part`;
}

async function createReadyWork(userId: mongoose.Types.ObjectId, contractId: string) {
  const { default: AssetReport } = await import("../src/models/asset.model.js");
  const lots = [{ lot_number: "1", title: "Test lot", description: "Test", image_indexes: [] }];
  const report = await AssetReport.create({ user: userId, contract_no: contractId, grouping_mode: "mixed",
    status: "approved", release_status: "released", job_status: "done", lots,
    preview_data: { contract_no: contractId, lots },
    preview_files: { docx: "https://files.example/test.docx", excel: "https://files.example/test.xlsx", images: "https://files.example/test.zip" } });
  const work = await createWork({ userId, contractId, status: "report_created", deliveryStatus: "ready" });
  work.linkedReportId = report._id;
  await work.save();
  return work;
}

beforeAll(async () => {
  process.env.AUCTIONEER2_API_BASE_URL = "https://auctioneer.example/api/external";
  process.env.AUCTIONEER2_API_KEY = "test-secret";
  process.env.AUCTIONEER2_FEATURE_ENABLED = "true";
  process.env.DEVICE_APPROVAL_ENFORCEMENT = "off";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: AuctioneerWorkItem } = await import("../src/models/auctioneerWorkItem.model.js"));
  ({ Auctioneer2ClientError } = await import("../src/service/auctioneer2Client.js"));
  ({ getAuctioneerDeliverySummary } = await import("../src/service/auctioneer2IntegrationService.js"));
  ({ queueAuctioneerDelivery } = await import("../src/service/auctioneer2IntegrationService.js"));
  ({ default: ReportSubmissionAdmission } = await import("../src/models/reportSubmissionAdmission.model.js"));
  ({ default: ReportJob } = await import("../src/models/reportJob.model.js"));
  ({ default: app } = await import("../src/app.js"));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await AuctioneerWorkItem.createIndexes();
  await ReportSubmissionAdmission.createIndexes();
  upstream.closeContractPartForUser.mockReset().mockImplementation(
    async (contractId: string, input: { completedByUserId: string }) => ({
      contractId,
      userId: input.completedByUserId,
      userStatus: "completed",
      taskCompleted: false,
      alreadyCompleted: false,
    })
  );
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  restoreEnv("AUCTIONEER2_API_BASE_URL", originalEnv.baseUrl);
  restoreEnv("AUCTIONEER2_API_KEY", originalEnv.apiKey);
  restoreEnv("AUCTIONEER2_FEATURE_ENABLED", originalEnv.enabled);
  restoreEnv("DEVICE_APPROVAL_ENFORCEMENT", originalEnv.deviceApproval);
});

describe.sequential("POST /api/auctioneer/contracts/:contractId/close-my-part", () => {
  it("serializes a new send behind a close and refuses it once the close is confirmed", async () => {
    const owner = await createUser("close-race");
    const work = await createReadyWork(owner._id, "contract-race");
    let finish!: () => void;
    let notifyEntered!: () => void;
    const entered = new Promise<void>((resolve) => { notifyEntered = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    upstream.closeContractPartForUser.mockImplementationOnce(async () => {
      notifyEntered();
      await gate;
      return { contractId: "contract-race", userId: String(owner._id), userStatus: "completed", taskCompleted: false, alreadyCompleted: false };
    });
    const closing = request(app).post(closeRoute("contract-race"))
      .set("Authorization", `Bearer ${tokenFor(owner._id)}`).then((response) => response);
    await Promise.race([entered, closing.then(() => { throw new Error("Close returned before entering the provider gate."); })]);
    const sending = queueAuctioneerDelivery(String(work._id), String(owner._id), { destination: "LottingBoard" }).catch((error) => error);
    expect(await ReportJob.countDocuments()).toBe(0);
    finish();
    expect((await closing).status).toBe(200);
    expect(await sending).toMatchObject({ code: "auctioneer_contract_close_pending_or_confirmed" });
    expect(await ReportJob.countDocuments()).toBe(0);
    expect((await AuctioneerWorkItem.findById(work._id).lean())?.delivery.status).toBe("ready");
  });

  it("waits for an admitted send and then refuses to close while that delivery is queued", async () => {
    const owner = await createUser("send-race");
    const work = await createReadyWork(owner._id, "contract-send-race");
    const queue = AuctioneerWorkItem.findOneAndUpdate.bind(AuctioneerWorkItem);
    let finish!: () => void;
    let notifyEntered!: () => void;
    const entered = new Promise<void>((resolve) => { notifyEntered = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const spy = vi.spyOn(AuctioneerWorkItem, "findOneAndUpdate").mockImplementationOnce((async (...args: any[]) => {
      notifyEntered();
      await gate;
      return (queue as any)(...args);
    }) as any);
    try {
      const sending = queueAuctioneerDelivery(String(work._id), String(owner._id), { destination: "LottingBoard" });
      await Promise.race([entered, sending.then(() => { throw new Error("Send returned before entering the admission gate."); })]);
      const closing = request(app).post(closeRoute("contract-send-race"))
        .set("Authorization", `Bearer ${tokenFor(owner._id)}`).then((response) => response);
      expect(upstream.closeContractPartForUser).not.toHaveBeenCalled();
      finish();
      await sending;
      const response = await closing;
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("auctioneer_contract_delivery_unfinished");
      expect(upstream.closeContractPartForUser).not.toHaveBeenCalled();
    } finally { finish(); spy.mockRestore(); }
  });

  it("keeps an uncertain close fenced after its lease is released, without blocking a colleague", async () => {
    const owner = await createUser("lost-close");
    const colleague = await createUser("lost-close-colleague");
    const work = await createReadyWork(owner._id, "contract-lost-close");
    const otherWork = await createReadyWork(colleague._id, "contract-lost-close");
    upstream.closeContractPartForUser.mockRejectedValueOnce(new Auctioneer2ClientError("Auctioneer did not confirm the close.", { statusCode: 503, code: "auctioneer2_timeout" }));
    const sendClose = () => request(app).post(closeRoute("contract-lost-close"))
      .set("Authorization", `Bearer ${tokenFor(owner._id)}`);
    await sendClose().expect(503);
    expect(await ReportSubmissionAdmission.countDocuments()).toBe(0);
    await expect(queueAuctioneerDelivery(String(work._id), String(owner._id), { destination: "LottingBoard" }))
      .rejects.toMatchObject({ code: "auctioneer_contract_close_pending_or_confirmed" });
    await expect(queueAuctioneerDelivery(String(otherWork._id), String(colleague._id), { destination: "LottingBoard" }))
      .resolves.toMatchObject({ state: "queued" });
    await sendClose().expect(200);
    expect((await AuctioneerWorkItem.findById(work._id).lean())?.delivery.contractClose?.userStatus).toBe("completed");
  });

  it("closes only the signed-in user's own part, naming them, and records it on their work", async () => {
    const owner = await createUser("owner");
    const colleague = await createUser("colleague");
    const ownerId = String(owner._id);
    const sent = await createWork({ userId: owner._id, contractId: "contract-A" });
    const unsent = await createWork({ userId: owner._id, contractId: "contract-A", status: "report_created", deliveryStatus: "ready" });
    const colleagueWork = await createWork({ userId: colleague._id, contractId: "contract-A" });
    const otherContract = await createWork({ userId: owner._id, contractId: "contract-B" });

    const response = await request(app)
      // A forged user in the query or body is ignored: the session decides.
      .post(`${closeRoute("contract-A")}?userId=${colleague._id}`)
      .set("Authorization", `Bearer ${tokenFor(ownerId)}`)
      .send({ userId: String(colleague._id), completedByUserId: String(colleague._id) });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      data: {
        contractId: "contract-A",
        contractNo: "No-contract-A",
        taskCompleted: false,
        alreadyCompleted: false,
        userStatus: "completed",
      },
    });
    expect(upstream.closeContractPartForUser).toHaveBeenCalledTimes(1);
    expect(upstream.closeContractPartForUser).toHaveBeenCalledWith("contract-A", {
      completedBy: "Close owner",
      completedByUserId: ownerId,
    });

    for (const item of [sent, unsent]) {
      const saved = await AuctioneerWorkItem.findById(item._id).lean();
      expect(saved?.delivery.contractClose).toMatchObject({
        userId: ownerId,
        closedAt: expect.any(Date),
        taskCompleted: false,
        userStatus: "completed",
        via: "manual",
      });
      // Closing does not touch the delivery itself or its worker checkpoint.
      expect(saved?.delivery.status).toBe(item.delivery.status);
      expect(saved?.delivery.contractCompletedAt).toBeUndefined();
    }
    expect((await AuctioneerWorkItem.findById(colleagueWork._id).lean())?.delivery.contractClose).toBeUndefined();
    expect((await AuctioneerWorkItem.findById(otherContract._id).lean())?.delivery.contractClose).toBeUndefined();
  });

  it("is shown on the user's delivery so My Reports stops offering it", async () => {
    const owner = await createUser("summary");
    const sent = await createWork({ userId: owner._id, contractId: "contract-S" });
    await request(app)
      .post(closeRoute("contract-S"))
      .set("Authorization", `Bearer ${tokenFor(owner._id)}`)
      .expect(200);
    await expect(getAuctioneerDeliverySummary(String(sent._id), String(owner._id))).resolves.toMatchObject({
      contractId: "contract-S",
      contractCompletionScope: "user",
      contractClosedAt: expect.any(Date),
      contractTaskCompleted: false,
      contractCloseUserStatus: "completed",
    });
  });

  it("keeps a revoked assignment distinct from a completed part in delivery summaries", async () => {
    const owner = await createUser("revoked-summary");
    const sent = await createWork({ userId: owner._id, contractId: "contract-revoked" });
    upstream.closeContractPartForUser.mockResolvedValueOnce({
      contractId: "contract-revoked", userId: String(owner._id),
      userStatus: "revoked", taskCompleted: false, alreadyCompleted: false,
    });
    await request(app).post(closeRoute("contract-revoked"))
      .set("Authorization", `Bearer ${tokenFor(owner._id)}`).expect(200);
    await expect(getAuctioneerDeliverySummary(String(sent._id), String(owner._id))).resolves.toMatchObject({
      contractClosedAt: expect.any(Date), contractTaskCompleted: false,
      contractCloseUserStatus: "revoked",
    });
  });

  it("refuses another user's contract, and one the user has no work on, without asking Auctioneer", async () => {
    const owner = await createUser("refused");
    const colleague = await createUser("refused-colleague");
    await createWork({ userId: colleague._id, contractId: "contract-theirs" });
    await createWork({ userId: owner._id, contractId: "contract-abandoned", status: "abandoned" });

    for (const contractId of ["contract-theirs", "contract-unknown", "contract-abandoned"]) {
      const response = await request(app)
        .post(closeRoute(contractId))
        .set("Authorization", `Bearer ${tokenFor(owner._id)}`);
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ success: false, code: "auctioneer_contract_assignment_not_found" });
    }
    expect(upstream.closeContractPartForUser).not.toHaveBeenCalled();
    expect(await AuctioneerWorkItem.exists({ "delivery.contractClose": { $exists: true } })).toBeNull();
  });

  it("refuses work the user holds without being its assignee: unassigned, or assigned to someone else", async () => {
    const owner = await createUser("unassigned");
    const colleague = await createUser("unassigned-colleague");
    // Older work names nobody. Auctioneer closes a contract with no per-user
    // assignments outright on any close, so this must never reach it.
    await createWork({ userId: owner._id, contractId: "contract-legacy", assignedTo: null });
    // Claimed by one user, assigned to another: neither may close it, because
    // the close must be the claimant's own assignment.
    await createWork({ userId: owner._id, contractId: "contract-crossed", assignedTo: colleague._id });

    const attempts = [
      { contractId: "contract-legacy", user: owner._id },
      { contractId: "contract-crossed", user: owner._id },
      { contractId: "contract-crossed", user: colleague._id },
    ];
    for (const { contractId, user } of attempts) {
      const response = await request(app)
        .post(closeRoute(contractId))
        .set("Authorization", `Bearer ${tokenFor(user)}`);
      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ success: false, code: "auctioneer_contract_assignment_not_found" });
    }
    expect(upstream.closeContractPartForUser).not.toHaveBeenCalled();
    expect(await AuctioneerWorkItem.exists({ "delivery.contractClose": { $exists: true } })).toBeNull();
  });

  it("requires a signed-in user", async () => {
    const response = await request(app).post(closeRoute("contract-A"));
    expect(response.status).toBe(401);
    expect(upstream.closeContractPartForUser).not.toHaveBeenCalled();
  });

  it.each(["queued", "sending", "failed", "needs_reconciliation"])(
    "waits for a %s delivery on the same contract to finish first",
    async (deliveryStatus) => {
      const owner = await createUser(`unfinished-${deliveryStatus}`);
      await createWork({ userId: owner._id, contractId: "contract-U" });
      await createWork({ userId: owner._id, contractId: "contract-U", status: "report_created", deliveryStatus });

      const response = await request(app)
        .post(closeRoute("contract-U"))
        .set("Authorization", `Bearer ${tokenFor(owner._id)}`);

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: "auctioneer_contract_delivery_unfinished" });
      expect(upstream.closeContractPartForUser).not.toHaveBeenCalled();
    }
  );

  it("can be repeated safely: one record per work item, the latest answer kept", async () => {
    const owner = await createUser("repeat");
    const sent = await createWork({ userId: owner._id, contractId: "contract-R" });
    const send = () =>
      request(app).post(closeRoute("contract-R")).set("Authorization", `Bearer ${tokenFor(owner._id)}`);

    await send().expect(200);
    // Auctioneer answers a repeat with the first outcome; here the colleague
    // has meanwhile closed theirs, so the whole contract is now complete.
    upstream.closeContractPartForUser.mockResolvedValueOnce({
      contractId: "contract-R",
      userId: null,
      userStatus: null,
      taskCompleted: true,
      alreadyCompleted: true,
    });
    const repeat = await send().expect(200);

    expect(repeat.body.data).toMatchObject({ taskCompleted: true, alreadyCompleted: true, userStatus: null });
    expect(upstream.closeContractPartForUser).toHaveBeenCalledTimes(2);
    const saved = await AuctioneerWorkItem.findById(sent._id).lean();
    expect(saved?.delivery.contractClose).toMatchObject({ taskCompleted: true, via: "manual" });
    expect(saved?.delivery.contractClose).not.toHaveProperty("userStatus");
    expect(saved?.delivery.status).toBe("sent");
  });

  it("records nothing when Auctioneer does not confirm, and explains an unknown contract", async () => {
    const owner = await createUser("upstream-failure");
    const sent = await createWork({ userId: owner._id, contractId: "contract-F" });
    upstream.closeContractPartForUser
      .mockRejectedValueOnce(new Auctioneer2ClientError("Auctioneer 2.0 rejected the request with status 503.", { statusCode: 503, code: "auctioneer2_upstream_error", upstreamStatus: 503 }))
      .mockRejectedValueOnce(new Auctioneer2ClientError("Auctioneer 2.0 rejected the request with status 404.", { statusCode: 502, code: "auctioneer2_upstream_error", upstreamStatus: 404 }));

    const unavailable = await request(app).post(closeRoute("contract-F")).set("Authorization", `Bearer ${tokenFor(owner._id)}`);
    expect(unavailable.status).toBe(503);
    expect(unavailable.body).toMatchObject({ success: false, code: "auctioneer2_upstream_error" });

    const unknown = await request(app).post(closeRoute("contract-F")).set("Authorization", `Bearer ${tokenFor(owner._id)}`);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ code: "auctioneer_contract_not_found" });

    expect((await AuctioneerWorkItem.findById(sent._id).lean())?.delivery.contractClose).toBeUndefined();
  });
});
