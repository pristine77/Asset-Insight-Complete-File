import { describe, expect, it } from "vitest";
import type { AuctioneerWorkItemSetup } from "@/services/auctioneer";
import {
  auctioneerDateOnly,
  auctioneerDraftScope,
  buildAuctioneerSeedLots,
  currentScheduleAParentLotId,
  scheduleAChoicesFor,
  scheduleAItemError,
  withCurrentSeveralLots,
} from "./auctioneerSeed";
import type { MixedLot } from "./mixed/types";

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

// Owner 2026-10-28: "Several lots" lines and the Schedule A item choice.
describe("Schedule A Several lots and item choice", () => {
  const ticked = (kind: AuctioneerWorkItemSetup["kind"]) => {
    const value = setup(kind);
    value.lots[0].severalLots = true;
    return value;
  };

  it("marks only ticked Schedule A lines as Several lots", () => {
    const lots = buildAuctioneerSeedLots(ticked("scheduleA"));
    expect(lots.map((lot) => lot.source?.severalLots)).toEqual([true, undefined]);
    expect(buildAuctioneerSeedLots(ticked("unknown"))[0].source).not.toHaveProperty("severalLots");
  });

  it("re-reads the tick for restored lines and their splits from the current setup", () => {
    const restored: MixedLot[] = [
      ...buildAuctioneerSeedLots(setup("scheduleA")),
      {
        id: "split-1", files: [], extraFiles: [], coverIndex: 0, mode: "single_lot",
        source: { key: "source-2:split:1", parentKey: "source-2", locked: false, severalLots: true },
      },
    ];
    const current = setup("scheduleA");
    current.lots[0].severalLots = true;

    const refreshed = withCurrentSeveralLots(restored, current);
    expect(refreshed.map((lot) => lot.source?.severalLots)).toEqual([true, undefined, undefined]);
    // Nothing to change returns the same array, so no needless re-render.
    expect(withCurrentSeveralLots(refreshed, current)).toBe(refreshed);
    expect(withCurrentSeveralLots(restored, setup("unknown"))).toBe(restored);
  });

  it("asks for an item only when the work item requires one", () => {
    const base = setup("unknown");
    expect(scheduleAItemError(base, "")).toBeUndefined();
    expect(scheduleAItemError({ ...base, requiresScheduleAItem: false, scheduleAChoices: [] }, "")).toBeUndefined();
    expect(scheduleAChoicesFor({ ...base, requiresScheduleAItem: false, scheduleAChoices: [{ lineId: "line-1", title: "Item", parentLotId: "lot-1" }] })).toEqual([]);
  });

  it("blocks with the owner's wording until a currently offered item is chosen", () => {
    const required = {
      ...setup("unknown"),
      requiresScheduleAItem: true,
      scheduleAChoices: [{ lineId: "line-1", title: "2021 Ford F150", parentLotId: "lot-10" }],
    };
    expect(scheduleAItemError({ ...required, scheduleAChoices: [] }, "lot-10")).toBe(
      "No Schedule A item on this contract is marked Several lots in Auctioneer 2.0. Ask the office to tick it on the contract, then try again."
    );
    expect(scheduleAItemError(required, "")).toBe("Choose which Schedule A item these lots belong to.");
    // A saved choice the refreshed setup no longer offers counts as none.
    expect(currentScheduleAParentLotId(required, "lot-gone")).toBe("");
    expect(scheduleAItemError(required, "lot-gone")).toBe("Choose which Schedule A item these lots belong to.");
    expect(currentScheduleAParentLotId(required, "lot-10")).toBe("lot-10");
    expect(scheduleAItemError(required, "lot-10")).toBeUndefined();
  });
});
