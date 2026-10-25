import { describe, expect, it } from "vitest";
import {
  applyCanonicalAuctioneerDetails,
  AuctioneerReportContextError,
} from "../src/service/auctioneerReportLinkService.js";

function workItem(kind: "scheduleA" | "unknown") {
  return {
    _id: "68a12c24f3c7f07935f6d111",
    kind,
    selectedReportType: "asset",
    clientSubmissionId: "auctioneer2-deterministic",
    contract: {
      id: "contract-1",
      contractNo: "C-100",
      eventDate: "2026-08-12",
    },
    snapshot: {
      lots: [
        {
          sourceKey: "opaque-source-1",
          lotId: kind === "scheduleA" ? "lot-1" : undefined,
          submissionId:
            kind === "scheduleA" ? "submission-1" : undefined,
        },
      ],
    },
  } as any;
}

describe("Auctioneer 2.0 report submission authority", () => {
  it("preserves a split identity while binding its parent to the canonical source", () => {
    const details = { mixed_lots: [
      { count: 2, source_key: "opaque-source-1" },
      { count: 3, source_key: "split-1", source_parent_key: "opaque-source-1" },
    ] };
    applyCanonicalAuctioneerDetails(details, workItem("scheduleA"));
    expect(details.mixed_lots[1]).toMatchObject({
      source_key: "split-1", source_parent_key: "opaque-source-1",
      source_lot_id: "lot-1", source_submission_id: "submission-1", mode: "single_lot",
    });
  });
  it("canonicalizes the locked Schedule A mapping", () => {
    const details = {
      contract_no: "forged",
      effective_date: "2030-01-01",
      mixed_lots: [
        {
          count: 2,
          mode: "per_photo",
          source_key: "opaque-source-1",
          source_lot_id: "lot-1",
          source_submission_id: "submission-1",
        },
      ],
    };

    applyCanonicalAuctioneerDetails(details, workItem("scheduleA"));

    expect(details).toMatchObject({
      contract_no: "C-100",
      effective_date: "2026-08-12",
      client_submission_id: "auctioneer2-deterministic",
      mixed_lots: [
        {
          count: 2,
          mode: "single_lot",
          source_key: "opaque-source-1",
          source_lot_id: "lot-1",
          source_submission_id: "submission-1",
        },
      ],
    });
  });

  it("rejects a forged Schedule A source mapping", () => {
    expect(() =>
      applyCanonicalAuctioneerDetails(
        {
          mixed_lots: [
            {
              count: 1,
              mode: "single_lot",
              source_key: "different-source",
            },
          ],
        },
        workItem("scheduleA")
      )
    ).toThrow(AuctioneerReportContextError);
  });

  it("replaces forged Unknown Lot source identifiers with server keys", () => {
    const details = {
      mixed_lots: [
        {
          count: 1,
          mode: "single_lot",
          source_key: "forged",
          source_parent_key: "forged-parent",
          source_lot_id: "forged-lot",
          source_submission_id: "forged-submission",
        },
        {
          count: 1,
          mode: "single_lot",
          source_key: "also-forged",
        },
      ],
    };

    applyCanonicalAuctioneerDetails(details, workItem("unknown"));

    expect(details.mixed_lots).toEqual([
      {
        count: 1,
        mode: "single_lot",
        source_key: "opaque-source-1",
      },
      {
        count: 1,
        mode: "single_lot",
        source_key: "68a12c24f3c7f07935f6d111:unknown:2",
      },
    ]);
  });
});
