import { describe, expect, it, vi } from "vitest";

// The integration service's import graph builds the email client at load time.
vi.hoisted(() => { process.env.RESEND_API_KEY ||= "re_schedule_a_item_test_only"; });

import {
  applyCanonicalAuctioneerDetails,
  AuctioneerReportContextError,
  restoreScheduleAItemLinks,
} from "../src/service/auctioneerReportLinkService.js";
import {
  inheritScheduleAItemLinks,
  lotsMissingScheduleAItem,
  requiresScheduleAItem,
  scheduleAChoicesFromItems,
} from "../src/service/auctioneerScheduleAItemLink.js";
import { normalizeAuctioneer2Lot } from "../src/service/auctioneer2IntegrationService.js";
import { buildMixedAssetFallbackLots } from "../src/jobs/assetReportJob/mixedGroupAnalysis.js";

const choices = [
  { lineId: "line-ford", title: "2021 Ford F150", parentLotId: "lot-ford" },
  { lineId: "line-tools", title: "Misc Shop Tools", parentLotId: "lot-tools" },
];

function work(kind: "scheduleA" | "unknown", hasScheduleA: boolean | undefined, extra: Record<string, unknown> = {}) {
  return {
    _id: "68a12c24f3c7f07935f6d222",
    kind,
    selectedReportType: "asset",
    clientSubmissionId: "auctioneer2-continuation",
    contract: { id: "contract-1", contractNo: "C-100", eventDate: "2026-08-12", hasScheduleA },
    scheduleAChoices: choices,
    snapshot: {
      lots: kind === "scheduleA"
        ? [{ sourceKey: "line-source-1", lotId: "lot-ford", submissionId: "submission-1" }]
        : [],
    },
    ...extra,
  } as any;
}

describe("Schedule A item link (owner 2026-10-28)", () => {
  it("requires an item only for lines-free work on a contract with a Schedule A", () => {
    expect(requiresScheduleAItem(work("unknown", true))).toBe(true);
    expect(requiresScheduleAItem(work("unknown", false))).toBe(false);
    expect(requiresScheduleAItem(work("unknown", undefined))).toBe(false);
    expect(requiresScheduleAItem(work("scheduleA", true))).toBe(false);
  });

  it("offers only items ticked Several lots that already have an Auctioneer lot", () => {
    expect(scheduleAChoicesFromItems([
      { lineId: "a", title: "Ticked with lot", severalLots: true, parentLotId: "lot-a" },
      { lineId: "b", title: "Not ticked", severalLots: false, parentLotId: "lot-b" },
      { lineId: "c", title: "Ticked, unsigned", severalLots: true, parentLotId: null },
      { lineId: "", title: "No line", severalLots: true, parentLotId: "lot-d" },
      { lineId: "e", title: "Same parent twice", severalLots: true, parentLotId: "lot-a" },
      { lineId: "f", title: "  ", severalLots: true, parentLotId: "lot-f" },
    ])).toEqual([
      { lineId: "a", title: "Ticked with lot", parentLotId: "lot-a" },
      { lineId: "f", title: "Schedule A item", parentLotId: "lot-f" },
    ]);
  });

  it("keeps a valid chosen item on every submitted lot and refuses a missing or foreign one", () => {
    const details: any = { mixed_lots: [
      { count: 2, mode: "single_lot", schedule_a_parent_lot_id: " lot-tools " },
      { count: 1, mode: "single_lot", schedule_a_parent_lot_id: "lot-tools" },
    ] };
    applyCanonicalAuctioneerDetails(details, work("unknown", true));
    expect(details.mixed_lots.map((lot: any) => lot.schedule_a_parent_lot_id)).toEqual(["lot-tools", "lot-tools"]);

    for (const link of [undefined, "", "lot-not-offered"]) {
      let caught: unknown;
      try {
        applyCanonicalAuctioneerDetails({ mixed_lots: [{ count: 1, mode: "single_lot", schedule_a_parent_lot_id: link }] }, work("unknown", true));
      } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(AuctioneerReportContextError);
      expect(caught).toMatchObject({
        statusCode: 409,
        code: "AUCTIONEER_SCHEDULE_A_ITEM_REQUIRED",
        message: "Choose which Schedule A item this lot belongs to.",
      });
    }
  });

  it("refuses every lot when the contract offers no item yet", () => {
    expect(() => applyCanonicalAuctioneerDetails(
      { mixed_lots: [{ count: 1, mode: "single_lot", schedule_a_parent_lot_id: "lot-ford" }] },
      work("unknown", true, { scheduleAChoices: [] })
    )).toThrow("Choose which Schedule A item this lot belongs to.");
  });

  it("drops a link sent for work that has no Schedule A or keeps its own lines", () => {
    const plain: any = { mixed_lots: [{ count: 1, mode: "single_lot", schedule_a_parent_lot_id: "lot-ford" }] };
    applyCanonicalAuctioneerDetails(plain, work("unknown", false));
    expect(plain.mixed_lots[0]).not.toHaveProperty("schedule_a_parent_lot_id");

    const lines: any = { mixed_lots: [{ count: 1, source_key: "line-source-1", schedule_a_parent_lot_id: "lot-tools" }] };
    applyCanonicalAuctioneerDetails(lines, work("scheduleA", true));
    expect(lines.mixed_lots[0]).toMatchObject({ source_key: "line-source-1", source_lot_id: "lot-ford" });
    expect(lines.mixed_lots[0]).not.toHaveProperty("schedule_a_parent_lot_id");
  });

  it("restores links a preview client did not send back, without replacing one it did", () => {
    const previous = [
      { lot_id: "lot-001", auctioneer_source_key: "w:unknown:1", schedule_a_parent_lot_id: "lot-tools" },
      { lot_id: "lot-002", auctioneer_source_key: "w:unknown:2", schedule_a_parent_lot_id: "lot-tools" },
    ];
    const next = inheritScheduleAItemLinks([
      { lot_id: "renumbered", auctioneer_source_key: "w:unknown:1", title: "Edited" },
      { lot_id: "lot-002" },
      { lot_id: "lot-new", title: "Added while editing" },
      { lot_id: "lot-001", schedule_a_parent_lot_id: "lot-ford" },
    ], previous);
    expect(next.map((lot: any) => lot.schedule_a_parent_lot_id)).toEqual(["lot-tools", "lot-tools", "lot-tools", "lot-ford"]);
  });

  it("does not guess a batch item when the saved lots name more than one", () => {
    const next = inheritScheduleAItemLinks([{ lot_id: "lot-new" }, { lot_id: "dup" }], [
      { lot_id: "dup", schedule_a_parent_lot_id: "lot-tools" },
      { lot_id: "dup", schedule_a_parent_lot_id: "lot-ford" },
    ]);
    expect(next.every((lot: any) => !("schedule_a_parent_lot_id" in lot))).toBe(true);
    // Saved data without any link (older reports) is returned unchanged.
    const lots = [{ lot_id: "a" }];
    expect(restoreScheduleAItemLinks({ lots }, { lots: [{ lot_id: "a" }] }).lots).toBe(lots);
  });

  it("lists lots without a valid link, skipping lots a failed delivery already created", () => {
    const lots = [
      { schedule_a_parent_lot_id: "lot-ford" },
      {},
      { schedule_a_parent_lot_id: "lot-not-offered" },
      {},
    ];
    expect(lotsMissingScheduleAItem(work("unknown", true), lots)).toEqual([1, 2, 3]);
    expect(lotsMissingScheduleAItem(work("unknown", true), lots, (index) => index === 1)).toEqual([2, 3]);
    expect(lotsMissingScheduleAItem(work("unknown", false), lots)).toEqual([]);
  });

  it("keeps the chosen item on every placeholder lot a mixed group yields", () => {
    const lots = buildMixedAssetFallbackLots({
      groupIndex: 0, subMode: "per_photo", sourceKey: "w:unknown:1", scheduleAParentLotId: "lot-tools",
      currency: "CAD", imageUrls: ["https://a/1.jpg", "https://a/2.jpg"], mainImageIndexes: [0, 1], extraImageIndexes: [],
    }, "Review");
    expect(lots.map((lot) => [lot.auctioneer_source_key, lot.schedule_a_parent_lot_id])).toEqual([
      ["w:unknown:1:photo:1", "lot-tools"], ["w:unknown:1:photo:2", "lot-tools"],
    ]);
  });

  it("carries Several lots and the Schedule A item from Auctioneer's lot, defaulting to not ticked", () => {
    expect(normalizeAuctioneer2Lot(
      { id: "lot-ford", title: "2021 Ford F150", scheduleALineId: "line-ford", severalLots: true, scheduleAItemTitle: "2021 Ford F150" },
      { sourceKey: "source-1" }
    )).toMatchObject({ scheduleALineId: "line-ford", severalLots: true, scheduleAItemTitle: "2021 Ford F150" });
    const older = normalizeAuctioneer2Lot({ id: "lot-older", scheduleALineId: null }, { sourceKey: "source-2" });
    expect(older.severalLots).toBe(false);
    expect(older).not.toHaveProperty("scheduleALineId");
    expect(older).not.toHaveProperty("scheduleAItemTitle");
  });
});
