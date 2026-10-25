import { describe, expect, it } from "vitest";
import { buildSalvageReportData, formatSalvageDate, salvageNumber } from "../src/service/salvageReportData.js";
import { buildSalvageAssessment } from "../src/service/salvageAssessment.js";

describe("Salvage canonical report data", () => {
  it("projects enterprise calculations last without restoring legacy zeros or stale totals", () => {
    const assessment = buildSalvageAssessment({ inputs: { year: 2019, make: "Ford", model: "F-150",
      overrides: { preLoss: { amount: 25000, appraiserReason: "Appraiser reviewed the documented vehicle value." } } } });
    const source = { assessment, actual_cash_value: 9999, replacement_cost: 8888,
      repair_estimate: { total: 12345 }, valuation: { fairMarketValue: "CAD 7777" },
      imageUrls: Array.from({ length: 50 }, (_, i) => `https://assetinsight.test/${i}.jpg`),
      aiExtractedDetails: { actual_cash_value: 6666, repair_estimate: { total: 5555 } } };
    const before = structuredClone(source);
    const result = buildSalvageReportData(source);
    expect(result.actual_cash_value).toBe(25000);
    expect(result.replacement_cost).toBeNull();
    expect(result.repair_estimate.total).toBeNull();
    expect(result.valuation.fairMarketValue).toBe("Unavailable");
    expect(result.aiExtractedDetails.repair_estimate.total).toBeNull();
    expect(result.aiExtractedDetails.actual_cash_value).toBe(25000);
    expect(result.imageUrls).toEqual(source.imageUrls);
    expect(buildSalvageReportData(JSON.parse(JSON.stringify(result)))).toEqual(result);
    expect(source).toEqual(before);
  });
  it("keeps reviewed strings, blanks, zero values, dates and all original photo URLs", () => {
    const imageUrls = Array.from({ length: 30 }, (_, i) => `https://assetinsight.test/salvage/${i + 1}.heic`);
    const report_date = new Date("2026-09-07T00:00:00Z");
    const source = { imageUrls, report_date, item_model: "Reviewed vehicle", vin: "", actual_cash_value: 0,
      aiExtractedDetails: { item_model: "Old AI guess", vin: "OLDVIN", actual_cash_value: 5000, item_condition: "Photo evidence" } };
    const result = buildSalvageReportData(source);
    expect(result).toMatchObject({ item_model: "Reviewed vehicle", vin: "", actual_cash_value: 0, item_condition: "Photo evidence" });
    expect(result.report_date).toBe(report_date);
    expect(result.imageUrls).toEqual(imageUrls);
    expect(result.imageUrls).not.toBe(imageUrls);
    expect(result.aiExtractedDetails.item_model).toBe("Reviewed vehicle");
    expect(source.aiExtractedDetails.item_model).toBe("Old AI guess");
  });

  it("recomputes edited quantity, price and hours, ignores stale line totals and reconciles the grand total", () => {
    const source = { repair_items: [{ name: "Panel", quantity: 3, unit_price: 12.55, line_total: 9999 }],
      labour_breakdown: [{ task: "Fit panel", hours: 2.5, line_total: 7777 }], labour_rate_default: 40,
      repair_estimate: { shop_supplies: 5, miscellaneous: 2, taxes: 7, less_betterment: 10, total: 9999 },
      aiExtractedDetails: { repair_estimate: { parts: 8000, labour: 9000, total: 17000 } } };
    const result = buildSalvageReportData(source);
    expect(result.repair_items[0].line_total).toBe(37.65);
    expect(result.labour_breakdown[0].line_total).toBe(100);
    expect(result.repair_estimate).toMatchObject({ parts: 37.65, labour: 100, total: 141.65 });
    expect(result.parts_subtotal).toBe(37.65);
    expect(result.estimate_warning).toContain("not supplier quotations");
    expect(buildSalvageReportData(result)).toEqual(result);
  });

  it("preserves summary-only legacy estimates through repeated normalization", () => {
    const result = buildSalvageReportData({ aiExtractedDetails: { repair_estimate: { parts: 250, labour: 100, taxes: 20 } } });
    expect(result.repair_estimate.total).toBe(370);
    expect(buildSalvageReportData(result).repair_estimate.total).toBe(370);
    expect(buildSalvageReportData(JSON.parse(JSON.stringify(result))).repair_estimate.total).toBe(370);
  });

  it("does not restore cleared itemized rows from old AI evidence", () => {
    const result = buildSalvageReportData({ repair_items: [], labour_breakdown: [],
      aiExtractedDetails: { repair_estimate: { parts_items: [{ quantity: 1, unit_price: 100 }], labour_breakdown: [{ hours: 2, rate_per_hour: 50 }] } } });
    expect(result.repair_items).toEqual([]);
    expect(result.labour_breakdown).toEqual([]);
    expect(result.repair_estimate.total).toBe(0);
  });

  it("preserves a known line total when quantity is genuinely missing", () => {
    const result = buildSalvageReportData({ repair_items: [{ name: "Lump sum supplied estimate", line_total: 40 }] });
    expect(result.parts_subtotal).toBe(40);
    expect(buildSalvageReportData(JSON.parse(JSON.stringify(result))).parts_subtotal).toBe(40);
  });

  it.each([undefined, null, "", "Not Found", "unknown123", NaN, Infinity])("does not parse unavailable amount %s as evidence", (value) => {
    expect(salvageNumber(value)).toBeUndefined();
  });
  it("parses plain currency amounts and rejects malformed ranges", () => {
    expect(salvageNumber("CA$1,234.56")).toBe(1234.56);
    expect(salvageNumber("USD 0")).toBe(0);
    expect(salvageNumber("500-700")).toBeUndefined();
  });
  it("formats UTC report dates without changing the calendar day", () => {
    expect(formatSalvageDate("2026-09-07", "en")).toBe("September 7, 2026");
    expect(formatSalvageDate("bad date")).toBe("");
    expect(formatSalvageDate(undefined)).toBe("");
  });
});
