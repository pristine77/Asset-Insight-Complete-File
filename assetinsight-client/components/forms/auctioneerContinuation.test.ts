import { describe, expect, it } from "vitest";
import type { AuctioneerWorkItemSetup } from "@/services/auctioneer";
import { acceptedAuctioneerReportId, auctioneerSuccessorState } from "./auctioneerContinuation";

const previous: AuctioneerWorkItemSetup = {
  workItemId: "work-1",
  cycleKey: "cycle-1",
  kind: "scheduleA",
  reportType: "asset",
  clientSubmissionId: "submission-1",
  contract: {
    id: "contract-1",
    contractNo: "12345",
    customerName: "Imported customer",
    eventTitle: "Imported auction",
    location: "Regina",
  },
  lots: [{ sourceKey: "source-1", lotId: "locked-lot", submissionId: "locked-submission" }],
};

const next: AuctioneerWorkItemSetup = {
  ...previous,
  workItemId: "work-2",
  clientSubmissionId: "submission-2",
  status: "claimed",
  kind: "unknown",
  lots: [],
};

describe("Auctioneer continuation safety", () => {
  it("accepts a fresh same-type server identity with contract-only metadata", () => {
    expect(auctioneerSuccessorState(previous, next)).toBe("fresh");
    expect(auctioneerSuccessorState(
      { ...previous, reportType: "lotListing" },
      { ...next, reportType: "lotListing" }
    )).toBe("fresh");
  });

  it.each([
    { workItemId: "" },
    { contract: { ...previous.contract, id: "" } },
    { contract: { ...previous.contract, contractNo: "" } },
    { workItemId: "work-1" },
    { clientSubmissionId: "submission-1" },
    { clientSubmissionId: undefined },
    { status: undefined },
    { status: "available" as const },
    { status: "abandoned" as const },
    { kind: "scheduleA" as const },
    { lots: previous.lots },
    { reportType: "lotListing" as const },
    { contract: { ...previous.contract, id: "other-contract" } },
    { contract: { ...previous.contract, contractNo: "99999" } },
  ])("rejects unsafe successor fields %j", (change) => {
    expect(auctioneerSuccessorState(previous, { ...next, ...change })).toBe("invalid");
  });

  it.each([
    { reportId: "already-created" },
    { status: "report_created" as const },
    { status: "sent" as const },
  ])("does not reopen an already-used successor %j", (change) => {
    expect(auctioneerSuccessorState(previous, { ...next, ...change })).toBe("used");
  });

  it("requires the accepted create receipt's actual report ID, never job or draft IDs", () => {
    expect(acceptedAuctioneerReportId({ reportId: " accepted-1 " })).toBe("accepted-1");
    for (const response of [null, {}, { reportId: 123 }, { reportId: " " }, { jobId: "job-1" }, { data: { reportId: "nested-1" } }]) {
      expect(acceptedAuctioneerReportId(response)).toBeUndefined();
    }
  });
});
