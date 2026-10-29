import bcrypt from "bcryptjs";
import { createHash } from "node:crypto";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import { Auctioneer2ClientError } from "../src/service/auctioneer2Client.js";
import { auctioneer2ActiveContractKey } from "../src/utils/auctioneer2WorkItemKeys.js";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const upstream = vi.hoisted(() => ({
  listContracts: vi.fn(),
  listIncomingContracts: vi.fn(),
  listIncomingTasks: vi.fn(),
  getContractLots: vi.fn(),
  getLot: vi.fn(),
  getContractScheduleAItems: vi.fn(),
}));

vi.mock("../src/service/auctioneer2Client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/service/auctioneer2Client.js")>();
  return {
    ...actual,
    listContracts: upstream.listContracts,
    listIncomingContracts: upstream.listIncomingContracts,
    listIncomingTasks: upstream.listIncomingTasks,
    getContractLots: upstream.getContractLots,
    getLot: upstream.getLot,
    getContractScheduleAItems: upstream.getContractScheduleAItems,
  };
});

let mongo: MongoMemoryServer;
let User: typeof import("../src/models/user.model.js")["default"];
let AuctioneerWorkItem: typeof import("../src/models/auctioneerWorkItem.model.js")["default"];
let integration: typeof import("../src/service/auctioneer2IntegrationService.js");
let app: Awaited<typeof import("../src/app.js")>["default"];

const originalAuctioneerEnv = {
  baseUrl: process.env.AUCTIONEER2_API_BASE_URL,
  apiKey: process.env.AUCTIONEER2_API_KEY,
  enabled: process.env.AUCTIONEER2_FEATURE_ENABLED,
  deviceApproval: process.env.DEVICE_APPROVAL_ENFORCEMENT,
};

async function createUser(suffix: string) {
  return User.create({
    email: `auctioneer-${suffix}@example.test`,
    username: `Auctioneer ${suffix}`,
    password: await bcrypt.hash("Password123!", 4),
    authProvider: "email",
    isVerified: true,
  });
}

function proposalContract(
  userId: string,
  contractNumber: "825291" | "825295",
  id = `contract-${contractNumber}`
) {
  return {
    id,
    contractNumber,
    customerId: `customer-${contractNumber}`,
    customerName: `Customer ${contractNumber}`,
    eventId: `event-${contractNumber}`,
    eventTitle: `Event ${contractNumber}`,
    eventDate: "2026-09-15",
    closeDate: "2026-09-16",
    saleLocation: "Regina",
    categories: "Heavy Equipment",
    hasScheduleA: true,
    hasUnknownLots: false,
    status: "ProposalInAssetInsight",
    assignedUserId: userId,
    assignedUserName: "Femi Example",
    assignedUserEmail: "femi@example.test",
    assetInsightTaskCompleted: false,
  };
}

function assignedTask(
  userId: string,
  suffix = "1",
  contractId = "contract-1"
) {
  return {
    id: `task-${suffix}`,
    assignedTo: userId,
    contractNumber: "C-100",
    lot: {
      id: `lot-${suffix}`,
      contractId,
      eventId: "event-1",
      description: `Excavator ${suffix}`,
      status: "OpToDo",
    },
    submission: { id: `submission-${suffix}` },
    services: [],
    photos: [],
  };
}

describe("Auctioneer contract contact names", () => {
  it.each(["asset", "lotListing"] as const)("carries Proposal names through %s Incoming, persistence and setup without exposing contact objects", async (reportType) => {
    const user = await createUser(`contacts-${reportType}`); const owner = String(user._id);
    const contract = { ...proposalContract(owner, "825291"),
      consignor: { name: " Equipment Owner Ltd ", email: "private-owner@example.test" },
      salesperson: { displayName: " Auction Salesperson ", email: "private-sales@example.test" } };
    upstream.listIncomingContracts.mockResolvedValue([contract]);
    const [incoming] = await integration.listAuctioneerIncoming(true, owner);
    expect(incoming).toMatchObject({ consignorName: "Equipment Owner Ltd", salespersonName: "Auction Salesperson" });
    expect(incoming).not.toHaveProperty("consignor"); expect(incoming).not.toHaveProperty("salesperson");
    const claim = await integration.claimAuctioneerIncoming(incoming.cycleKey, owner, reportType);
    const saved = await AuctioneerWorkItem.findById(claim.workItemId).lean();
    expect(saved?.contract).toMatchObject({ consignorName: "Equipment Owner Ltd", salespersonName: "Auction Salesperson" });
    upstream.listIncomingContracts.mockResolvedValue([{ ...contract, consignorName: "Changed owner", salespersonName: "Changed seller" }]);
    expect((await integration.listAuctioneerIncoming(true, owner))[0])
      .toMatchObject({ consignorName: "Equipment Owner Ltd", salespersonName: "Auction Salesperson" });
    const setup = await integration.getAuctioneerWorkItemSetup(claim.workItemId, owner);
    expect(setup.contract).toMatchObject({ consignorName: "Equipment Owner Ltd", salespersonName: "Auction Salesperson" });
    expect(JSON.stringify(setup)).not.toContain("private-sales@example.test");
    expect(JSON.stringify(setup)).not.toContain("private-owner@example.test");
    expect(await AuctioneerWorkItem.findById(claim.workItemId).lean()).toEqual(saved);
  });

  it.each(["root", "contract", "lot.contract"])("reads names from task-only %s metadata", async (context) => {
    const user = await createUser(`task-contacts-${context}`); const owner = String(user._id);
    const names = { consigner_name: "Task Consignor", sales_person_name: "Task Salesperson" };
    const task = assignedTask(owner);
    upstream.listIncomingContracts.mockResolvedValue([]);
    upstream.listIncomingTasks.mockResolvedValue([context === "root" ? { ...task, ...names }
      : context === "contract" ? { ...task, contract: { id: "contract-1", ...names } }
      : { ...task, lot: { ...task.lot, contract: { id: "contract-1", ...names } } }]);
    upstream.getLot.mockResolvedValue({ rowGuid: "lot-1", contractId: "contract-1" });
    const [incoming] = await integration.listAuctioneerIncoming(true, owner);
    expect(incoming).toMatchObject({ consignorName: "Task Consignor", salespersonName: "Task Salesperson" });
    const claim = await integration.claimAuctioneerIncoming(incoming.cycleKey, owner, "lotListing");
    expect((await integration.getAuctioneerWorkItemSetup(claim.workItemId, owner)).contract)
      .toMatchObject({ consignorName: "Task Consignor", salespersonName: "Task Salesperson" });
  });

  it.each(["contract", "lot.contract"])("reads a lot-level assignment's contract details from the task's %s block", async (context) => {
    const user = await createUser(`task-details-${context}`); const owner = String(user._id);
    const block = { id: "contract-1", contractNumber: "C-100", description: "Farm equipment", customerName: "Task Customer",
      consignorName: "Task Customer", salespersonName: "Task Salesperson", eventId: "event-1", eventTitle: "Spring sale",
      eventDate: "2026-09-30", location: "Regina, SK" };
    const task = assignedTask(owner);
    upstream.listIncomingContracts.mockResolvedValue([]);
    upstream.listIncomingTasks.mockResolvedValue([context === "contract" ? { ...task, contract: block } : { ...task, lot: { ...task.lot, contract: block } }]);
    upstream.getLot.mockResolvedValue({ rowGuid: "lot-1", contractId: "contract-1" });
    const [incoming] = await integration.listAuctioneerIncoming(true, owner);
    expect(incoming).toMatchObject({ customerName: "Task Customer", consignorName: "Task Customer", salespersonName: "Task Salesperson",
      description: "Farm equipment", eventTitle: "Spring sale", eventDate: "2026-09-30", location: "Regina, SK" });
    const claim = await integration.claimAuctioneerIncoming(incoming.cycleKey, owner, "lotListing");
    const saved = await AuctioneerWorkItem.findById(claim.workItemId).lean();
    upstream.listIncomingTasks.mockResolvedValue([{ ...task, contract: { ...block,
      description: "Changed live description", customerName: "Changed live customer" } }]);
    expect((await integration.listAuctioneerIncoming(true, owner))[0])
      .toMatchObject({ customerName: "Task Customer", description: "Farm equipment" });
    expect((await integration.getAuctioneerWorkItemSetup(claim.workItemId, owner)).contract)
      .toMatchObject({ customerName: "Task Customer", description: "Farm equipment", eventTitle: "Spring sale", location: "Regina, SK" });
    expect(await AuctioneerWorkItem.findById(claim.workItemId).lean()).toEqual(saved);
  });

  it("rejects event display fallback that contradicts the primary contract feed", async () => {
    const user = await createUser("embedded-event-conflict"); const owner = String(user._id);
    const task = assignedTask(owner);
    upstream.listIncomingContracts.mockResolvedValue([{ id: "contract-1", contractNumber: "C-100",
      assignedUserId: owner, status: "Operations", eventId: "different-event" }]);
    upstream.listIncomingTasks.mockResolvedValue([{ ...task, contract: { id: "contract-1",
      eventId: "event-1", eventTitle: "Wrong event for primary feed", description: "Farm equipment" } }]);
    await expect(integration.listAuctioneerIncoming(true, owner))
      .rejects.toMatchObject({ statusCode: 409, code: "auctioneer_event_identity_conflict" });
    expect(await AuctioneerWorkItem.countDocuments()).toBe(0);
    expect(upstream.getLot).not.toHaveBeenCalled();
  });

  it.each(["foreign-contract", "conflicting-contract"])("omits embedded display details for %s identity", async scenario => {
    const user = await createUser(`embedded-${scenario}`); const owner = String(user._id);
    const task = assignedTask(owner);
    upstream.listIncomingContracts.mockResolvedValue([]);
    upstream.listIncomingTasks.mockResolvedValue([{ ...task, contractId: "contract-1", contract: {
      id: scenario === "foreign-contract" ? "foreign-contract" : "contract-1", contract_id: "foreign-contract",
      description: "Foreign description", customerName: "Foreign customer", eventTitle: "Foreign event" } }]);
    const [incoming] = await integration.listAuctioneerIncoming(true, owner);
    expect(incoming).not.toHaveProperty("description");
    expect(incoming).not.toHaveProperty("customerName");
    expect(incoming).not.toHaveProperty("eventTitle");
    expect(await AuctioneerWorkItem.countDocuments()).toBe(0);
  });

  it.each(["foreign-owner", "conflicting-event"])("fails closed for embedded details on a %s task", async scenario => {
    const user = await createUser(`embedded-${scenario}`); const owner = String(user._id);
    const task = assignedTask(scenario === "foreign-owner" ? new mongoose.Types.ObjectId().toString() : owner);
    upstream.listIncomingContracts.mockResolvedValue([]);
    upstream.listIncomingTasks.mockResolvedValue([{ ...task, contract: { id: "contract-1", description: "Farm equipment",
      eventId: scenario === "conflicting-event" ? "other-event" : "event-1" } }]);
    await expect(integration.listAuctioneerIncoming(true, owner)).rejects.toMatchObject({
      code: scenario === "foreign-owner" ? "auctioneer2_invalid_response" : "auctioneer_event_identity_conflict",
    });
    expect(await AuctioneerWorkItem.countDocuments()).toBe(0);
  });

  it.each(["contract", "task"])("reads legacy %s snapshots without backfill, and hides names from another owner", async (source) => {
    const user = await createUser(`legacy-contacts-${source}`); const owner = String(user._id);
    const foreign = await createUser(`foreign-contacts-${source}`);
    upstream.listIncomingContracts.mockResolvedValue([proposalContract(owner, "825291")]);
    const [incoming] = await integration.listAuctioneerIncoming(true, owner);
    const claim = await integration.claimAuctioneerIncoming(incoming.cycleKey, owner, "asset");
    await AuctioneerWorkItem.collection.updateOne({ _id: new mongoose.Types.ObjectId(claim.workItemId) }, { $set: {
      [source === "contract" ? "snapshot.contract" : "snapshot.tasks"]: source === "contract"
        ? { id: "contract-825291", consignorName: "Saved Consignor", salespersonName: "Saved Salesperson" }
        : [{ contractId: "contract-825291", consignorName: "Saved Consignor", salespersonName: "Saved Salesperson" }],
    } });
    const before = await AuctioneerWorkItem.findById(claim.workItemId).lean();
    upstream.listIncomingContracts.mockResolvedValue([]); upstream.listIncomingTasks.mockResolvedValue([]);
    expect((await integration.listAuctioneerIncoming(true, owner))[0])
      .toMatchObject({ consignorName: "Saved Consignor", salespersonName: "Saved Salesperson" });
    expect((await integration.getAuctioneerWorkItemSetup(claim.workItemId, owner)).contract)
      .toMatchObject({ consignorName: "Saved Consignor", salespersonName: "Saved Salesperson" });
    await expect(integration.getAuctioneerWorkItemSetup(claim.workItemId, String(foreign._id)))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(await AuctioneerWorkItem.findById(claim.workItemId).lean()).toEqual(before);
  });

  it("omits legacy contact names whose snapshot belongs to another contract", async () => {
    const user = await createUser("foreign-contract-names"); const owner = String(user._id);
    upstream.listIncomingContracts.mockResolvedValue([proposalContract(owner, "825291")]);
    const [incoming] = await integration.listAuctioneerIncoming(true, owner);
    const claim = await integration.claimAuctioneerIncoming(incoming.cycleKey, owner, "asset");
    await AuctioneerWorkItem.collection.updateOne({ _id: new mongoose.Types.ObjectId(claim.workItemId) }, { $set: {
      "snapshot.contract": { id: "foreign-contract", consignorName: "Foreign Consignor", salespersonName: "Foreign Salesperson" },
      "snapshot.tasks": [{ contractId: "foreign-contract", consignorName: "Foreign Consignor" }],
    } });
    const setup = await integration.getAuctioneerWorkItemSetup(claim.workItemId, owner);
    expect(setup.contract).not.toHaveProperty("consignorName");
    expect(setup.contract).not.toHaveProperty("salespersonName");
  });
});

describe("Auctioneer claim event reconciliation", () => {
  it.each((["asset", "lotListing"] as const).flatMap((reportType) => ["detail", "contract-lot", "task-detail", "nested-detail", "contract-alias"].map((source) => ({ reportType, source }))))("rejects foreign contract event evidence from $source in a $reportType claim", async ({ reportType, source }) => {
    const user = await createUser(`foreign-${source}-${reportType}`); const owner = String(user._id);
    upstream.listIncomingContracts.mockResolvedValue([{ id: "contract-1", contractNumber: "C-100", status: "ProposalInAssetInsight", assignedUserId: owner, ...(source === "contract-alias" ? { contract_id: "foreign-contract" } : {}) }]);
    const task = assignedTask(owner); delete (task.lot as { eventId?: string }).eventId;
    upstream.listIncomingTasks.mockResolvedValue(source === "task-detail" ? [task] : []);
    upstream.getContractLots.mockResolvedValue([{ rowGuid: "lot-1", contractId: source === "contract-lot" ? "foreign-contract" : "contract-1", eventId: "event-1" }]);
    upstream.getLot.mockResolvedValue(source === "nested-detail"
      ? { rowGuid: "lot-1", contractId: "contract-1", item: { contract: { _id: "foreign-contract", eventId: "event-1" } } }
      : { rowGuid: "lot-1", contractId: ["detail", "task-detail"].includes(source) ? "foreign-contract" : "contract-1", eventId: "event-1" });
    const [incoming] = await integration.listAuctioneerIncoming(true, owner);
    await expect(integration.claimAuctioneerIncoming(incoming.cycleKey, owner, reportType)).rejects.toMatchObject({ statusCode: 409, code: "auctioneer_event_context_changed" });
    expect(await AuctioneerWorkItem.countDocuments()).toBe(0);
  });

  it.each(["asset", "lotListing"] as const)("preserves nested task event identity in %s claim/setup", async (reportType) => {
    const user = await createUser(`nested-event-${reportType}`); const owner = String(user._id);
    upstream.listIncomingContracts.mockResolvedValue([{ id: "contract-1", contractNumber: "C-100" }]);
    upstream.listIncomingTasks.mockResolvedValue([assignedTask(owner)]);
    upstream.getLot.mockResolvedValue({ rowGuid: "lot-1", contractId: "contract-1" });
    const [incoming] = await integration.listAuctioneerIncoming(true, owner);
    const claim = await integration.claimAuctioneerIncoming(incoming.cycleKey, owner, reportType);
    expect(await integration.getAuctioneerWorkItemSetup(claim.workItemId, owner)).toMatchObject({ contract: { eventId: "event-1" }, reportType });
    expect(await AuctioneerWorkItem.findById(claim.workItemId).lean()).toMatchObject({ contract: { eventId: "event-1" }, snapshot: { event: { id: "event-1" } } });
  });

  it.each(["asset", "lotListing"] as const)("recovers a consistent contract-lot/detail event in a %s proposal claim", async (reportType) => {
    const user = await createUser(`hydrated-event-${reportType}`); const owner = String(user._id);
    upstream.listIncomingContracts.mockResolvedValue([{ id: "contract-1", contractNumber: "C-100", status: "ProposalInAssetInsight", assignedUserId: owner, eventId: "  " }]);
    upstream.listIncomingTasks.mockResolvedValue([]);
    upstream.getContractLots.mockResolvedValue([{ rowGuid: "lot-1", contractId: "contract-1", event_id: "event-1" }]);
    upstream.getLot.mockResolvedValue({ rowGuid: "lot-1", contract: { id: "contract-1" }, event: { id: "event-1" } });
    const [incoming] = await integration.listAuctioneerIncoming(true, owner);
    const claim = await integration.claimAuctioneerIncoming(incoming.cycleKey, owner, reportType);
    const saved = await AuctioneerWorkItem.findById(claim.workItemId).lean();
    expect(saved).toMatchObject({ contract: { eventId: "event-1" }, snapshot: { event: { id: "event-1" } } });
    expect(saved?.snapshot.lots[0].lotId).toBe("lot-1");
  });

  it.each(["task", "detail", "contract-lot-detail"])("rejects contradictory %s event metadata before persisting a claim", async (source) => {
    const user = await createUser(`conflict-${source}`); const owner = String(user._id);
    upstream.listIncomingContracts.mockResolvedValue([{ id: "contract-1", contractNumber: "C-100", eventId: "event-1", status: "ProposalInAssetInsight", assignedUserId: owner }]);
    const task = assignedTask(owner);
    if (source === "task") task.lot.eventId = "event-2";
    upstream.listIncomingTasks.mockResolvedValue(source === "contract-lot-detail" ? [] : [task]);
    upstream.getContractLots.mockResolvedValue([{ rowGuid: "lot-1", contractId: "contract-1", eventId: "event-1" }]);
    upstream.getLot.mockResolvedValue({ rowGuid: "lot-1", contractId: "contract-1", event: { id: source === "task" ? "event-1" : "event-2" } });
    const [incoming] = await integration.listAuctioneerIncoming(true, owner);
    await expect(integration.claimAuctioneerIncoming(incoming.cycleKey, owner, "asset")).rejects.toMatchObject({ statusCode: 409, code: "auctioneer_event_identity_conflict" });
    expect(await AuctioneerWorkItem.countDocuments()).toBe(0);
  });

  it("leaves a genuinely absent event missing rather than substituting contract or display metadata", async () => {
    const user = await createUser("absent-event"); const owner = String(user._id);
    upstream.listIncomingContracts.mockResolvedValue([{ id: "contract-1", contractNumber: "C-100", status: "ProposalInAssetInsight", assignedUserId: owner, eventTitle: "Sale", eventDate: "2026-10-01" }]);
    upstream.listIncomingTasks.mockResolvedValue([]); upstream.getContractLots.mockResolvedValue([]);
    const [incoming] = await integration.listAuctioneerIncoming(true, owner);
    const claim = await integration.claimAuctioneerIncoming(incoming.cycleKey, owner, "asset");
    expect((await integration.getAuctioneerWorkItemSetup(claim.workItemId, owner)).contract.eventId).toBeUndefined();
  });
});

beforeAll(async () => {
  process.env.AUCTIONEER2_API_BASE_URL =
    "https://auctioneer.example/api/external";
  process.env.AUCTIONEER2_API_KEY = "test-secret";
  process.env.AUCTIONEER2_FEATURE_ENABLED = "true";
  process.env.DEVICE_APPROVAL_ENFORCEMENT = "off";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: AuctioneerWorkItem } = await import(
    "../src/models/auctioneerWorkItem.model.js"
  ));
  integration = await import(
    "../src/service/auctioneer2IntegrationService.js"
  );
  ({ default: app } = await import("../src/app.js"));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await AuctioneerWorkItem.createIndexes();
  vi.clearAllMocks();
  integration.clearAuctioneer2IncomingCacheForTests();
  // No Proposal lists here (owner 2026-10-28; those are covered in
  // auctioneer2-proposal-list.integration.test.ts): every Proposal keeps the
  // older single-user flow these cases describe.
  upstream.getContractScheduleAItems.mockImplementation(async (contractId: string) => ({
    contractId,
    hasScheduleA: false,
    items: [],
  }));
  upstream.listContracts.mockResolvedValue([
    {
      id: "contract-1",
      contractNumber: "C-100",
      customerName: "Example Customer",
      eventId: "event-1",
      eventTitle: "Summer Sale",
      eventDate: "2026-09-15",
      saleLocation: "Regina",
      categories: "Heavy Equipment",
      hasScheduleA: true,
    },
  ]);
  upstream.listIncomingContracts.mockImplementation(() =>
    upstream.listContracts()
  );
  upstream.listIncomingTasks.mockResolvedValue([
    {
      contractNumber: "C-100",
      lot: {
        id: "lot-1",
        contractId: "contract-1",
        eventId: "event-1",
        description: "Excavator",
        status: "OpToDo",
      },
      submission: { id: "submission-1" },
      services: [],
      photos: [],
    },
  ]);
  upstream.getContractLots.mockResolvedValue([]);
  upstream.getLot.mockResolvedValue({
    id: "lot-1",
    contractId: "contract-1",
    eventId: "event-1",
    description: "Excavator",
    status: "OpToDo",
    services: [],
    photos: [],
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  if (originalAuctioneerEnv.baseUrl === undefined) {
    delete process.env.AUCTIONEER2_API_BASE_URL;
  } else {
    process.env.AUCTIONEER2_API_BASE_URL = originalAuctioneerEnv.baseUrl;
  }
  if (originalAuctioneerEnv.apiKey === undefined) {
    delete process.env.AUCTIONEER2_API_KEY;
  } else {
    process.env.AUCTIONEER2_API_KEY = originalAuctioneerEnv.apiKey;
  }
  if (originalAuctioneerEnv.enabled === undefined) {
    delete process.env.AUCTIONEER2_FEATURE_ENABLED;
  } else {
    process.env.AUCTIONEER2_FEATURE_ENABLED = originalAuctioneerEnv.enabled;
  }
  if (originalAuctioneerEnv.deviceApproval === undefined) {
    delete process.env.DEVICE_APPROVAL_ENFORCEMENT;
  } else {
    process.env.DEVICE_APPROVAL_ENFORCEMENT =
      originalAuctioneerEnv.deviceApproval;
  }
});

describe.sequential("Auctioneer 2.0 incoming claims", () => {
  it("uses authenticated identity and keeps proposal contracts visible without task rows", async () => {
    const femiId = "69209256be08b81c6d33e76f";
    const femi = await User.create({
      _id: femiId,
      email: "femi@example.test",
      username: "Femi Example",
      password: await bcrypt.hash("Password123!", 4),
      authProvider: "email",
      isVerified: true,
    });
    upstream.listIncomingContracts.mockResolvedValue([
      proposalContract(femiId, "825291"),
      proposalContract(femiId, "825295"),
    ]);
    upstream.listIncomingTasks.mockRejectedValue(
      new Auctioneer2ClientError(
        "proposal visibility must not require task rows",
        { statusCode: 503, code: "auctioneer2_unavailable" }
      )
    );
    const token = jwt.sign(
      { id: String(femi._id), role: "user" },
      process.env.JWT_SECRET!,
      { expiresIn: "30m" }
    );

    const response = await request(app)
      .get("/api/auctioneer/incoming?refresh=true&userId=forged")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toHaveLength(2);
    expect(
      response.body.data.map((item: any) => item.contractNo).sort()
    ).toEqual(["825291", "825295"]);
    expect(new Set(response.body.data.map((item: any) => item.cycleKey)).size).toBe(2);
    response.body.data.forEach((item: any) => {
      expect(item).toMatchObject({
        lotCount: 0,
        pendingLotCount: 0,
        status: "available",
        assignedUser: {
          id: femiId,
          name: "Femi Example",
          email: "femi@example.test",
        },
        assignedToCurrentUser: true,
      });
    });
    expect(upstream.listIncomingContracts).toHaveBeenCalledWith(femiId, true);
    expect(upstream.listIncomingTasks).toHaveBeenCalledWith(femiId, undefined);
  });

  it("fails closed when a proposal contract has no matching assignee", async () => {
    const user = await createUser("proposal-assignment");
    const userId = String(user._id);
    const missingAssignee = proposalContract(userId, "825291");
    delete (missingAssignee as any).assignedUserId;
    upstream.listIncomingContracts.mockResolvedValue([missingAssignee]);

    await expect(
      integration.listAuctioneerIncoming(false, userId)
    ).rejects.toMatchObject({
      statusCode: 502,
      code: "auctioneer2_invalid_response",
    });

    integration.clearAuctioneer2IncomingCacheForTests();
    upstream.listIncomingContracts.mockResolvedValue([
      proposalContract(new mongoose.Types.ObjectId().toString(), "825291"),
    ]);
    await expect(
      integration.listAuctioneerIncoming(false, userId)
    ).rejects.toMatchObject({
      statusCode: 502,
      code: "auctioneer2_invalid_response",
    });
    expect(upstream.listIncomingTasks).not.toHaveBeenCalled();
  });

  it("revalidates a proposal contract before creating its claim snapshot", async () => {
    const user = await createUser("proposal-claim");
    const userId = String(user._id);
    const contract = proposalContract(userId, "825291");
    upstream.listIncomingContracts.mockResolvedValue([contract]);
    upstream.listIncomingTasks.mockResolvedValue([]);
    upstream.getContractLots.mockResolvedValue([
      {
        rowGuid: "proposal-lot-row-guid",
        contractId: contract.id,
        description: "Proposal excavator",
      },
    ]);
    upstream.getLot.mockResolvedValue({
      rowGuid: "proposal-lot-row-guid",
      contractId: contract.id,
      description: "Proposal excavator",
    });
    const [incoming] = await integration.listAuctioneerIncoming(false, userId);

    const claim = await integration.claimAuctioneerIncoming(
      incoming.cycleKey,
      userId,
      "asset"
    );

    expect(upstream.listIncomingContracts).toHaveBeenCalledTimes(2);
    expect(upstream.listIncomingContracts).toHaveBeenLastCalledWith(userId, true);
    expect(upstream.listIncomingTasks).toHaveBeenCalledTimes(2);
    const stored = await AuctioneerWorkItem.findById(claim.workItemId).lean();
    expect(stored).toMatchObject({
      assignmentUserId: new mongoose.Types.ObjectId(userId),
      contract: { id: contract.id, contractNo: "825291" },
      snapshot: {
        contract,
        tasks: [],
      },
    });
    expect(stored?.snapshot.lots).toHaveLength(1);
    expect(stored?.snapshot.lots[0].lotId).toBe("proposal-lot-row-guid");
  });

  it("keeps legacy task rows additive without letting their failure hide proposals", async () => {
    const user = await createUser("proposal-with-task");
    const userId = String(user._id);
    upstream.listIncomingContracts.mockResolvedValue([
      proposalContract(userId, "825291"),
    ]);
    upstream.listIncomingTasks.mockResolvedValue([
      assignedTask(userId, "legacy", "legacy-contract"),
    ]);

    const combined = await integration.listAuctioneerIncoming(false, userId);

    expect(combined.map((item) => item.contractNo).sort()).toEqual([
      "825291",
      "C-100",
    ]);

    integration.clearAuctioneer2IncomingCacheForTests();
    upstream.listIncomingTasks.mockRejectedValue(
      new Auctioneer2ClientError("legacy task feed unavailable", {
        statusCode: 503,
        code: "auctioneer2_unavailable",
      })
    );
    const proposalsOnly = await integration.listAuctioneerIncoming(
      false,
      userId
    );
    expect(proposalsOnly.map((item) => item.contractNo)).toEqual(["825291"]);

    integration.clearAuctioneer2IncomingCacheForTests();
    upstream.listIncomingTasks.mockResolvedValue([
      assignedTask(new mongoose.Types.ObjectId().toString(), "foreign"),
    ]);
    await expect(
      integration.listAuctioneerIncoming(false, userId)
    ).rejects.toMatchObject({
      statusCode: 502,
      code: "auctioneer2_invalid_response",
    });
  });

  it("does not create a blank proposal claim when contract-lot loading fails", async () => {
    const user = await createUser("proposal-lot-failure");
    const userId = String(user._id);
    upstream.listIncomingContracts.mockResolvedValue([
      proposalContract(userId, "825291"),
    ]);
    upstream.listIncomingTasks.mockResolvedValue([]);
    const [incoming] = await integration.listAuctioneerIncoming(false, userId);
    upstream.getContractLots.mockRejectedValue(
      new Error("contract lot lookup failed")
    );

    await expect(
      integration.claimAuctioneerIncoming(incoming.cycleKey, userId, "asset")
    ).rejects.toThrow("contract lot lookup failed");
    expect(await AuctioneerWorkItem.countDocuments()).toBe(0);
  });

  it("coalesces reads while keeping proposal-contract caches user scoped", async () => {
    const firstUser = await createUser("cache-one");
    const secondUser = await createUser("cache-two");
    upstream.listIncomingTasks.mockImplementation((userId: string) =>
      Promise.resolve([assignedTask(userId)])
    );

    const [first, second] = await Promise.all([
      integration.listAuctioneerIncoming(false, String(firstUser._id)),
      integration.listAuctioneerIncoming(false, String(firstUser._id)),
    ]);
    const other = await integration.listAuctioneerIncoming(
      false,
      String(secondUser._id)
    );
    await integration.listAuctioneerIncoming(true, String(firstUser._id));

    expect(first).toHaveLength(1);
    expect(second[0].cycleKey).toBe(first[0].cycleKey);
    expect(other).toHaveLength(1);
    expect(upstream.listContracts).toHaveBeenCalledTimes(3);
    expect(upstream.listIncomingContracts.mock.calls).toEqual([
      [String(firstUser._id), true],
      [String(secondUser._id), true],
      [String(firstUser._id), true],
    ]);
    expect(upstream.listIncomingTasks).toHaveBeenCalledTimes(3);
    expect(upstream.listIncomingTasks.mock.calls).toEqual([
      [String(firstUser._id), undefined],
      [String(secondUser._id), undefined],
      [String(firstUser._id), undefined],
    ]);
  });

  it("uses tasks as the authoritative queue and reports only assigned lot counts", async () => {
    const user = await createUser("task-first");
    upstream.listContracts.mockResolvedValue([
      ...Array.from({ length: 206 }, (_, index) => ({
        id: `unused-${index}`,
        contractNumber: `UNUSED-${index}`,
      })),
      {
        id: "contract-1",
        contractNumber: "C-100",
        customerName: "Example Customer",
        hasScheduleA: true,
        lotCount: 50,
      },
    ]);
    upstream.listIncomingTasks.mockResolvedValue([
      assignedTask(String(user._id), "1"),
      assignedTask(String(user._id), "2"),
    ]);

    const incoming = await integration.listAuctioneerIncoming(
      false,
      String(user._id)
    );
    expect(incoming).toHaveLength(2);
    expect(new Set(incoming.map((item) => item.cycleKey)).size).toBe(2);
    incoming.forEach((item) => {
      expect(item).toMatchObject({
        contractId: "contract-1",
        contractNo: "C-100",
        lotCount: 1,
        pendingLotCount: 0,
        status: "available",
        assignedToCurrentUser: true,
      });
    });
    await expect(
      integration.getAuctioneerIncomingSummary(String(user._id))
    ).resolves.toEqual({ availableCount: 2 });

    integration.clearAuctioneer2IncomingCacheForTests();
    upstream.listIncomingTasks.mockResolvedValue([]);
    await expect(
      integration.listAuctioneerIncoming(false, String(user._id))
    ).resolves.toEqual([]);
  });

  it("uses embedded empLots.rowGuid as the canonical known-lot target", async () => {
    const user = await createUser("row-guid");
    upstream.listIncomingTasks.mockResolvedValue([
      {
        id: "task-row-guid",
        assignedTo: String(user._id),
        contractNumber: "C-100",
        lot: {
          rowGuid: "emp-lot-row-guid",
          id: "display-or-internal-id",
          contractId: "contract-1",
          eventId: "event-1",
          description: "Loader",
          status: "OpToDo",
        },
        submission: { id: "submission-row-guid" },
      },
    ]);
    upstream.getLot.mockResolvedValue({
      rowGuid: "emp-lot-row-guid",
      id: "display-or-internal-id",
      description: "Loader detail",
    });

    const [incoming] = await integration.listAuctioneerIncoming(
      true,
      String(user._id)
    );
    const claimed = await integration.claimAuctioneerIncoming(
      incoming.cycleKey,
      String(user._id),
      "asset"
    );

    expect(upstream.getLot).toHaveBeenCalledWith("emp-lot-row-guid");
    const stored = await AuctioneerWorkItem.findById(claimed.workItemId).lean();
    expect(stored?.snapshot.lots[0]?.lotId).toBe("emp-lot-row-guid");
    expect(stored?.delivery.lots[0]?.sourceLotId).toBe("emp-lot-row-guid");
  });

  it("fails closed if Auctioneer returns an explicitly mismatched assignment", async () => {
    const requested = await createUser("requested");
    const different = await createUser("different");
    upstream.listIncomingTasks.mockResolvedValue([
      assignedTask(String(different._id)),
    ]);

    await expect(
      integration.listAuctioneerIncoming(false, String(requested._id))
    ).rejects.toMatchObject({
      statusCode: 502,
      code: "auctioneer2_invalid_response",
    });
  });

  it("counts only the current user's available work and reuses that task cache", async () => {
    const owner = await createUser("summary-owner");
    upstream.listIncomingTasks.mockResolvedValue([
      assignedTask(String(owner._id)),
    ]);
    const [first, second] = await Promise.all([
      integration.getAuctioneerIncomingSummary(String(owner._id)),
      integration.getAuctioneerIncomingSummary(String(owner._id)),
    ]);
    expect(first).toEqual({ availableCount: 1 });
    expect(second).toEqual(first);
    expect(upstream.listIncomingTasks).toHaveBeenCalledTimes(1);

    const [incoming] = await integration.listAuctioneerIncoming(
      false,
      String(owner._id)
    );
    await integration.claimAuctioneerIncoming(
      incoming.cycleKey,
      String(owner._id),
      "asset"
    );
    await expect(
      integration.getAuctioneerIncomingSummary(String(owner._id))
    ).resolves.toEqual({ availableCount: 0 });
  });

  it("revalidates a claimant's scoped feed and active user status", async () => {
    const user = await createUser("revalidate");
    upstream.listIncomingTasks.mockResolvedValue([
      assignedTask(String(user._id)),
    ]);
    const [incoming] = await integration.listAuctioneerIncoming(
      false,
      String(user._id)
    );
    upstream.listIncomingTasks.mockResolvedValue([]);
    await expect(
      integration.claimAuctioneerIncoming(
        incoming.cycleKey,
        String(user._id),
        "asset"
      )
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "auctioneer_incoming_not_found",
    });

    user.isBlocked = true;
    await user.save();
    await expect(
      integration.claimAuctioneerIncoming(
        incoming.cycleKey,
        String(user._id),
        "asset"
      )
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "auctioneer_assignee_unavailable",
    });
  });

  it("uses authenticated identity for the compact summary route", async () => {
    const unauthorized = await request(app).get(
      "/api/auctioneer/incoming/summary?userId=forged"
    );
    expect(unauthorized.status).toBe(401);

    const user = await createUser("summary-route");
    user.role = "admin";
    await user.save();
    upstream.listIncomingTasks.mockResolvedValue([
      assignedTask(String(user._id)),
    ]);
    const token = jwt.sign(
      { id: String(user._id), role: "admin" },
      process.env.JWT_SECRET!,
      { expiresIn: "30m" }
    );
    const response = await request(app)
      .get("/api/auctioneer/incoming/summary?userId=forged")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ availableCount: 1 });
    expect(upstream.listIncomingTasks).toHaveBeenCalledWith(
      String(user._id),
      undefined
    );
  });

  it("allows different users to claim different lots from the same contract", async () => {
    const firstUser = await createUser("split-one");
    const secondUser = await createUser("split-two");
    // Each detail must match its requested lot. The shared lot-1 default would
    // make the second snapshot also cover lot-1 and turn this into a race.
    upstream.getLot.mockImplementation((lotId: string) => Promise.resolve({
      id: lotId, contractId: "contract-1", eventId: "event-1", services: [], photos: [],
    }));
    upstream.listIncomingTasks.mockImplementation((userId: string) =>
      Promise.resolve([
        assignedTask(
          userId,
          userId === String(firstUser._id) ? "1" : "2"
        ),
      ])
    );
    const [firstIncoming] = await integration.listAuctioneerIncoming(
      false,
      String(firstUser._id)
    );
    const [secondIncoming] = await integration.listAuctioneerIncoming(
      false,
      String(secondUser._id)
    );
    expect(firstIncoming.cycleKey).not.toBe(secondIncoming.cycleKey);

    const [firstClaim, secondClaim] = await Promise.all([
      integration.claimAuctioneerIncoming(
        firstIncoming.cycleKey,
        String(firstUser._id),
        "asset"
      ),
      integration.claimAuctioneerIncoming(
        secondIncoming.cycleKey,
        String(secondUser._id),
        "lotListing"
      ),
    ]);
    const stored = await AuctioneerWorkItem.find({
      _id: { $in: [firstClaim.workItemId, secondClaim.workItemId] },
    }).lean();
    expect(stored).toHaveLength(2);
    expect(new Set(stored.map((item) => item.activeContractKey)).size).toBe(2);
    expect(stored.map((item) => String(item.assignmentUserId)).sort()).toEqual(
      [String(firstUser._id), String(secondUser._id)].sort()
    );
  });

  it("allows one user to claim multiple lots from the same contract independently", async () => {
    const user = await createUser("same-user-split");
    upstream.listIncomingTasks.mockResolvedValue([
      assignedTask(String(user._id), "1"),
      assignedTask(String(user._id), "2"),
    ]);
    upstream.getLot.mockImplementation((lotId: string) =>
      Promise.resolve({
        id: lotId,
        contractId: "contract-1",
        eventId: "event-1",
        description: `Description for ${lotId}`,
        status: "OpToDo",
        services: [],
        photos: [],
      })
    );

    const incoming = await integration.listAuctioneerIncoming(
      false,
      String(user._id)
    );
    expect(incoming).toHaveLength(2);
    const claims = await Promise.all(
      incoming.map((item) =>
        integration.claimAuctioneerIncoming(
          item.cycleKey,
          String(user._id),
          "lotListing"
        )
      )
    );

    const stored = await AuctioneerWorkItem.find({
      _id: { $in: claims.map((claim) => claim.workItemId) },
    }).lean();
    expect(stored).toHaveLength(2);
    expect(new Set(stored.map((item) => item.cycleKey)).size).toBe(2);
    expect(new Set(stored.map((item) => item.activeContractKey)).size).toBe(2);
    expect(stored.map((item) => item.snapshot.tasks.length)).toEqual([1, 1]);
    expect(stored.map((item) => item.snapshot.lots.length)).toEqual([1, 1]);
    expect(stored.map((item) => item.snapshot.lots[0]?.lotId).sort()).toEqual([
      "lot-1",
      "lot-2",
    ]);
    stored.forEach((item) => {
      expect(item.activeContractKey).toBe(
        auctioneer2ActiveContractKey(
          "contract-1",
          String(user._id),
          item.cycleKey
        )
      );
    });
  });

  it("preserves a claimed lot while exposing a new same-contract lot separately", async () => {
    const user = await createUser("freeze");
    upstream.listIncomingTasks.mockResolvedValue([
      assignedTask(String(user._id), "1"),
    ]);
    const [incoming] = await integration.listAuctioneerIncoming(
      false,
      String(user._id)
    );
    const claim = await integration.claimAuctioneerIncoming(
      incoming.cycleKey,
      String(user._id),
      "asset"
    );
    await AuctioneerWorkItem.updateOne(
      { _id: claim.workItemId },
      { $set: { activeContractKey: "legacy-contract-scoped-active-key" } }
    );

    upstream.listIncomingTasks.mockResolvedValue([
      assignedTask(String(user._id), "1"),
      assignedTask(String(user._id), "2"),
    ]);
    const refreshed = await integration.listAuctioneerIncoming(
      true,
      String(user._id)
    );
    expect(refreshed).toHaveLength(2);
    const claimed = refreshed.find((item) => item.cycleKey === incoming.cycleKey);
    const newlyAssigned = refreshed.find(
      (item) => item.cycleKey !== incoming.cycleKey
    );
    expect(claimed).toMatchObject({
      cycleKey: incoming.cycleKey,
      lotCount: 1,
      pendingLotCount: 0,
      status: "claimed",
      workItemId: claim.workItemId,
      assignedToCurrentUser: true,
    });
    expect(newlyAssigned).toMatchObject({
      contractId: "contract-1",
      lotCount: 1,
      pendingLotCount: 0,
      status: "available",
      assignedToCurrentUser: true,
    });
    expect(newlyAssigned).not.toHaveProperty("workItemId");
    const stored = await AuctioneerWorkItem.findById(claim.workItemId).lean();
    expect(stored?.cycleKey).toBe(incoming.cycleKey);
    expect(stored?.snapshot.tasks).toHaveLength(1);
    expect(stored?.snapshot.lots).toHaveLength(1);
    expect(stored?.snapshot.lots[0]?.lotId).toBe("lot-1");

    upstream.listIncomingTasks.mockResolvedValue([
      assignedTask(String(user._id), "2"),
    ]);
    const replacementOnly = await integration.listAuctioneerIncoming(
      true,
      String(user._id)
    );
    expect(replacementOnly).toHaveLength(2);
    expect(
      replacementOnly.find((item) => item.cycleKey === incoming.cycleKey)
    ).toMatchObject({
      cycleKey: incoming.cycleKey,
      lotCount: 1,
      pendingLotCount: 0,
      status: "claimed",
      workItemId: claim.workItemId,
    });
    const availableReplacement = replacementOnly.find(
      (item) => item.cycleKey !== incoming.cycleKey
    );
    expect(availableReplacement).toMatchObject({
      lotCount: 1,
      pendingLotCount: 0,
      status: "available",
    });

    await integration.claimAuctioneerIncoming(
      availableReplacement!.cycleKey,
      String(user._id),
      "lotListing"
    );
    expect(await AuctioneerWorkItem.countDocuments()).toBe(2);
    const unchanged = await AuctioneerWorkItem.findById(claim.workItemId).lean();
    expect(unchanged?.cycleKey).toBe(incoming.cycleKey);
    expect(unchanged?.snapshot.tasks).toHaveLength(1);
    expect(unchanged?.snapshot.lots).toHaveLength(1);
  });

  it("keeps a historical multi-lot batch frozen without hiding a later lot", async () => {
    const user = await createUser("legacy-batch");
    const firstTask = assignedTask(String(user._id), "1");
    const secondTask = assignedTask(String(user._id), "2");
    const legacy = await AuctioneerWorkItem.create({
      source: "auctioneer2",
      cycleKey: "legacy-aggregate-cycle",
      activeContractKey: "legacy-aggregate-active-key",
      assignmentUserId: user._id,
      contract: {
        id: "contract-1",
        contractNo: "C-100",
        hasScheduleA: true,
      },
      kind: "scheduleA",
      snapshot: {
        tasks: [firstTask, secondTask],
        lots: [
          { sourceKey: "lot:lot-1", lotId: "lot-1" },
          { sourceKey: "lot:lot-2", lotId: "lot-2" },
        ],
        capturedAt: new Date(),
      },
      claimedBy: user._id,
      selectedReportType: "asset",
      clientSubmissionId: "legacy-aggregate-submission",
      status: "claimed",
      delivery: {
        status: "not_ready",
        completeContract: false,
        attempts: 0,
        lots: [],
      },
    });
    upstream.listIncomingTasks.mockResolvedValue([
      firstTask,
      secondTask,
      assignedTask(String(user._id), "3"),
    ]);

    const rows = await integration.listAuctioneerIncoming(
      true,
      String(user._id)
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((item) => item.cycleKey === legacy.cycleKey)).toMatchObject({
      workItemId: String(legacy._id),
      lotCount: 2,
      pendingLotCount: 0,
      status: "claimed",
    });
    const newLot = rows.find((item) => item.cycleKey !== legacy.cycleKey);
    expect(newLot).toMatchObject({
      contractId: "contract-1",
      lotCount: 1,
      pendingLotCount: 0,
      status: "available",
      assignedToCurrentUser: true,
    });
    expect(newLot).not.toHaveProperty("workItemId");
  });

  it("hides every lot covered by a historical sent batch", async () => {
    const user = await createUser("legacy-sent-batch");
    const firstTask = assignedTask(String(user._id), "1");
    const secondTask = assignedTask(String(user._id), "2");
    const sentBatch = await AuctioneerWorkItem.create({
      source: "auctioneer2",
      cycleKey: "legacy-sent-aggregate-cycle",
      assignmentUserId: user._id,
      contract: {
        id: "contract-1",
        contractNo: "C-100",
        hasScheduleA: true,
      },
      kind: "scheduleA",
      snapshot: {
        tasks: [firstTask, secondTask],
        lots: [
          { sourceKey: "lot:lot-1", lotId: "lot-1" },
          { sourceKey: "lot:lot-2", lotId: "lot-2" },
        ],
        capturedAt: new Date(),
      },
      claimedBy: user._id,
      selectedReportType: "asset",
      clientSubmissionId: "legacy-sent-aggregate-submission",
      status: "report_created",
      delivery: {
        status: "sent",
        completeContract: false,
        attempts: 1,
        completedAt: new Date(),
        lots: [],
      },
    });
    upstream.listIncomingTasks.mockResolvedValue([firstTask, secondTask]);

    await expect(
      integration.listAuctioneerIncoming(true, String(user._id))
    ).resolves.toEqual([]);
    await expect(
      integration.getAuctioneerIncomingSummary(String(user._id))
    ).resolves.toEqual({ availableCount: 0 });
    expect(await AuctioneerWorkItem.exists({ _id: sentBatch._id })).toBeTruthy();
  });

  it("blocks a reassigned lot already covered by another user's legacy batch", async () => {
    const originalOwner = await createUser("legacy-original-owner");
    const newAssignee = await createUser("legacy-new-assignee");
    await AuctioneerWorkItem.create({
      source: "auctioneer2",
      cycleKey: "legacy-cross-user-aggregate",
      activeContractKey: "legacy-cross-user-active-key",
      assignmentUserId: originalOwner._id,
      contract: {
        id: "contract-1",
        contractNo: "C-100",
        hasScheduleA: true,
      },
      kind: "scheduleA",
      snapshot: {
        tasks: [
          assignedTask(String(originalOwner._id), "1"),
          assignedTask(String(originalOwner._id), "2"),
        ],
        lots: [
          { sourceKey: "lot:lot-1", lotId: "lot-1" },
          { sourceKey: "lot:lot-2", lotId: "lot-2" },
        ],
        capturedAt: new Date(),
      },
      claimedBy: originalOwner._id,
      selectedReportType: "asset",
      clientSubmissionId: "legacy-cross-user-submission",
      status: "report_created",
      delivery: {
        status: "ready",
        completeContract: false,
        attempts: 0,
        lots: [],
      },
    });
    upstream.listIncomingTasks.mockResolvedValue([
      assignedTask(String(newAssignee._id), "1"),
    ]);

    const [row] = await integration.listAuctioneerIncoming(
      true,
      String(newAssignee._id)
    );
    expect(row).toMatchObject({
      contractId: "contract-1",
      lotCount: 1,
      pendingLotCount: 0,
      status: "claimed",
      assignedUser: { id: String(newAssignee._id) },
      assignedToCurrentUser: true,
    });
    expect(row).not.toHaveProperty("claimedBy");
    expect(row).not.toHaveProperty("workItemId");
    await expect(
      integration.claimAuctioneerIncoming(
        row.cycleKey,
        String(newAssignee._id),
        "asset"
      )
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "auctioneer_already_claimed",
    });
    expect(await AuctioneerWorkItem.countDocuments()).toBe(1);
  });

  it("keeps a claimed known lot stable when task and submission IDs change", async () => {
    const user = await createUser("stable-lot");
    upstream.listIncomingTasks.mockResolvedValue([
      assignedTask(String(user._id), "1"),
    ]);
    const [incoming] = await integration.listAuctioneerIncoming(
      false,
      String(user._id)
    );
    const claim = await integration.claimAuctioneerIncoming(
      incoming.cycleKey,
      String(user._id),
      "lotListing"
    );
    const changedIdentifiers = assignedTask(String(user._id), "changed");
    changedIdentifiers.lot.id = "lot-1";
    upstream.listIncomingTasks.mockResolvedValue([changedIdentifiers]);

    const [refreshed] = await integration.listAuctioneerIncoming(
      true,
      String(user._id)
    );
    expect(refreshed).toMatchObject({
      cycleKey: incoming.cycleKey,
      workItemId: claim.workItemId,
      lotCount: 1,
      pendingLotCount: 0,
      status: "claimed",
    });
    expect(await AuctioneerWorkItem.countDocuments()).toBe(1);
  });

  it("removes a successfully sent lot from Incoming without deleting its history", async () => {
    const user = await createUser("sent-incoming");
    upstream.listIncomingTasks.mockResolvedValue([
      assignedTask(String(user._id), "1"),
    ]);
    const [incoming] = await integration.listAuctioneerIncoming(
      false,
      String(user._id)
    );
    const claim = await integration.claimAuctioneerIncoming(
      incoming.cycleKey,
      String(user._id),
      "lotListing"
    );
    await AuctioneerWorkItem.updateOne(
      { _id: claim.workItemId },
      {
        $set: {
          status: "sent",
          "delivery.status": "sent",
          "delivery.completedAt": new Date(),
        },
        $unset: { activeContractKey: "" },
      }
    );

    await expect(
      integration.listAuctioneerIncoming(true, String(user._id))
    ).resolves.toEqual([]);
    await expect(
      integration.getAuctioneerIncomingSummary(String(user._id))
    ).resolves.toEqual({ availableCount: 0 });
    const stored = await AuctioneerWorkItem.findById(claim.workItemId).lean();
    expect(stored).toMatchObject({
      status: "sent",
      delivery: { status: "sent" },
    });
    await expect(
      integration.claimAuctioneerIncoming(
        incoming.cycleKey,
        String(user._id),
        "lotListing"
      )
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "auctioneer_work_item_closed",
    });
  });

  it("keeps a sent Unknown Lot hidden after Auctioneer assigns its created lot ID", async () => {
    const user = await createUser("sent-created-unknown");
    upstream.listContracts.mockResolvedValue([
      {
        id: "contract-1",
        contractNumber: "C-100",
        hasScheduleA: false,
      },
    ]);
    const initialTask: any = assignedTask(String(user._id), "unknown");
    delete initialTask.lot.id;
    upstream.listIncomingTasks.mockResolvedValue([initialTask]);

    const [incoming] = await integration.listAuctioneerIncoming(
      true,
      String(user._id)
    );
    expect(incoming.kind).toBe("unknown");
    const claim = await integration.claimAuctioneerIncoming(
      incoming.cycleKey,
      String(user._id),
      "lotListing"
    );
    await AuctioneerWorkItem.updateOne(
      { _id: claim.workItemId },
      {
        $set: {
          status: "sent",
          "delivery.status": "sent",
          "delivery.completedAt": new Date(),
          "delivery.lots.0.createdLotId": "created-lot-1",
        },
        $unset: { activeContractKey: "" },
      }
    );

    const returnedTask = {
      ...initialTask,
      lot: { ...initialTask.lot, id: "created-lot-1" },
    };
    upstream.listIncomingTasks.mockResolvedValue([returnedTask]);

    await expect(
      integration.listAuctioneerIncoming(true, String(user._id))
    ).resolves.toEqual([]);
    const createdLotCycleKey = createHash("sha256")
      .update("contract-1:lot:created-lot-1")
      .digest("hex");
    await expect(
      integration.claimAuctioneerIncoming(
        createdLotCycleKey,
        String(user._id),
        "lotListing"
      )
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "auctioneer_work_item_closed",
    });
    expect(await AuctioneerWorkItem.exists({ _id: claim.workItemId })).toBeTruthy();
  });

  it("returns Femi's claimed and newly assigned lots as separate cards", async () => {
    const femi = await createUser("femi");
    upstream.listIncomingTasks.mockResolvedValue([
      assignedTask(String(femi._id), "1"),
    ]);
    const [incoming] = await integration.listAuctioneerIncoming(
      false,
      String(femi._id)
    );
    const claim = await integration.claimAuctioneerIncoming(
      incoming.cycleKey,
      String(femi._id),
      "asset"
    );

    upstream.listIncomingTasks.mockResolvedValue([
      assignedTask(String(femi._id), "1"),
      assignedTask(String(femi._id), "2"),
    ]);
    const token = jwt.sign(
      { id: String(femi._id), role: "user" },
      process.env.JWT_SECRET!,
      { expiresIn: "30m" }
    );
    const response = await request(app)
      .get("/api/auctioneer/incoming?refresh=true&userId=forged")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toHaveLength(2);
    const claimed = response.body.data.find(
      (item: any) => item.cycleKey === incoming.cycleKey
    );
    const newlyAssigned = response.body.data.find(
      (item: any) => item.cycleKey !== incoming.cycleKey
    );
    expect(claimed).toMatchObject({
      cycleKey: incoming.cycleKey,
      workItemId: claim.workItemId,
      contractId: "contract-1",
      contractNo: "C-100",
      lotCount: 1,
      pendingLotCount: 0,
      assignedUser: { id: String(femi._id) },
      assignedToCurrentUser: true,
      status: "claimed",
    });
    expect(newlyAssigned).toMatchObject({
      contractId: "contract-1",
      contractNo: "C-100",
      lotCount: 1,
      pendingLotCount: 0,
      assignedUser: { id: String(femi._id) },
      assignedToCurrentUser: true,
      status: "available",
    });
    expect(newlyAssigned).not.toHaveProperty("workItemId");
    expect(upstream.listIncomingTasks).toHaveBeenLastCalledWith(
      String(femi._id),
      undefined
    );

    const stored = await AuctioneerWorkItem.findById(claim.workItemId).lean();
    expect(stored?.snapshot.tasks).toHaveLength(1);
    expect(stored?.snapshot.lots).toHaveLength(1);
  });

  it("deduplicates repeated task identities and rejects anonymous task cycles", async () => {
    const user = await createUser("cycle-identities");
    const firstTask = assignedTask(String(user._id), "1");
    const secondTask = assignedTask(String(user._id), "2");
    secondTask.submission.id = firstTask.submission.id;
    upstream.listIncomingTasks.mockResolvedValue([
      firstTask,
      firstTask,
      secondTask,
    ]);

    const firstRead = await integration.listAuctioneerIncoming(
      true,
      String(user._id)
    );
    expect(firstRead).toHaveLength(2);
    expect(new Set(firstRead.map((item) => item.cycleKey)).size).toBe(2);
    firstRead.forEach((item) => {
      expect(item).toMatchObject({ lotCount: 1, pendingLotCount: 0 });
    });

    upstream.listIncomingTasks.mockResolvedValue([secondTask, firstTask]);
    const reordered = await integration.listAuctioneerIncoming(
      true,
      String(user._id)
    );
    expect(reordered.map((item) => item.cycleKey).sort()).toEqual(
      firstRead.map((item) => item.cycleKey).sort()
    );

    upstream.listIncomingTasks.mockResolvedValue([
      {
        assignedTo: String(user._id),
        contractNumber: "C-100",
        lot: { contractId: "contract-1", eventId: "event-1" },
      },
    ]);
    await expect(
      integration.listAuctioneerIncoming(true, String(user._id))
    ).rejects.toMatchObject({
      statusCode: 502,
      code: "auctioneer2_invalid_response",
    });
  });

  it("supports same-user resume and prevents the same task being reassigned twice", async () => {
    const firstUser = await createUser("original");
    const secondUser = await createUser("reassigned");
    upstream.listIncomingTasks.mockResolvedValue([
      assignedTask(String(firstUser._id)),
    ]);
    const [incoming] = await integration.listAuctioneerIncoming(
      false,
      String(firstUser._id)
    );
    const first = await integration.claimAuctioneerIncoming(
      incoming.cycleKey,
      String(firstUser._id),
      "asset"
    );
    const resumed = await integration.claimAuctioneerIncoming(
      incoming.cycleKey,
      String(firstUser._id),
      "asset"
    );
    expect(resumed.workItemId).toBe(first.workItemId);

    upstream.listIncomingTasks.mockResolvedValue([]);
    await expect(
      integration.claimAuctioneerIncoming(
        incoming.cycleKey,
        String(secondUser._id),
        "asset"
      )
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "auctioneer_incoming_not_found",
    });

    upstream.listIncomingTasks.mockResolvedValue([
      assignedTask(String(secondUser._id)),
    ]);
    const [reassigned] = await integration.listAuctioneerIncoming(
      true,
      String(secondUser._id)
    );
    expect(reassigned.cycleKey).toBe(incoming.cycleKey);
    expect(reassigned).toMatchObject({
      status: "claimed",
      assignedUser: { id: String(secondUser._id) },
      assignedToCurrentUser: true,
    });
    expect(reassigned).not.toHaveProperty("claimedBy");
    expect(reassigned).not.toHaveProperty("workItemId");
    expect(reassigned).not.toHaveProperty("selectedReportType");
    await AuctioneerWorkItem.updateOne(
      { _id: first.workItemId },
      { $set: { status: "report_created" } }
    );
    const [redactedForeign] = await integration.listAuctioneerIncoming(
      true,
      String(secondUser._id)
    );
    expect(redactedForeign.status).toBe("claimed");
    expect(redactedForeign).not.toHaveProperty("claimedBy");
    expect(redactedForeign).not.toHaveProperty("workItemId");
    expect(redactedForeign).not.toHaveProperty("selectedReportType");

    await AuctioneerWorkItem.updateOne(
      { _id: first.workItemId },
      {
        $set: { status: "sent", "delivery.status": "sent" },
        $unset: { activeContractKey: "" },
      }
    );
    await expect(
      integration.listAuctioneerIncoming(true, String(secondUser._id))
    ).resolves.toEqual([]);
    await expect(
      integration.claimAuctioneerIncoming(
        reassigned.cycleKey,
        String(secondUser._id),
        "asset"
      )
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "auctioneer_already_claimed",
    });
    expect(await AuctioneerWorkItem.countDocuments()).toBe(1);
  });

  it("releases only an owner's pre-report claim and rebuilds from current assignments", async () => {
    const owner = await createUser("owner");
    const other = await createUser("other");
    upstream.listIncomingTasks.mockResolvedValue([
      assignedTask(String(owner._id), "1"),
    ]);
    const [incoming] = await integration.listAuctioneerIncoming(
      false,
      String(owner._id)
    );
    const claim = await integration.claimAuctioneerIncoming(
      incoming.cycleKey,
      String(owner._id),
      "lotListing"
    );

    await expect(
      integration.releaseAuctioneerClaim(claim.workItemId, String(other._id))
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      integration.releaseAuctioneerClaim(claim.workItemId, String(owner._id))
    ).resolves.toMatchObject({ released: true });

    upstream.listIncomingTasks.mockResolvedValue([
      assignedTask(String(owner._id), "1"),
      assignedTask(String(owner._id), "2"),
    ]);
    const rebuilt = await integration.listAuctioneerIncoming(
      true,
      String(owner._id)
    );
    expect(rebuilt).toHaveLength(2);
    expect(new Set(rebuilt.map((item) => item.cycleKey)).size).toBe(2);
    rebuilt.forEach((item) => {
      expect(item).toMatchObject({
        lotCount: 1,
        pendingLotCount: 0,
        status: "available",
      });
    });
    const firstLot = rebuilt.find(
      (item) => item.cycleKey === incoming.cycleKey
    );
    const secondLot = rebuilt.find(
      (item) => item.cycleKey !== incoming.cycleKey
    );
    expect(firstLot?.cycleKey).toBe(incoming.cycleKey);
    expect(secondLot).toBeDefined();

    const reclaimed = await integration.claimAuctioneerIncoming(
      firstLot!.cycleKey,
      String(owner._id),
      "lotListing"
    );
    const secondClaim = await integration.claimAuctioneerIncoming(
      secondLot!.cycleKey,
      String(owner._id),
      "lotListing"
    );
    await integration.linkAuctioneerWorkItemToReport({
      workItemId: reclaimed.workItemId,
      userId: String(owner._id),
      reportType: "lotListing",
      reportId: new mongoose.Types.ObjectId().toString(),
    });
    await expect(
      integration.releaseAuctioneerClaim(reclaimed.workItemId, String(owner._id))
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "auctioneer_claim_locked",
    });
    await expect(
      integration.releaseAuctioneerClaim(
        secondClaim.workItemId,
        String(owner._id)
      )
    ).resolves.toMatchObject({ released: true });
    expect(
      await AuctioneerWorkItem.exists({ _id: reclaimed.workItemId })
    ).toBeTruthy();
    expect(
      await AuctioneerWorkItem.exists({ _id: secondClaim.workItemId })
    ).toBeNull();
  });
});
