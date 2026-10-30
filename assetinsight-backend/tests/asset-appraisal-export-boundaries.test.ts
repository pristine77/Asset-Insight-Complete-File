import { beforeEach, describe, expect, it, vi } from "vitest";

const rendering = vi.hoisted(() => ({
  docx: vi.fn(async () => Buffer.from("fixture-docx")),
  setContent: vi.fn(async () => {}),
  pdf: vi.fn(async () => Buffer.from("fixture-pdf")),
}));
vi.mock("../src/service/docx/mixedDocxBuilder.js", () => ({ generateMixedDocx: rendering.docx }));
vi.mock("../src/utils/docxMergeMode.js", () => ({ shouldUseGroupDocsMerge: () => false }));
vi.mock("puppeteer", () => ({ default: { launch: async () => ({
  newPage: async () => ({ setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
    setContent: rendering.setContent, pdf: rendering.pdf }), close: async () => {},
}) } }));
vi.mock("../src/service/marketIntelService.js", () => ({
  fetchCanadaAndNorthAmericaIndicators: async () => ({ industry: "Synthetic", primaryRegionIndicators: { series: { years: [], values: [] } }, northAmerica: { series: { years: [], values: [] } } }),
  generateTrendChartImage: async () => Buffer.from("chart"), generateBarChartImage: async () => Buffer.from("chart"),
}));

import { generateAssetDocxFromReport } from "../src/service/assetDocxService.js";
import { generateAssetPdfFromReport } from "../src/service/assetPdfService.js";
import { generateAssetSchedulePdfFromReport } from "../src/service/assetSchedulePdfService.js";

function fixture() {
  const lot = { lot_id: "synthetic-1", lot_number: "1", title: "Saved fixture title", estimated_value: "CAD 12,637.79", image_urls: [] };
  const sheet = { evaluator_columns: [{ id: "owner" }, { id: "peer" }], rows: [{ lot_id: lot.lot_id,
    asset_insight: lot.estimated_value, evaluator_values: { owner: 13500, peer: 13500 } }] };
  return { grouping_mode: "per_item", currency: "CAD", include_valuation_table: false, valuation_methods: [],
    lots: [lot], total_value: 12637.79,
    preview_data: { lots: [lot], total_value: 12637.79, admin_schedule_sheet: sheet } };
}

beforeEach(() => vi.clearAllMocks());

describe("Asset actual export entry points project only their rendering input", () => {
  it("supplies evaluator amounts to the Word builder but retains nested AI/source inputs", async () => {
    const report = fixture();
    const before = structuredClone(report);
    await generateAssetDocxFromReport(report);
    const data: any = rendering.docx.mock.calls[0][0];
    expect(data.total_value).toBe(13500);
    expect(data.lots[0].estimated_value).toBe("CAD 13500.00");
    expect(data.preview_data.lots[0].estimated_value).toBe("CAD 12,637.79");
    expect(data.preview_data.admin_schedule_sheet).toBe(report.preview_data.admin_schedule_sheet);
    expect(data.preview_data.admin_schedule_sheet.rows[0].asset_insight).toBe("CAD 12,637.79");
    expect(report).toEqual(before);
  });

  it("renders evaluator values in both legacy complete-PDF and current Schedule-PDF paths", async () => {
    const report = fixture();
    const before = structuredClone(report);
    await generateAssetPdfFromReport(report);
    const mainHtml = rendering.setContent.mock.calls.at(-1)?.[0];
    expect(mainHtml).toContain("CAD 13500.00");
    expect(mainHtml).not.toContain("12,637.79");
    await generateAssetSchedulePdfFromReport(report);
    const scheduleHtml = rendering.setContent.mock.calls.at(-1)?.[0];
    expect(scheduleHtml).toContain("CAD 13,500.00");
    expect(scheduleHtml).not.toContain("12,637.79");
    expect(report).toEqual(before);
  });

  it("returns actionable incomplete-method errors before Word image/provider work starts", async () => {
    const report = { ...fixture(), valuation_methods: ["FLV"] };
    await expect(generateAssetDocxFromReport(report)).rejects.toThrow("saved FLV percentage");
    expect(rendering.docx).not.toHaveBeenCalled();
    expect(rendering.setContent).not.toHaveBeenCalled();
  });

  it("passes only emitted child totals to Word and renders the same rows in the actual Schedule PDF path", async () => {
    const report: any = fixture();
    report.valuation_methods = ["FLV"];
    report.valuation_data = { methods: [{ method: "FLV", percentage: 50, value: 999 }] };
    report.preview_data.admin_schedule_sheet.rows[0].evaluator_values = { owner: 100, peer: 100 };
    report.lots.push({ lot_id: "synthetic-2", lot_number: "2", title: "Grouped blank evaluator fixture", estimated_value: "CAD 500", flv: 200,
      items: [{ title: "Child A", estimated_value: "CAD 10", flv: 5 }, { title: "Child B", estimated_value: "CAD 12", flv: 6 }] });
    const before = structuredClone(report);
    await generateAssetDocxFromReport(report);
    const wordData: any = rendering.docx.mock.calls[0][0];
    expect(wordData.valuation_data.methods[0].value).toBe(61);
    expect(wordData.total_forced_liquidation_value).toBe(61);
    await generateAssetSchedulePdfFromReport(report);
    const html = rendering.setContent.mock.calls.at(-1)?.[0];
    for (const amount of ["CAD 50.00", "CAD 5.00", "CAD 6.00"]) expect(html).toContain(amount);
    expect(html).not.toContain("CAD 200.00");
    expect(report).toEqual(before);
  });
});
