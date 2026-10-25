import { describe, expect, it } from "vitest";
import type { AuctioneerWorkItemSetup } from "@/services/auctioneer";
import {
  auctioneerDateOnly,
  auctioneerDraftScope,
  buildAuctioneerSeedLots,
} from "./auctioneerSeed";

function setup(
  kind: AuctioneerWorkItemSetup["kind"]
): AuctioneerWorkItemSetup {
  return {
    workItemId: "work-item-1",
    cycleKey: "cycle-1",
    kind,
    reportType: "asset",
    contract: {
      id: "contract-1",
      contractNo: "CTR-100",
      customerName: "Example Customer",
      eventTitle: "Example Event",
      eventDate: "2026-08-12T15:30:00.000Z",
      location: "London",
    },
    lots: [
      {
        sourceKey: "source-1",
        lotId: "lot-1",
        submissionId: "submission-1",
        lotNumber: "12",
        title: "Excavator",
        services: ["Photography", "Condition report"],
      },
      {
        sourceKey: "source-2",
        lotId: "lot-2",
        submissionId: "submission-2",
        lotNumber: "13",
        title: "Loader",
      },
    ],
  };
}

describe("Auctioneer form seeds", () => {
  it("creates locked single-lot mappings for Schedule A", () => {
    const lots = buildAuctioneerSeedLots(setup("scheduleA"));
    expect(lots).toHaveLength(2);
    expect(lots.map((lot) => lot.mode)).toEqual([
      "single_lot",
      "single_lot",
    ]);
    expect(lots.map((lot) => lot.source?.key)).toEqual([
      "source-1",
      "source-2",
    ]);
    expect(lots.every((lot) => lot.source?.locked)).toBe(true);
    expect(lots[0].source?.description).toContain(
      "Services: Photography, Condition report"
    );
  });

  it("starts Unknown Lots with one editable source lot", () => {
    const lots = buildAuctioneerSeedLots(setup("unknown"));
    expect(lots).toHaveLength(1);
    expect(lots[0].source).toMatchObject({
      key: "source-1",
      locked: false,
    });
  });

  it("uses a work-item-specific draft scope and UTC date seed", () => {
    const value = setup("scheduleA");
    expect(auctioneerDraftScope(value)).toBe("auctioneer:work-item-1");
    expect(auctioneerDateOnly(value.contract.eventDate)).toBe("2026-08-12");
  });
});
