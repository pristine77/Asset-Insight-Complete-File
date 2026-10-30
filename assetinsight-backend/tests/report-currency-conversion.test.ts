import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../src/utils/openaiClient.js", () => ({ default: { responses: { create: mock.create } } }));
import { convertPreviewMoney, convertReportMoney, convertReportPreviewCurrency, convertedAuthoritativeAssetPreview, currencyConversionForSave, lookupCurrentCurrencyQuote } from "../src/service/reportCurrencyConversionService.js";

function response(from = "CAD", to = "USD", rate = 0.5, overrides: any = {}) {
  const sourceUrl = "https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json";
  return { status: "completed", output_text: JSON.stringify({ fromCurrency: from, toCurrency: to, rate, asOf: "2026-10-30", sourceUrl, sourceTitle: "Bank of Canada daily rates", ...overrides }), output: [{ type: "web_search_call", action: { sources: [{ url: sourceUrl }] } }] };
}
function report() {
  return { _id: "6ac42c820fdba415dd5f4b4b", currency: "CAD", updatedAt: new Date("2026-10-30T11:00:00Z"), proposal_valuation_revision: 3,
    preview_data: { currency: "CAD", contract_no: "CONFIDENTIAL-123", total_value: 1000, total_appraised_value: 1000,
      lots: [{ id: "lot-1", lot_number: "1", title: "CONFIDENTIAL TITLE", estimated_value: "CA$1,000.00", opening_bid: 1.01, bid_increment: 0, image_urls: ["https://private.example/photo.jpg"], specs: { Hours: "1000", Length: "123" }, items: [{ title: "item", estimated_value: "CAD 400", image_urls: ["https://private.example/extra.jpg"] }] }],
      valuation_methods: ["FMV", "FLV"], valuation_data: { baseFMV: 1000, methods: [{ method: "FMV", percentage: 100, value: 1000 }, { method: "FLV", percentage: 43, value: 430 }] },
      admin_schedule_sheet: { evaluator_columns: [{ id: "owner", name: "Owner" }, { id: "zero", name: "Zero" }, { id: "blank", name: "Blank" }], rows: [{ lot_id: "lot-1", asset_id: "1", asset_insight: "CAD 1000", evaluator_values: { owner: 1000, zero: 0, blank: null }, lien_search: 12.01, video_cost: null, notes: "Keep CAD 500 as historical quoted text", market_check: { avg_retail_asking_price: "Moderate" } }], file_summary: { buyers_premium_basis: "uncapped", total_risk_weighted_value: 1000, file_risk_multiplier: .9, commission_percent_no_guarantee: 12, offer2_nmg_percent: .785, capped_threshold_percent: .1 } },
    } };
}
const clone = <T>(x: T): T => structuredClone(x);
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-30T12:00:00Z")); mock.create.mockReset().mockResolvedValue(response()); });
afterEach(() => vi.useRealTimers());

describe("report currency conversion", () => {
  it("only sends a currency pair and date to web search, preserves source data and converts all saved money", async () => {
    const source = report(), before = clone(source);
    const result = await convertReportPreviewCurrency({ report: source, kind: "asset", previewData: source.preview_data, targetCurrency: "USD" });
    expect(source).toEqual(before);
    const next = result.preview_data;
    expect(next.currency).toBe("USD"); expect(next.lots[0].estimated_value).toMatch(/USD.*500\.00/);
    expect(next.lots[0].items[0].estimated_value).toMatch(/USD.*200\.00/);
    expect(next.lots[0].opening_bid).toBe(.51); expect(next.lots[0].bid_increment).toBe(0);
    expect(next.lots[0].specs).toEqual(before.preview_data.lots[0].specs);
    expect(next.lots[0].image_urls).toEqual(before.preview_data.lots[0].image_urls);
    expect(next.total_value).toBe(500); expect(next.total_appraised_value).toBe(500);
    expect(next.valuation_data.methods.map((m: any) => m.value)).toEqual([500, 215]);
    expect(next.valuation_data.methods.map((m: any) => m.percentage)).toEqual([100, 43]);
    const row = next.admin_schedule_sheet.rows[0];
    expect(row.evaluator_values).toEqual({ owner: 500, zero: 0, blank: null });
    expect(row.buyer_premium_percent).toBe(15); expect(row.buyer_premium_amount).toBe(37.5);
    expect(row.lien_search).toBe(6.01); expect(row.video_cost).toBeNull();
    expect(row.notes).toBe(before.preview_data.admin_schedule_sheet.rows[0].notes);
    expect(row.market_check.avg_retail_asking_price).toBe("Moderate");
    expect(next.admin_schedule_sheet.file_summary.file_risk_multiplier).toBe(.9);
    const sent = JSON.stringify(mock.create.mock.calls[0]);
    expect(sent).toContain('"type":"web_search"'); expect(sent).not.toContain("CONFIDENTIAL"); expect(sent).not.toContain("private.example"); expect(sent).not.toContain("input_image");
    expect(mock.create.mock.calls[0][1]).toEqual({ timeout: 30000, maxRetries: 0 });
  });
  it("sums rounded lots rather than rounding a converted old total", () => {
    const x = convertPreviewMoney({ currency: "CAD", total_value: .03, lots: [1, 2, 3].map(id => ({ id, estimated_value: "CAD 0.01" })), valuation_data: { baseFMV: .03, methods: [{ method: "FMV", percentage: 100, value: .03 }] } }, "CAD", "USD", { n: "1", d: "2" }, "lotListing");
    expect(x.total_value).toBe(.03); expect(x.lots.map((l: any) => l.estimated_value)).toEqual(Array(3).fill("USD 0.01"));
    expect(x.valuation_data.baseFMV).toBe(.03); expect(x.valuation_data.methods[0].value).toBe(.03);
  });
  it("does not compound per-lot rounding on round trips and respects manually edited amounts", async () => {
    const source = report(); source.preview_data.lots[0].estimated_value = "CAD 0.01";
    const first = await convertReportPreviewCurrency({ report: source, kind: "asset", previewData: source.preview_data, targetCurrency: "USD" });
    expect(first.preview_data.lots[0].estimated_value).toMatch(/0\.01/);
    mock.create.mockResolvedValueOnce(response("USD", "CAD", 2));
    const returned = await convertReportPreviewCurrency({ report: source, kind: "asset", previewData: first.preview_data, targetCurrency: "CAD" });
    expect(returned.preview_data.lots[0].estimated_value).toMatch(/0\.01/);
    first.preview_data.lots[0].estimated_value = "USD 0.02";
    mock.create.mockResolvedValueOnce(response("USD", "CAD", 2));
    const edited = await convertReportPreviewCurrency({ report: source, kind: "asset", previewData: first.preview_data, targetCurrency: "CAD" });
    expect(edited.preview_data.lots[0].estimated_value).toMatch(/0\.04/);
  });
  it("preserves independently edited valuation base and explicit method amounts", async () => {
    const source = report(); source.preview_data.valuation_data.baseFMV = 100;
    source.preview_data.total_value = 120; source.preview_data.total_appraised_value = 150;
    source.preview_data.valuation_data.methods = [{ method: "FLV", percentage: 50, value: 60 }];
    mock.create.mockResolvedValueOnce(response("CAD", "USD", .7));
    const result = await convertReportPreviewCurrency({ report: source, kind: "asset", previewData: source.preview_data, targetCurrency: "USD" });
    expect(result.preview_data.valuation_data.baseFMV).toBe(70);
    expect(result.preview_data.valuation_data.methods[0]).toEqual({ method: "FLV", percentage: 50, value: 42 });
    expect(result.preview_data.total_value).toBe(84); expect(result.preview_data.total_appraised_value).toBe(105);
  });
  it("keeps a dated signed intent valid for long editing sessions without a surprise reprice", async () => {
    const source = report(); const result = await convertReportPreviewCurrency({ report: source, kind: "asset", previewData: source.preview_data, targetCurrency: "USD" });
    vi.setSystemTime(new Date("2026-11-02T12:00:00Z"));
    expect(currencyConversionForSave(source, source.preview_data, result.preview_data, "asset")).toBeTruthy();
    expect(mock.create).toHaveBeenCalledOnce();
  });
  it.each(["EUR 1.234,56", "EUR 1,50", "EUR 12,34.56"])("rejects ambiguous monetary text %s", value => {
    expect(() => convertReportMoney(value, "EUR", "USD", { n: "1", d: "1" })).toThrow(/cannot be converted safely/);
  });
  it("rejects an aggregate exceeding safe minor-unit precision", () => {
    expect(() => convertPreviewMoney({ total_value: 0, lots: [{ estimated_value: "CAD 50000000000000" }, { estimated_value: "CAD 50000000000000" }] }, "CAD", "USD", { n: "1", d: "1" }, "lotListing")).toThrow(/total is too large/);
  });
  it("uses target minor units and half-up rounding including negative values", () => {
    expect(convertReportMoney(1.005, "CAD", "JPY", { n: "3", d: "2" })).toBe(2);
    expect(convertReportMoney(1.005, "CAD", "KWD", { n: "3", d: "2" })).toBe(1.508);
    expect(convertReportMoney("-CAD 1.005", "CAD", "KWD", { n: "3", d: "2" })).toBe(-1.508);
    expect(convertReportMoney("-USD 12.00", "USD", "CAD", { n: "2", d: "1" })).toBe(-24);
    for (const value of [null, undefined, "", "Not Found", "N/A"]) expect(convertReportMoney(value, "CAD", "USD", { n: "1", d: "2" })).toBe(value);
    expect(convertReportMoney(0, "CAD", "USD", { n: "1", d: "2" })).toBe(0);
  });
  it("keeps an authoritative original PV basis through multiple pre-save conversions", async () => {
    const source = report();
    const first = await convertReportPreviewCurrency({ report: source, kind: "asset", previewData: source.preview_data, targetCurrency: "USD" });
    first.preview_data.admin_schedule_sheet.rows[0].evaluator_values.owner = 999999;
    mock.create.mockResolvedValueOnce(response("USD", "EUR", 2));
    const second = await convertReportPreviewCurrency({ report: source, kind: "asset", previewData: first.preview_data, targetCurrency: "EUR" });
    expect(second.preview_data.admin_schedule_sheet.rows[0].evaluator_values.owner).toBe(1000);
    const proof = currencyConversionForSave(source, source.preview_data, second.preview_data, "asset");
    expect(convertedAuthoritativeAssetPreview(source.preview_data, proof).admin_schedule_sheet.rows[0].evaluator_values.owner).toBe(1000);
  });
  it("does not reapply or expire historical saved conversion metadata on ordinary edits", async () => {
    const source = report(); const first = await convertReportPreviewCurrency({ report: source, kind: "asset", previewData: source.preview_data, targetCurrency: "USD" });
    const saved = { ...source, currency: "USD", preview_data: first.preview_data, updatedAt: new Date("2026-10-30T12:01:00Z"), proposal_valuation_revision: 4 };
    vi.setSystemTime(new Date("2026-10-30T14:00:00Z"));
    const edited = { ...clone(saved.preview_data), owner_name: "New owner" };
    expect(currencyConversionForSave(saved, saved.preview_data, edited, "asset")).toBeNull();
    expect(edited.admin_schedule_sheet.rows[0].evaluator_values.owner).toBe(500);
    mock.create.mockResolvedValueOnce(response("USD", "JPY", 100));
    const second = await convertReportPreviewCurrency({ report: saved, kind: "asset", previewData: edited, targetCurrency: "JPY" });
    expect(second.preview_data.admin_schedule_sheet.rows[0].evaluator_values.owner).toBe(50000);
  });
  it.each(["updatedAt", "revision", "preview", "report", "kind", "token", "quote", "currency"])("refuses a stale/tampered %s proof", async fault => {
    const source = report(), result = await convertReportPreviewCurrency({ report: source, kind: "asset", previewData: source.preview_data, targetCurrency: "USD" });
    let kind: any = "asset";
    if (fault === "updatedAt") source.updatedAt = new Date("2026-10-30T11:00:01Z");
    if (fault === "revision") source.proposal_valuation_revision++;
    if (fault === "preview") source.preview_data.contract_no = "Changed";
    if (fault === "report") source._id = "6ac42c820fdba415dd5f4b4c";
    if (fault === "kind") kind = "lotListing";
    if (fault === "token") result.preview_data.currency_conversion.token += "x";
    if (fault === "quote") result.preview_data.currency_conversion.quote.rate = 999;
    if (fault === "currency") result.preview_data.currency = "EUR";
    expect(() => currencyConversionForSave(source, source.preview_data, result.preview_data, kind)).toThrow();
  });
  it("refuses malformed money before lookup instead of changing it to zero", async () => {
    const source = report(); source.preview_data.lots[0].estimated_value = "CAD 123 to 456";
    await expect(convertReportPreviewCurrency({ report: source, kind: "asset", previewData: source.preview_data, targetCurrency: "USD" })).rejects.toThrow(/cannot be converted safely/);
    expect(mock.create).not.toHaveBeenCalled();
  });
  it.each([
    { rate: 0 }, { rate: -1 }, { rate: 1e99 }, { asOf: "2026-10-10" }, { asOf: "2026-10-31" },
    { sourceUrl: "https://bankofcanada.ca.evil.test/rate" }, { sourceUrl: "http://www.bankofcanada.ca/rate" },
    { sourceUrl: "https://www.bankofcanada.ca/unconsulted" }, { fromCurrency: "USD" }, { toCurrency: "CAD" },
  ])("refuses unsupported, stale or unattributed provider rates %j", async overrides => {
    mock.create.mockResolvedValue(response("CAD", "USD", .5, overrides));
    await expect(lookupCurrentCurrencyQuote("CAD", "USD")).rejects.toMatchObject({ statusCode: 503, code: "CURRENCY_RATE_UNAVAILABLE" });
  });
  it("requires actual web-search output and a completed provider result", async () => {
    mock.create.mockResolvedValue({ ...response(), output: [] });
    await expect(lookupCurrentCurrencyQuote("CAD", "USD")).rejects.toThrow();
    mock.create.mockResolvedValue({ ...response(), status: "incomplete" });
    await expect(lookupCurrentCurrencyQuote("CAD", "USD")).rejects.toThrow();
    mock.create.mockRejectedValue(new Error("Sensitive provider failure"));
    await expect(lookupCurrentCurrencyQuote("CAD", "USD")).rejects.toThrow("Your report is unchanged");
  });
});
