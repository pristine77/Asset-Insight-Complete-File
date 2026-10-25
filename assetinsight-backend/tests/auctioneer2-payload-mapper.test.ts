import { describe, expect, it } from "vitest";
import {
  buildAuctioneerConditionReport,
  buildAuctioneerKnownLotPatch,
  buildAuctioneerUnknownLotPayload,
  mergeAuctioneerSourceLot,
  resolveAuctioneerEstimatedValue,
  resolveAuctioneerLotNumber,
} from "../src/service/auctioneer2PayloadMapper.js";

describe("Auctioneer 2.0 payload mapping", () => {
  it.each([
    [{ lot_number: " 012A " }, "012A"],
    [{ lot_number: 12 }, "12"],
    [{ lotNumber: "12" }, "12"],
    [{ lot_number: 0 }, "0"],
    [{ lot_number: "", lotNumber: "stale" }, ""],
    [{ lot_number: "   " }, ""],
    [{}, ""],
    [{ lot_number: {} }, ""],
    [{ lot_number: false }, ""],
    [{ lot_number: NaN }, ""],
    [{ lot_number: Infinity }, ""],
  ])("normalizes only a supplied display lot number: %j", (lot, expected) => {
    expect(resolveAuctioneerLotNumber(lot)).toBe(expected);
  });
  it("fills only missing AI fields from the canonical source lot", () => {
    const merged = mergeAuctioneerSourceLot(
      { title: "Approved title", make: "" },
      {
        sourceKey: "submission-1",
        lot: {
          description: "Source title",
          make: "CAT",
          model: "320",
          serialNumber: "SER-1",
        },
      }
    );

    expect(merged.title).toBe("Approved title");
    expect(merged.make).toBe("CAT");
    expect(merged.model).toBe("320");
    expect(merged.serial_number).toBe("SER-1");
    expect(merged.auctioneer_source_key).toBe("submission-1");
  });

  it("builds an approved condition report and supported lot patch", () => {
    const lot = {
      title: "2020 CAT 320 Excavator",
      description: "Starts and operates",
      make: "CAT",
      model: "320",
      year: "2020",
      serial_number: "CAT-320-X",
      hours: "5200",
      category: "Heavy Equipment",
      estimated_value: "CA$15,000",
      base_condition: "Good",
      damage_analysis: { cab: "Minor scratches" },
    };

    expect(buildAuctioneerConditionReport(lot)).toContain(
      "2020 CAT 320 Excavator"
    );
    const patch = buildAuctioneerKnownLotPatch(lot, {});
    expect(patch).toMatchObject({
      description: "2020 CAT 320 Excavator",
      year: "2020",
      make: "CAT",
      model: "320",
      serialNumber: "CAT-320-X",
      hours: "5200",
      categories: "Heavy Equipment",
      estimatedValue: "15000",
      baseCondition: "Good",
    });
    expect(patch).not.toHaveProperty("conditionReportDone");
  });

  it("normalizes stored report valuations for Auctioneer requests", () => {
    expect(resolveAuctioneerEstimatedValue({ estimated_value: "$4,250.50" })).toBe(
      "4250.5"
    );
    expect(resolveAuctioneerEstimatedValue({ fmv: 0 })).toBe("0");
    expect(resolveAuctioneerEstimatedValue({ estimated_value: "Not available" })).toBe(
      ""
    );
  });

  it("does not restore an imported field that was cleared in the approved preview", () => {
    const patch = buildAuctioneerKnownLotPatch(
      { title: "Approved title", make: "", model: "" },
      { make: "Imported make", model: "Imported model" },
      { useSourceFallbacks: false }
    );

    expect(patch).not.toHaveProperty("make");
    expect(patch).not.toHaveProperty("model");
  });

  it("copies only complete inherited service references to an Unknown Lot", () => {
    const payload = buildAuctioneerUnknownLotPayload({
      lot: { title: "Tractor", make: "John Deere" },
      sourceLot: {
        services: [
          {
            revenueContractId: "rc-1",
            revenueContractServiceId: "service-1",
            serviceName: "Steam Clean",
            price: "150.00",
            quantity: "1.00",
          },
          { serviceName: "Incomplete" },
        ],
      },
      contractId: "contract-1",
      eventId: "event-1",
      contractLotRef: "AI-cycle-1-1",
      destination: "LottingBoard",
      submittedBy: "Field User",
    });

    expect(payload.selectedServices).toEqual([
      {
        revenueContractId: "rc-1",
        revenueContractServiceId: "service-1",
        serviceName: "Steam Clean",
        price: 150,
        quantity: 1,
      },
    ]);
  });
});
