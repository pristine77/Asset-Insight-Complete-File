import { beforeEach, describe, expect, it, vi } from "vitest";

const providers = vi.hoisted(() => ({ get: vi.fn(), create: vi.fn() }));
vi.mock("axios", () => ({ default: { get: providers.get } }));
vi.mock("../src/utils/openaiClient.js", () => ({ default: { responses: { create: providers.create } } }));
vi.mock("../src/service/systemSettingsService.js", () => ({ isAuctioneerSpecWebSearchEnabled: vi.fn(async () => false) }));

import { extractHourMeterReading } from "../src/utils/hourMeterReading.js";
import { enrichLotsWithVin } from "../src/service/vehicleApiService.js";
import { enrichLotListingSpecs } from "../src/service/lotListingSpecEnrichmentService.js";
import { buildScheduleRows } from "../src/service/assetSchedulePdfService.js";
import { normalizeAuctioneerLotSpecs } from "../src/utils/auctioneerSpecRows.js";

const field = "Engine Hours (Showing Unverified)";
const lot = (details: string) => ({
  lot_number: "33", title: "2018 Crawler Dozer", categories: "Crawler Dozer", details,
  serial_number: "1HGCM8A63SA004352",
});
const read = (source: Record<string, unknown>) => normalizeAuctioneerLotSpecs(source).condition_report_specs[field] || "";
const usage = (source: Record<string, unknown>) => buildScheduleRows({ lots: [source] })[0].usage;

beforeEach(() => {
  providers.get.mockReset().mockResolvedValue({ data: { Results: [{}] } });
  providers.create.mockReset().mockImplementation(() => { throw new Error("Unexpected paid analysis"); });
});

describe("intact hour-meter readings", () => {
  it.each([
    ["displayed hour meter reading of 10,770.4 hours.", "10,770.4"],
    ["Hours: 10,770.4", "10,770.4"],
    ["Engine Hours (Showing Unverified): 10,770.4 Hours", "10,770.4"],
    ["Hour Meter: 10,770.4", "10,770.4"],
    ["Hour meter reading of 10,770.4", "10,770.4"],
    ["Showing Hours: 10,770.4", "10,770.4"],
    ["Hours Showing Unverified: 10,770.4", "10,770.4"],
    ["CAT D6T, 10770.4 hours", "10770.4"],
    ["1,234,567.89 hrs", "1,234,567.89"],
    ["0.4 hours", "0.4"], ["0 hours", "0"], ["770.4Hours", "770.4"],
    ["10, 770.4 hours", "10,770.4"], ["10,\n770.4 hours", "10,770.4"],
    ["Hours: 10,770.4; 6 cylinders", "10,770.4"],
    ["Hours: 10,770.4; Cab: enclosed", "10,770.4"],
    ["Engine Hours: 10,770.4\nSerial: ABC-123", "10,770.4"],
    ["10,770.4\nhours", "10,770.4"],
    ["Separator Hours: 100; Engine Hours: 10,770.4", "10,770.4"],
    ["Engine Hours: 10,770.4; Separator Hours: 100", "10,770.4"],
    ["Hours: 100; Engine Hours (Showing Unverified): 10,770.4", "10,770.4"],
  ])("keeps every digit: %s", (text, expected) => {
    expect(extractHourMeterReading(text)).toBe(expected);
  });

  it.each([
    "displayed hour meter reading of 10; 770.4 hours.",
    "10:,770.4 hours", "Hours: 10:,770.4", "Hours: 10; 770.4 hours",
    "10;\n770.4 hours", "10;\r\n770.4 hours", "10;\u00a0770.4 hours",
    "10\u00a0770.4 hours", "10\u202f770.4 hours", "10 770.4 hours",
    "10 - 770.4 hours", "200–300 hours", "200—300 hours", "200−300 hours", "Hours: 770.4 / 10770.4",
    "10:770.4 hours", "10,77.4 hours", "10,770,4 hours",
    "Hours: 10,", "Hour Meter: 10:", "Hours: 10 hp", "Hour meter: 10770.4rpm",
    "Hours: 10 km", "ModelD610770.4 hours", "10:30", "Hours: 10:30",
    "Engine output 770.4 hp", "Odometer 10,770.4 km", "meter unreadable",
    "Separator Hours: 100; Engine Hours: 10; 770.4 hours",
    "Separator Hours: 100", "Separator hour meter: 100", "Threshing Hours: 150", "Rotor Hours: 200",
    "Separator Hours: 100 hours", "Threshing Hours: 150 hrs", "Rotor Hours: 200 hours",
    "Separator Hours (Showing Unverified): 100 hours", "Rotor Hour Meter: 200 hrs",
    "Engine Hours: unknown; Separator Hours: 100", "Hours: 100; Engine Hours: unreadable",
  ])("never takes a trailing fragment or another unit: %s", text => {
    expect(extractHourMeterReading(text)).toBe("");
    expect(read(lot(text))).toBe("");
  });
});

describe("VIN enrichment and canonical CR parity", () => {
  it("retains independent explicitly labeled engine, separator and threshing counters", () => {
    const source = { ...lot("Separator Hours: 100; Threshing Hours: 150; Engine Hours: 10,770.4"), categories: "Harvest Equipment" };
    const specs = normalizeAuctioneerLotSpecs(source).condition_report_specs;
    expect(specs[field]).toBe("10,770.4 Hours");
    expect(specs["Separator Hours (Showing Unverified)"]).toBe("100");
    expect(specs["Threshing Hours (Showing Unverified)"]).toBe("150");
  });
  it("does not fill missing specialized counters from an engine reading", () => {
    const specs = normalizeAuctioneerLotSpecs({ ...lot("Engine Hours: 10,770.4"), categories: "Harvest Equipment" }).condition_report_specs;
    expect(specs[field]).toBe("10,770.4 Hours");
    expect(specs["Separator Hours (Showing Unverified)"] || "").toBe("");
    expect(specs["Threshing Hours (Showing Unverified)"] || "").toBe("");
  });
  it.each(["10,770.4", "1,234,567.89", "10770.4", "0.4", "0"])(
    "preserves reading %s, unrelated numeric evidence and idempotent VIN additions", async reading => {
      const [source] = await enrichLotsWithVin([lot(`grade control, rear ripper; ${reading} hours; Weight: 31,980 kg; Price: $120,000; VIN: 1HGCM8A63SA004352`)]);
      const once = source.details;
      await enrichLotsWithVin([source]);
      expect(source.details).toBe(once);
      expect(source.details).toContain(`${reading} hours`);
      expect(source.details).toContain("31,980 kg");
      expect(source.details).toContain("$120,000");
      expect(source.details).toContain("grade control; rear ripper");
      expect(read(source)).toBe(`${Number(reading.replaceAll(",", "")).toLocaleString("en-US", { maximumFractionDigits: 10 })} Hours`);
      expect(providers.create).not.toHaveBeenCalled();
    },
  );

  it("keeps independent grouped-item readings and source order", async () => {
    const parent = { title: "Group", details: "Parent untouched", items: [lot("10,770.4 hours"), lot("1,234.5 hours")] };
    const [result] = await enrichLotsWithVin([parent]);
    expect(result.details).toBe("Parent untouched");
    expect(result.items.map(read)).toEqual(["10,770.4 Hours", "1,234.5 Hours"]);
  });

  it.each(["10; 770.4 hours", "10:,770.4 hours", "10;\n770.4 hours"])(
    "does not refill a rejected reading in the deterministic Lot enrichment pass: %s", async text => {
      const result = await enrichLotListingSpecs({ mode: "pictureOnly", lots: [lot(text)] });
      expect(read(result.lots[0])).toBe("");
      expect(providers.create).not.toHaveBeenCalled();
    },
  );

  it.each(["9,999.1 Hours", "770.4 Hours", "", "Not Found"])(
    "preserves the reviewed value %j instead of replacing it from prose", value => {
      const source = { ...lot("10,770.4 hours"), condition_report_specs_reviewed: true, condition_report_specs: { [field]: value } };
      const before = JSON.stringify(source);
      const first = normalizeAuctioneerLotSpecs(source);
      const second = normalizeAuctioneerLotSpecs(first);
      expect(first.condition_report_specs[field]).toBe(value);
      expect(second.condition_report_specs).toEqual(first.condition_report_specs);
      expect(JSON.stringify(source)).toBe(before);
    },
  );

  it("retains manual corrections, intentional blanks and deletion aliases", () => {
    const base = { ...lot("10; 770.4 hours"), condition_report_specs: { [field]: "770.4 Hours" } };
    expect(read({ ...base, condition_report_specs_manual_overrides: { Hours: "10,770.4 Hours" } })).toBe("10,770.4 Hours");
    expect(read({ ...base, condition_report_specs_manual_overrides: { Hours: "" } })).toBe("");
    for (const key of ["condition_report_specs_deleted", "deleted_condition_report_specs", "removed_condition_report_specs", "hidden_condition_report_specs"]) {
      expect(read({ ...base, [key]: ["Hour Meter"] })).toBe("");
    }
  });
});

describe("Schedule A hours authority", () => {
  it("uses canonical Engine Hours ahead of stale narrative or root hours without mutating the source", () => {
    const source = { ...lot("10; 770.4 hours"), hours: "770.4", condition_report_specs_reviewed: true, condition_report_specs: { [field]: "10,770.4 Hours" } };
    const before = JSON.stringify(source);
    expect(usage(source)).toBe("10,770.4");
    expect(JSON.stringify(source)).toBe(before);
  });
  it("uses a manual override and keeps manual blank/deleted hours blank", () => {
    const source = { ...lot("10,770.4 hours"), hours: "770.4", condition_report_specs: { [field]: "770.4 Hours" } };
    expect(usage({ ...source, condition_report_specs_manual_overrides: { Hours: "10,770.4 Hours" } })).toBe("10,770.4");
    expect(usage({ ...source, condition_report_specs_manual_overrides: { Hours: "" } })).toBe("");
    expect(usage({ ...source, condition_report_specs_deleted: ["Hour Meter"] })).toBe("");
    expect(usage({ ...source, condition_report_specs_reviewed: true, condition_report_specs: {} })).toBe("");
    expect(usage({ ...source, condition_report_specs_reviewed: true, condition_report_specs: {}, condition_report_specs_manual_overrides: { Hours: "770.4 Hours" } })).toBe("");
  });
  it("never inherits parent hours into a reviewed child cleared table", () => {
    const parent = { ...lot("10,770.4 hours"), hours: "10,770.4", items: [{ title: "Child", condition_report_specs_reviewed: true, condition_report_specs: {} }] };
    expect(usage(parent)).toBe("");
  });
  it("keeps explicit odometer precedence and legacy direct zero hours", () => {
    expect(usage({ ...lot("10,770.4 hours"), mileage: "44,440 km", condition_report_specs: { [field]: "10,770.4 Hours" } })).toBe("44,440 km");
    expect(usage({ ...lot(""), hours: 0 })).toBe("0");
  });
  it("keeps a child's direct hours ahead of parent hours and mileage specifications", () => {
    const parent = { ...lot("10,770.4 hours"), condition_report_specs: { [field]: "10,770.4 Hours", Odometer: "44,440 km" }, items: [{ title: "Child", hours: "123" }] };
    expect(usage(parent)).toBe("123");
    expect(usage({ ...lot(""), hours: "123", condition_report_specs: { Odometer: "44,440 km" } })).toBe("123");
  });
  it("limits reviewed hour suppression to hours while retaining mileage prose and specifications", () => {
    const source = { ...lot("Odometer: 44,440 km; 10,770.4 hours"), hours: "770.4", condition_report_specs_reviewed: true, condition_report_specs: {} };
    expect(usage(source)).toBe("44,440");
    expect(usage({ ...source, condition_report_specs: { Odometer: "44,440 km" }, condition_report_specs_deleted: ["Hours"] })).toBe("44,440");
    expect(usage({ ...lot("10,770.4 hours"), hours: "10,770.4", items: [{ title: "Child", details: "Mileage: 44,440 km", condition_report_specs_reviewed: true, condition_report_specs: {} }] })).toBe("44,440");
  });
  it.each(["10; 770.4 hours", "10:,770.4 hours", "10;\n770.4 hours"])("refuses a malformed fallback: %s", text => {
    expect(usage(lot(text))).toBe("");
  });
});
