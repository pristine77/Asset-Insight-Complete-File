import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const emailMocks = vi.hoisted(() => ({
  approval: vi.fn(),
  release: vi.fn(),
}));

vi.mock("../src/service/approvalAssignmentService.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/service/approvalAssignmentService.js")
  >()),
  sendAssignedApprovalEmail: emailMocks.approval,
}));

vi.mock("../src/service/reportReleaseService.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/service/reportReleaseService.js")
  >()),
  sendAssignedReleaseEmail: emailMocks.release,
}));

let mongo: MongoMemoryServer;
let AssetReport: typeof import("../src/models/asset.model.js")["default"];
let LotListing: typeof import("../src/models/lotListing.model.js")["default"];
let sendClaimedAssignmentEmail: typeof import("../src/service/assignmentEmailClaimService.js")["sendClaimedAssignmentEmail"];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: AssetReport } = await import("../src/models/asset.model.js"));
  ({ default: LotListing } = await import("../src/models/lotListing.model.js"));
  ({ sendClaimedAssignmentEmail } = await import(
    "../src/service/assignmentEmailClaimService.js"
  ));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  emailMocks.approval.mockReset();
  emailMocks.release.mockReset();
  emailMocks.approval.mockImplementation(async (report: any) => {
    report.approval_assignment_email_sent_at = new Date();
    return true;
  });
  emailMocks.release.mockImplementation(async (report: any) => {
    report.release_assignment_email_sent_at = new Date();
    return true;
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe.sequential("generation-scoped assignment email claims", () => {
  it("sends an Asset approval assignment only after done-state publication and only once", async () => {
    const generationToken = "asset-files-generation-1";
    const executionToken = "asset-files-attempt-1";
    const report = await AssetReport.create({
      user: new mongoose.Types.ObjectId(),
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "pending_approval",
      approval_assigned_to: new mongoose.Types.ObjectId(),
      job_id: generationToken,
      job_execution_token: executionToken,
      job_status: "processing",
    });
    const input = {
      model: AssetReport,
      reportId: report._id,
      kind: "approval" as const,
      generationToken,
      ownershipFilter: {
        job_id: generationToken,
        job_execution_token: executionToken,
        job_status: "done",
      },
      stateFilter: { status: "pending_approval" },
      reportType: "Asset",
    };

    await expect(sendClaimedAssignmentEmail(input)).resolves.toBe(false);
    expect(emailMocks.approval).not.toHaveBeenCalled();

    await AssetReport.updateOne(
      { _id: report._id },
      { $set: { job_status: "done" } },
    );
    const results = await Promise.all([
      sendClaimedAssignmentEmail(input),
      sendClaimedAssignmentEmail(input),
    ]);

    expect(results.sort()).toEqual([false, true]);
    expect(emailMocks.approval).toHaveBeenCalledTimes(1);
    const persisted: any = await AssetReport.findById(report._id)
      .select("+approval_assignment_email_claim_token")
      .lean();
    expect(persisted.approval_assignment_email_sent_at).toBeInstanceOf(Date);
    expect(persisted.approval_assignment_email_claim_token).toBe(
      `approval:${generationToken}`,
    );
  });

  it("retains an ambiguous failed delivery claim so the same generation cannot duplicate mail", async () => {
    emailMocks.approval.mockResolvedValue(false);
    const generationToken = "asset-files-ambiguous-email";
    const executionToken = "asset-files-ambiguous-attempt";
    const report = await AssetReport.create({
      user: new mongoose.Types.ObjectId(),
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "pending_approval",
      approval_assigned_to: new mongoose.Types.ObjectId(),
      job_id: generationToken,
      job_execution_token: executionToken,
      job_status: "done",
    });
    const input = {
      model: AssetReport,
      reportId: report._id,
      kind: "approval" as const,
      generationToken,
      ownershipFilter: {
        job_id: generationToken,
        job_execution_token: executionToken,
        job_status: "done",
      },
      stateFilter: { status: "pending_approval" },
      reportType: "Asset",
    };

    await expect(sendClaimedAssignmentEmail(input)).resolves.toBe(false);
    await expect(sendClaimedAssignmentEmail(input)).resolves.toBe(false);
    expect(emailMocks.approval).toHaveBeenCalledTimes(1);
    const persisted: any = await AssetReport.findById(report._id)
      .select("+approval_assignment_email_claim_token")
      .lean();
    expect(persisted.approval_assignment_email_sent_at).toBeNull();
    expect(persisted.approval_assignment_email_claim_token).toBe(
      `approval:${generationToken}`,
    );
  });

  it("applies the same publication and ownership fence to Lot Listing assignment mail", async () => {
    const generationToken = "lot-files-generation-1";
    const executionToken = "lot-files-attempt-1";
    const listing = await LotListing.create({
      user: new mongoose.Types.ObjectId(),
      contract_no: "LOT-EMAIL-CLAIM-100",
      location: "Regina",
      sales_date: new Date(),
      imageUrls: [],
      lots: [],
      status: "pending_approval",
      approval_assigned_to: new mongoose.Types.ObjectId(),
      job_id: generationToken,
      job_execution_token: executionToken,
      job_status: "done",
    });
    const input = {
      model: LotListing,
      reportId: listing._id,
      kind: "approval" as const,
      generationToken,
      ownershipFilter: {
        job_id: generationToken,
        job_execution_token: executionToken,
        job_status: "done",
      },
      stateFilter: { status: "pending_approval" },
      reportType: "Lot Listing",
    };

    const results = await Promise.all([
      sendClaimedAssignmentEmail(input),
      sendClaimedAssignmentEmail(input),
    ]);

    expect(results.sort()).toEqual([false, true]);
    expect(emailMocks.release).not.toHaveBeenCalled();
    expect(emailMocks.approval).toHaveBeenCalledTimes(1);
    const persisted: any = await LotListing.findById(listing._id)
      .select("+approval_assignment_email_claim_token")
      .lean();
    expect(persisted.approval_assignment_email_sent_at).toBeInstanceOf(Date);
    expect(persisted.approval_assignment_email_claim_token).toBe(
      `approval:${generationToken}`,
    );
  });
});
