/**
 * Owner, 2026-10-31: the preview currency conversion was removed; a report
 * keeps the currency it was valued in. See utils/reportCurrencyLock.ts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertSavedReportCurrency,
  keepSavedReportCurrency,
  previewWithReportCurrency,
  savedReportCurrency,
} from "../src/utils/reportCurrencyLock.js";

describe("a report keeps the currency it was valued in", () => {
  it("reads the saved preview's currency, else the report's, else CAD", () => {
    expect(savedReportCurrency({ currency: "CAD" }, { currency: "usd" })).toBe("USD");
    expect(savedReportCurrency({ currency: "usd" }, {})).toBe("USD");
    expect(savedReportCurrency(null, null)).toBe("CAD");
  });

  it("fills the currency into a preview for display", () => {
    expect(previewWithReportCurrency({ currency: "USD" }, { lots: [] })).toEqual({ lots: [], currency: "USD" });
    expect(previewWithReportCurrency({ currency: "USD" }, undefined)).toEqual({ currency: "USD" });
  });

  it.each(["EUR", "", "US dollars", null, 0, {}])("refuses explicit mismatched or invalid currency %j without mutating the candidate", (currency) => {
    const next = { currency, total_value: 0, lots: [{ estimated_value: "USD 500" }] };
    const before = structuredClone(next);
    expect(() => keepSavedReportCurrency({ currency: "USD" }, {}, next)).toThrow(/Reload the preview/);
    expect(next).toEqual(before);
  });

  it("refuses a new conversion receipt even if the label still matches", () => {
    expect(() => assertSavedReportCurrency({ currency: "CAD" }, {}, {
      currency: "CAD", currency_conversion: { token: "new-pending-conversion" },
    })).toThrow(expect.objectContaining({ code: "REPORT_CURRENCY_LOCKED", statusCode: 409 }));
  });

  it("keeps same-currency zero edits and permits old read markers or an unchanged historical receipt", () => {
    const historical = { token: "saved", quote: { fromCurrency: "USD", toCurrency: "CAD" } };
    const previous = { currency: "CAD", currency_conversion: historical };
    const next = { currency: " cad ", total_value: 0, lots: [{ estimated_value: "CAD 0" }],
      currency_conversion: structuredClone(historical), _currency_base_revision: "read-marker" };
    keepSavedReportCurrency({ currency: "USD" }, previous, next);
    expect(next).toEqual({ currency: "CAD", total_value: 0, lots: [{ estimated_value: "CAD 0" }] });
    expect(previewWithReportCurrency({ currency: "USD" }, previous)).toEqual({ currency: "CAD" });
    expect(previous.currency_conversion).toEqual(historical);
    const legacy: Record<string, any> = { lots: [], _currency_base_revision: "old-read-marker" };
    keepSavedReportCurrency({ currency: "USD" }, {}, legacy);
    expect(legacy).toEqual({ lots: [], currency: "USD" });
  });

  it("is applied on every Asset and Lot Listing preview save, and the conversion is gone", () => {
    const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
    expect(read("service/assetPreviewDataPersistenceService.ts")).toContain("keepSavedReportCurrency(input.report, previousPreviewData, submittedPreviewData);");
    expect(read("utils/lotListingPreviewPersistence.ts")).toContain("keepSavedReportCurrency(listing, listing?.preview_data, previewData);");
    expect(read("utils/assetPreviewRootSync.ts")).not.toMatch(/^\s*"currency",$/m);
    for (const routes of ["routes/asset.routes.ts", "routes/lotListing.routes.ts", "routes/pdfReport.routes.ts"]) {
      expect(read(routes)).not.toContain("currency-conversion");
    }
  });
});
