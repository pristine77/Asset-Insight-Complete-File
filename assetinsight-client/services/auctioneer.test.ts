import { beforeEach, describe, expect, it, vi } from "vitest";
import API from "@/lib/api";
import { AuctioneerService, auctioneerReopenErrorMessage } from "./auctioneer";

vi.mock("@/lib/api", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

const contactPayloads = [
  {
    source: "root camelCase",
    fields: { consignorName: "  Northfield Consignor  ", salespersonName: "  Sam Sales  " },
  },
  {
    source: "root snake_case",
    fields: { consignor_name: "  Northfield Consignor  ", salesperson_name: "  Sam Sales  " },
  },
  {
    source: "contract camelCase",
    fields: { contract: { consignorName: "  Northfield Consignor  ", salespersonName: "  Sam Sales  " } },
  },
  {
    source: "contract snake_case",
    fields: { contract: { consignor_name: "  Northfield Consignor  ", salesperson_name: "  Sam Sales  " } },
  },
];

describe("AuctioneerService incoming", () => {
  beforeEach(() => {
    vi.mocked(API.get).mockReset();
    vi.mocked(API.post).mockReset();
  });

  it("keeps every normalized proposal row from the backend items contract", async () => {
    vi.mocked(API.get).mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          items: [
            {
              cycleKey: "proposal:825291",
              contractId: "contract-825291",
              contractNo: 825291,
              customerName: "Proposal customer one",
              eventTitle: "ProposalInAssetInsight",
              location: "London",
              kind: "unknown",
              lotCount: 0,
              status: "available",
            },
            {
              cycleKey: "proposal:825295",
              contractId: "contract-825295",
              contractNo: 825295,
              customerName: "Proposal customer two",
              eventTitle: "ProposalInAssetInsight",
              location: "Manchester",
              kind: "scheduleA",
              lotCount: 3,
              status: "available",
            },
          ],
        },
      },
    });

    const items = await AuctioneerService.getIncoming();

    expect(items.map((item) => item.contractNo)).toEqual([
      "825291",
      "825295",
    ]);
    expect(items.map((item) => item.kind)).toEqual(["unknown", "scheduleA"]);
    expect(API.get).toHaveBeenCalledWith("/auctioneer/incoming", {});
    expect(vi.mocked(API.get).mock.calls[0]?.[1]).not.toHaveProperty(
      "params.userId"
    );
  });

  it.each(contactPayloads)("keeps distinct, trimmed incoming contact names from $source", async ({ fields }) => {
    vi.mocked(API.get).mockResolvedValueOnce({
      data: { data: { items: [{
        cycleKey: "cycle-1",
        contractId: "contract-1",
        customerName: "Independent Customer",
        claimedBy: { username: "Assigned Appraiser" },
        ...fields,
      }] } },
    });

    const [item] = await AuctioneerService.getIncoming();

    expect(item).toMatchObject({
      customerName: "Independent Customer",
      consignorName: "Northfield Consignor",
      salespersonName: "Sam Sales",
      claimedBy: { username: "Assigned Appraiser" },
    });
  });

  it("keeps missing or malformed incoming contacts unknown without inferring other roles", async () => {
    const malformed = [undefined, null, "", " \t ", 42, false, ["Wrong Person"], { name: "Wrong Person" }];
    vi.mocked(API.get).mockResolvedValueOnce({
      data: { data: { items: malformed.map((value, index) => ({
        cycleKey: `cycle-${index}`,
        contractId: `contract-${index}`,
        customerName: "Customer is not consignor",
        claimedBy: { username: "Claimant is not salesperson" },
        salesperson: { name: "Unmapped salesperson object" },
        consignor: { name: "Unmapped consignor object" },
        consignorName: value,
        consignor_name: value,
        salespersonName: value,
        salesperson_name: value,
        contract: {
          consignorName: value,
          consignor_name: value,
          salespersonName: value,
          salesperson_name: value,
          customer: { name: "Another customer" },
        },
      })) } },
    });

    const items = await AuctioneerService.getIncoming();

    expect(items).toHaveLength(malformed.length);
    for (const item of items) {
      expect(item.consignorName).toBeUndefined();
      expect(item.salespersonName).toBeUndefined();
      expect(item.customerName).toBe("Customer is not consignor");
    }
  });

  it.each(["root", "contract", "contractSnapshot"])("preserves the complete incoming description from %s", async (source) => {
    const description = `Equipment <img src=x> ${"A".repeat(5000)}`;
    const fields = source === "root" ? { description: `  ${description}  ` } : { [source]: { description: `  ${description}  ` } };
    vi.mocked(API.get).mockResolvedValueOnce({ data: { data: { items: [{ cycleKey: "cycle-1", contractId: "contract-1", ...fields }] } } });

    const [item] = await AuctioneerService.getIncoming();

    expect(item.description).toBe(description);
  });

  it("keeps missing and malformed descriptions unknown rather than borrowing customer or lot text", async () => {
    const malformed = [undefined, null, "", " \t ", 42, false, ["Wrong description"], { text: "Wrong description" }];
    vi.mocked(API.get).mockResolvedValueOnce({ data: { data: { items: malformed.map((description, index) => ({
      cycleKey: `description-${index}`, contractId: `contract-${index}`, description,
      customerName: "Independent customer", contract: { description }, lots: [{ description: "Lot description" }],
    })) } } });

    const items = await AuctioneerService.getIncoming();

    expect(items).toHaveLength(malformed.length);
    items.forEach((item) => expect(item.description).toBeUndefined());
  });

  describe.each(["getSetup", "claim", "continueWorkItem"] as const)("%s contract metadata", (operation) => {
    async function readSetup(fields: Record<string, unknown>) {
      const response = {
        data: { data: {
          workItemId: "work-1",
          contractId: "contract-1",
          contractNo: "CV-100",
          customerName: "Independent Customer",
          claimedBy: { username: "Assigned Appraiser" },
          ...fields,
        } },
      };
      if (operation === "getSetup") {
        vi.mocked(API.get).mockResolvedValueOnce(response);
        return AuctioneerService.getSetup("work-1");
      }
      vi.mocked(API.post).mockResolvedValueOnce(response);
      return operation === "claim"
        ? AuctioneerService.claim("cycle-1", "asset")
        : AuctioneerService.continueWorkItem("work-1", "report-accepted");
    }

    it.each(contactPayloads)("preserves trimmed contact names from $source", async ({ fields }) => {
      const setup = await readSetup(fields);

      expect(setup.contract).toMatchObject({
        customerName: "Independent Customer",
        consignorName: "Northfield Consignor",
        salespersonName: "Sam Sales",
      });
    });

    it.each(["root", "contract", "snapshot"])("preserves the complete description from %s", async (source) => {
      const description = `Farm equipment <b>plain text</b> ${"B".repeat(5000)}`;
      const contract = { description: `  ${description}  ` };
      const fields = source === "root" ? contract : source === "contract" ? { contract } : { snapshot: { contract } };

      const setup = await readSetup(fields);

      expect(setup.contract.description).toBe(description);
      expect(setup.lots).toEqual([]);
    });

    it("does not stringify malformed or infer absent descriptions", async () => {
      for (const description of [undefined, null, "", " \t ", 42, false, ["Wrong description"], { text: "Wrong description" }]) {
        const setup = await readSetup({ description, contract: { description }, customerName: "Independent customer" });
        expect(setup.contract.description).toBeUndefined();
      }
    });

    it("does not infer missing contacts or stringify malformed canonical values", async () => {
      for (const fields of [{}, {
        consignorName: { name: "Wrong Consignor" },
        consignor_name: 42,
        salespersonName: ["Wrong Salesperson"],
        salesperson_name: false,
        contract: { consignorName: null, consignor_name: "  ", salespersonName: {}, salesperson_name: "" },
        consignor: { name: "Unmapped consignor object" },
        salesperson: { name: "Unmapped salesperson object" },
      }]) {
        const setup = await readSetup(fields);

        expect(setup.contract.consignorName).toBeUndefined();
        expect(setup.contract.salespersonName).toBeUndefined();
        expect(setup.contract.customerName).toBe("Independent Customer");
      }
    });
  });

  it.each([
    { fields: { status: "reportCreated", reportId: "report-1" }, status: "report_created" },
    { fields: { state: "in_progress", report_id: "report-1" }, status: "claimed" },
  ])("normalizes setup status and report identity from $fields", async ({ fields, status }) => {
    vi.mocked(API.get).mockResolvedValueOnce({
      data: { success: true, data: { workItemId: "work-1", ...fields } },
    });

    const setup = await AuctioneerService.getSetup("work-1");

    expect(setup).toMatchObject({ workItemId: "work-1", status, reportId: "report-1" });
  });

  it("keeps absent setup status and report identity unknown", async () => {
    vi.mocked(API.get).mockResolvedValueOnce({
      data: { success: true, data: { workItemId: "work-1" } },
    });

    const setup = await AuctioneerService.getSetup("work-1");

    expect(setup.status).toBeUndefined();
    expect(setup.reportId).toBeUndefined();
  });

  it.each([true, false, undefined, "true"])("trusts only a boolean upload-resume capability: %j", async (canResumeUpload) => {
    vi.mocked(API.get).mockResolvedValueOnce({ data: { data: { workItemId: "work-1", canResumeUpload } } });
    const setup = await AuctioneerService.getSetup("work-1");
    expect(setup.canResumeUpload).toBe(typeof canResumeUpload === "boolean" ? canResumeUpload : undefined);
  });

  it("continues the exact work item and accepted report with the normalized server setup", async () => {
    vi.mocked(API.post).mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          work_item_id: "work-next",
          cycle_key: "cycle-1",
          kind: "unknown",
          report_type: "lot_listing",
          client_submission_id: "submission-next",
          status: "claimed",
          contract: {
            id: "contract-1",
            contract_no: "CTR-100",
            customer_name: "Example Customer",
            location: "London",
          },
          lots: [],
        },
      },
    });

    const setup = await AuctioneerService.continueWorkItem("work/1 ?", "report-accepted");

    expect(API.post).toHaveBeenCalledExactlyOnceWith(
      "/auctioneer/work-items/work%2F1%20%3F/continue",
      { reportId: "report-accepted" }
    );
    expect(setup).toMatchObject({
      workItemId: "work-next",
      cycleKey: "cycle-1",
      kind: "unknown",
      reportType: "lotListing",
      clientSubmissionId: "submission-next",
      status: "claimed",
      contract: { id: "contract-1", contractNo: "CTR-100", customerName: "Example Customer" },
      lots: [],
    });
    expect(API.get).not.toHaveBeenCalled();
  });

  it("repeats continuation with the same work item and accepted report identity", async () => {
    vi.mocked(API.post).mockResolvedValue({
      data: {
        success: true,
        data: {
          workItemId: "work-next",
          clientSubmissionId: "submission-next",
          status: "claimed",
        },
      },
    });

    const first = await AuctioneerService.continueWorkItem("work-1", "report-accepted");
    const retry = await AuctioneerService.continueWorkItem("work-1", "report-accepted");

    expect(API.post).toHaveBeenCalledTimes(2);
    expect(vi.mocked(API.post).mock.calls).toEqual([
      ["/auctioneer/work-items/work-1/continue", { reportId: "report-accepted" }],
      ["/auctioneer/work-items/work-1/continue", { reportId: "report-accepted" }],
    ]);
    expect(retry).toEqual(first);
    expect(retry.clientSubmissionId).toBe("submission-next");
  });

  it("propagates continuation failure without retrying or fetching another setup", async () => {
    const failure = {
      response: { status: 409, data: { code: "REPORT_NOT_ACCEPTED", message: "Report is not accepted." } },
    };
    vi.mocked(API.post).mockRejectedValueOnce(failure);

    await expect(
      AuctioneerService.continueWorkItem("work-1", "report-accepted")
    ).rejects.toBe(failure);

    expect(API.post).toHaveBeenCalledExactlyOnceWith(
      "/auctioneer/work-items/work-1/continue",
      { reportId: "report-accepted" }
    );
    expect(API.get).not.toHaveBeenCalled();
  });
});

/*
   Assigned users close their OWN part of a contract; Auctioneer completes it
   once every assigned person has closed theirs (owner, 2026-10-02).
*/
describe("AuctioneerService contract close", () => {
  beforeEach(() => {
    vi.mocked(API.get).mockReset();
    vi.mocked(API.post).mockReset();
  });

  it("keeps the delivery's contract, close scope and close outcome", async () => {
    vi.mocked(API.get).mockResolvedValueOnce({
      data: {
        success: true,
        data: [
          {
            workItemId: "work-1",
            contractId: "contract-1",
            contractNo: "C-1",
            state: "sent",
            canCompleteContract: true,
            contractCompletionScope: "user",
            completeContract: true,
            contractClosedAt: "2026-10-02T12:00:00.000Z",
            contractTaskCompleted: false,
          },
          { workItemId: "work-2", state: "ready", contractCompletionScope: "everyone", contractTaskCompleted: "yes" },
        ],
      },
    });

    const [closed, unknown] = await AuctioneerService.getDeliveries();

    expect(closed).toMatchObject({
      contractId: "contract-1",
      contractCompletionScope: "user",
      completeContract: true,
      contractClosedAt: "2026-10-02T12:00:00.000Z",
      contractTaskCompleted: false,
    });
    // Unknown scopes and malformed flags read as unknown, never as a close.
    expect(unknown.contractCompletionScope).toBeUndefined();
    expect(unknown.contractTaskCompleted).toBeUndefined();
    expect(unknown.contractClosedAt).toBeUndefined();
    expect(unknown.contractId).toBeUndefined();
  });

  it("closes the signed-in user's part without sending who they are", async () => {
    vi.mocked(API.post).mockResolvedValueOnce({
      data: {
        success: true,
        data: {
          contractId: "contract/1",
          contractNo: "C-1",
          closedAt: "2026-10-02T12:00:00.000Z",
          taskCompleted: true,
          alreadyCompleted: false,
          userStatus: "completed",
        },
      },
    });

    await expect(AuctioneerService.closeContractPart("contract/1")).resolves.toEqual({
      contractId: "contract/1",
      contractNo: "C-1",
      closedAt: "2026-10-02T12:00:00.000Z",
      taskCompleted: true,
      alreadyCompleted: false,
      userStatus: "completed",
    });
    expect(API.post).toHaveBeenCalledExactlyOnceWith(
      "/auctioneer/contracts/contract%2F1/close-my-part",
      {},
      { _retry: true, timeout: 30_000 }
    );
  });

  it.each([0, "reopened-epoch-2"])("closes with the exact saved access revision: %s", async (revision) => {
    vi.mocked(API.post).mockResolvedValueOnce({ data: { success: true, data: {
      contractId: "contract-1", closedAt: "2026-10-03T12:00:00.000Z",
      taskCompleted: false, alreadyCompleted: false, userStatus: "completed",
    } } });
    await AuctioneerService.closeContractPart("contract-1", revision);
    expect(API.post).toHaveBeenCalledExactlyOnceWith("/auctioneer/contracts/contract-1/close-my-part",
      { accessRevision: revision }, { _retry: true, timeout: 30_000 });
  });

  it.each([undefined, "old-revision"])("preserves a capture-epoch refusal for close revision %s", async (revision) => {
    const refusal = { response: { status: 409, data: { code: "auctioneer_contract_capture_changed" } } };
    vi.mocked(API.post).mockRejectedValueOnce(refusal);
    await expect(AuctioneerService.closeContractPart("contract-1", revision)).rejects.toBe(refusal);
    expect(API.post).toHaveBeenCalledTimes(1);
  });

  it("reads the actual delivery epoch without borrowing a current contract revision", async () => {
    vi.mocked(API.get).mockResolvedValueOnce({ data: { data: { items: [
      { workItemId: "old", state: "sent", contract: { accessRevision: "new-contract-revision" } },
      { workItemId: "new", state: "sent", accessRevision: "saved-revision" },
    ] } } });
    const deliveries = await AuctioneerService.getDeliveries();
    expect(deliveries[0].accessRevision).toBeUndefined();
    expect(deliveries[1].accessRevision).toBe("saved-revision");
  });

  it("keeps optional reopen metadata without treating malformed values as permission", async () => {
    vi.mocked(API.get).mockResolvedValueOnce({ data: { data: { items: [
      { contractId: "c-1", reopenUntil: "2026-10-27T15:00:00.000Z", eventTime: "09:00", eventClosed: false, accessRevision: 0 },
      { contractId: "c-2", reopenUntil: {}, eventTime: [], eventClosed: "false", accessRevision: {} },
    ] } } });
    const [valid, malformed] = await AuctioneerService.getIncoming();
    expect(valid).toMatchObject({ reopenUntil: "2026-10-27T15:00:00.000Z", eventTime: "09:00", eventClosed: false, accessRevision: 0 });
    expect(malformed).toMatchObject({ reopenUntil: undefined, eventTime: undefined, eventClosed: undefined, accessRevision: undefined });
    expect(valid).not.toHaveProperty("reopen");
  });

  it("reads fresh capture permission without trusting or sending a client user", async () => {
    vi.mocked(API.get).mockResolvedValueOnce({ data: { success: true, data: {
      reopen: { allowed: true, reason: null, reopenUntil: "2026-10-27T15:00:00.000Z" }, accessRevision: "revision-2",
    } } });
    await expect(AuctioneerService.getCapturePermission("contract/1")).resolves.toMatchObject({
      reopen: { allowed: true, reason: null, reopenUntil: "2026-10-27T15:00:00.000Z" }, accessRevision: "revision-2",
    });
    expect(API.get).toHaveBeenCalledExactlyOnceWith("/auctioneer/contracts/contract%2F1/capture-permission");
  });

  it("retains a durable pending reopen check independently of allowed", async () => {
    vi.mocked(API.get).mockResolvedValueOnce({ data: { success: true, data: {
      confirmationPending: true, reopen: { allowed: false, reason: null, reopenUntil: null },
    } } });
    await expect(AuctioneerService.getCapturePermission("contract-1")).resolves.toMatchObject({
      confirmationPending: true, reopen: { allowed: false, reopenUntil: null },
    });
  });

  it.each([
    { success: false, data: { reopen: { allowed: true } } },
    { success: true, data: { reopen: { allowed: "true" } } },
    { success: true, data: { contractId: "other", reopen: { allowed: true } } },
    { success: true, data: {} },
  ])("rejects malformed or mismatched permission: %j", async (data) => {
    vi.mocked(API.get).mockResolvedValueOnce({ data });
    await expect(AuctioneerService.getCapturePermission("contract-1")).rejects.toThrow("permission could not be confirmed");
  });

  it.each([
    { reopened: true, alreadyOpen: false, accessRevision: 0 },
    { reopened: false, alreadyOpen: true, accessRevision: "new-revision" },
  ])("accepts exact reopen receipts and suppresses authentication replay: %j", async (outcome) => {
    vi.mocked(API.post).mockResolvedValueOnce({ data: { success: true, data: { contractId: "contract/1", ...outcome } } });
    await expect(AuctioneerService.reopenContractPart("contract/1")).resolves.toEqual({ contractId: "contract/1", ...outcome });
    expect(API.post).toHaveBeenCalledExactlyOnceWith("/auctioneer/contracts/contract%2F1/reopen", {}, { _retry: true, timeout: 30_000 });
  });

  it.each([
    { contractId: "other" }, { reopened: false }, { alreadyOpen: true },
    { accessRevision: undefined }, { accessRevision: "" }, { accessRevision: {} },
    { reopened: "true" },
  ])("rejects unrelated or incomplete reopen receipts: %j", async (overrides) => {
    vi.mocked(API.post).mockResolvedValueOnce({ data: { success: true, data: {
      contractId: "contract-1", reopened: true, alreadyOpen: false, accessRevision: 2, ...overrides,
    } } });
    await expect(AuctioneerService.reopenContractPart("contract-1")).rejects.toThrow("Re-opening was not confirmed");
    expect(API.post).toHaveBeenCalledTimes(1);
  });

  it("never presents raw reopen transport errors or an unknown server code", () => {
    for (const error of [
      new Error("Request failed with status code 409 at http://127.0.0.1/private"),
      { response: { status: 409, data: { code: "UNKNOWN", message: "http://localhost/private" } } },
      { response: { status: 409, data: { code: "toString" } } },
      { response: { data: { message: { secret: "hidden" } } } },
    ]) {
      expect(auctioneerReopenErrorMessage(error)).toBe("Re-opening was not confirmed. Refresh Incoming to check this contract before trying again. Your existing reports are unchanged.");
    }
  });

  it("rejects a missing outcome and propagates a refusal unchanged", async () => {
    vi.mocked(API.post).mockResolvedValueOnce({ data: { success: true, data: {} } });
    await expect(AuctioneerService.closeContractPart("contract-1")).rejects.toThrow("Contract completion was not confirmed");

    const refusal = { response: { status: 404, data: { code: "auctioneer_contract_assignment_not_found" } } };
    vi.mocked(API.post).mockRejectedValueOnce(refusal);
    await expect(AuctioneerService.closeContractPart("contract-2")).rejects.toBe(refusal);
  });

  it.each([
    { contractId: "another-contract" }, { closedAt: "invalid" }, { closedAt: undefined },
    { taskCompleted: "true" }, { alreadyCompleted: undefined },
    { userStatus: "active" }, { userStatus: null },
  ])("rejects incomplete or unrelated close receipts: %j", async (overrides) => {
    vi.mocked(API.post).mockResolvedValueOnce({ data: { success: true, data: {
      contractId: "contract-1", closedAt: "2026-10-03T12:00:00.000Z",
      taskCompleted: false, alreadyCompleted: false, userStatus: "completed", ...overrides,
    } } });
    await expect(AuctioneerService.closeContractPart("contract-1")).rejects.toThrow("Contract completion was not confirmed");
    expect(API.post).toHaveBeenCalledTimes(1);
  });

  it.each([
    { taskCompleted: false, userStatus: "revoked" },
    { taskCompleted: true, userStatus: null },
  ])("accepts confirmed revoked or whole-contract outcomes: %j", async (outcome) => {
    vi.mocked(API.post).mockResolvedValueOnce({ data: { success: true, data: {
      contractId: "contract-1", closedAt: "2026-10-03T12:00:00.000Z", alreadyCompleted: false, ...outcome,
    } } });
    await expect(AuctioneerService.closeContractPart("contract-1")).resolves.toMatchObject(outcome);
  });
});
