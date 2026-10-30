import { describe, expect, it } from "vitest";
import { currencyForReportLocation, normalizeReportCurrency, reportCurrencyOptions } from "./reportCurrency";

describe("report currencies", () => {
  it.each([["Regina, Saskatchewan, Canada", "CAD"], ["Alvarado, Texas", "USD"], ["London, United Kingdom", "GBP"], ["Dublin, Ireland", "EUR"], ["Delhi, India", "INR"], ["Sydney, Australia", "AUD"], ["Auckland, New Zealand", "NZD"]])("recognizes explicit location %s", (location, currency) => {
    expect(currencyForReportLocation(location)).toBe(currency);
  });
  it("leaves ambiguous city-only locations unchanged", () => {
    expect(currencyForReportLocation("London")).toBeUndefined();
    expect(currencyForReportLocation("Paris")).toBeUndefined();
    expect(currencyForReportLocation(undefined)).toBeUndefined();
    expect(currencyForReportLocation("Canada / United States border")).toBeUndefined();
    expect(currencyForReportLocation("Ontario, California, United States")).toBe("USD");
    expect(currencyForReportLocation("Belfast, Northern Ireland")).toBe("GBP");
    expect(currencyForReportLocation("Santa Fe, New Mexico, United States")).toBe("USD");
  });
  it("retains legacy ISO codes alongside normal dropdown options", () => {
    expect(reportCurrencyOptions("ZWL")).toContain("ZWL");
    expect(reportCurrencyOptions("CAD").filter(code => code === "CAD")).toHaveLength(1);
    expect(normalizeReportCurrency(" gbp ")).toBe("GBP");
    expect(normalizeReportCurrency("dollars")).toBe("");
  });
});
