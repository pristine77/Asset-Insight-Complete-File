/**
 * Owner, 2026-10-31: "US sales come through as USD" and "ensure the valuation
 * is done in the right currency". Auctioneer 2.0 now sends each contract's
 * sale currency; reports from that contract start in it, and the valuation
 * prompts value in the report's currency.
 */
import { describe, expect, it } from "vitest";
import {
  auctioneerSaleCurrency,
  normalizeAuctioneer2Contract,
  savedContractCurrency,
} from "../src/service/auctioneer2IntegrationService.js";
import { applyCanonicalAuctioneerDetails } from "../src/service/auctioneerReportLinkService.js";

describe("the sale currency from Auctioneer 2.0", () => {
  it("is read from the contract, upper-cased, and only as a three-letter code", () => {
    expect(normalizeAuctioneer2Contract({ id: "c-1", contractNumber: "825639", currency: "usd" })?.currency).toBe("USD");
    expect(normalizeAuctioneer2Contract({ id: "c-1", contractNumber: "825639", currency: "CAD" })?.currency).toBe("CAD");
    expect(normalizeAuctioneer2Contract({ id: "c-1", contractNumber: "825639" })?.currency).toBeUndefined();
    expect(auctioneerSaleCurrency({ currency: "US dollars" })).toBeUndefined();
    expect(auctioneerSaleCurrency({ currency: 1 })).toBeUndefined();
    expect(auctioneerSaleCurrency(null)).toBeUndefined();
  });

  it("is kept for a claimed item, falling back to the frozen raw contract for older items", () => {
    expect(savedContractCurrency({ contract: { currency: "USD" }, snapshot: { contract: { currency: "CAD" } } })).toBe("USD");
    expect(savedContractCurrency({ contract: {}, snapshot: { contract: { currency: "usd" } } })).toBe("USD");
    expect(savedContractCurrency({ contract: {}, snapshot: {} })).toBeUndefined();
  });

  it("starts a report in the sale's currency when the form sent none, and never overrides one it sent", () => {
    // The same shape auctioneer2-report-link.test.ts uses for a Schedule A item.
    const item = (currency?: string) => ({
      _id: "68a12c24f3c7f07935f6d111",
      kind: "scheduleA",
      selectedReportType: "asset",
      clientSubmissionId: "auctioneer2-deterministic",
      contract: { id: "contract-1", contractNo: "C-100", eventDate: "2026-08-12", ...(currency ? { currency } : {}) },
      snapshot: { lots: [{ sourceKey: "opaque-source-1", lotId: "lot-1", submissionId: "submission-1" }] },
    }) as any;
    const details = (extra: Record<string, unknown> = {}): Record<string, any> =>
      ({ mixed_lots: [{ count: 1, source_key: "opaque-source-1" }], ...extra });

    const fromSale = details();
    applyCanonicalAuctioneerDetails(fromSale, item("USD"));
    expect(fromSale.currency).toBe("USD");

    const chosen = details({ currency: "CAD" });
    applyCanonicalAuctioneerDetails(chosen, item("USD"));
    expect(chosen.currency).toBe("CAD");

    const unknown = details();
    applyCanonicalAuctioneerDetails(unknown, item());
    expect(unknown.currency).toBe("CAD");
  });
  it.each(["asset", "lotListing"])("uses the same raw frozen sale currency for setup and canonical %s creation on an older claim", (selectedReportType) => {
    const item: any = {
      _id: "68a12c24f3c7f07935f6d111", kind: "scheduleA", selectedReportType,
      clientSubmissionId: "old-claim", contract: { id: "contract-1", contractNo: "C-100" },
      snapshot: { contract: { saleCurrency: " usd " }, lots: [{ sourceKey: "opaque-source-1", lotId: "lot-1", submissionId: "submission-1" }] },
    };
    const details: Record<string, any> = { mixed_lots: [{ count: 1, source_key: "opaque-source-1" }] };
    expect(savedContractCurrency(item)).toBe("USD");
    applyCanonicalAuctioneerDetails(details, item);
    expect(details.currency).toBe(savedContractCurrency(item));
    const explicit = { ...details, currency: "CAD" };
    applyCanonicalAuctioneerDetails(explicit, item);
    expect(explicit.currency).toBe("CAD");
    item.snapshot.contract = { currency: "not a currency" };
    const unknown: Record<string, any> = { mixed_lots: [{ count: 1, source_key: "opaque-source-1" }] };
    applyCanonicalAuctioneerDetails(unknown, item);
    expect(unknown.currency).toBe("CAD");
  });

});
