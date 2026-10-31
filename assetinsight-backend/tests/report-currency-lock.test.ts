/**
 * Owner, 2026-10-31: the preview currency conversion was removed; a report
 * keeps the currency it was valued in. See utils/reportCurrencyLock.ts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
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

  it("ignores a currency change on save and strips the removed conversion's fields", () => {
    const next: Record<string, any> = {
      currency: "EUR", lots: [{ estimated_value: "1000" }],
      currency_conversion: { token: "old-receipt" }, _currency_base_revision: "old-revision",
    };
    keepSavedReportCurrency({ currency: "CAD" }, { currency: "USD" }, next);
    expect(next).toEqual({ currency: "USD", lots: [{ estimated_value: "1000" }] });
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
