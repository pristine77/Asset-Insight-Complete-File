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
    expect(currencyForReportLocation("Manchester, Great Britain")).toBe("GBP");
    expect(currencyForReportLocation("Santa Fe, New Mexico, United States")).toBe("USD");
  });
  /*
   * Owner, 2026-10-31: CAD and USD reports were not told apart reliably. Typed
   * addresses rarely name the country, so postal/ZIP codes, provinces/states
   * and ", SK" style codes decide; anything pointing both ways decides nothing.
   */
  it.each([
    ["Regina, SK", "CAD"],
    ["Regina, SK S4P 3Y2", "CAD"],
    ["2335 Lemieux Pl NW, Edmonton, AB T6R 0R6", "CAD"],
    ["Box 12, Moose Jaw S6H 4N8", "CAD"],
    ["Toronto, ON", "CAD"],
    ["Brandon, Manitoba", "CAD"],
    ["Charlottetown, Prince Edward Island", "CAD"],
    ["Yellowknife, Northwest Territories", "CAD"],
    ["Minot, ND 58701", "USD"],
    ["Billings, MT", "USD"],
    ["Sidney, Montana", "USD"],
    ["Fargo, North Dakota 58102", "USD"],
    ["Portland, OR 97201", "USD"],
    ["Spokane, WA, 99201", "USD"],
    ["Atlanta, GA 30301", "USD"],
    ["Santa Fe, New Mexico", "USD"],
  ])("tells a Canadian from a US address: %s", (location, currency) => {
    expect(currencyForReportLocation(location)).toBe(currency);
  });
  it("chooses nothing when the address points both ways or nowhere", () => {
    expect(currencyForReportLocation("Ontario, California")).toBeUndefined();
    expect(currencyForReportLocation("Delaware, Ontario")).toBeUndefined();
    expect(currencyForReportLocation("Regina")).toBeUndefined();
    expect(currencyForReportLocation("Atlanta, Georgia")).toBeUndefined();
    expect(currencyForReportLocation("turn left on the gravel road")).toBeUndefined();
    expect(currencyForReportLocation("Regina, SK, Minot, ND")).toBeUndefined();
    expect(currencyForReportLocation("London, Ontario, Canada")).toBe("CAD");
    expect(currencyForReportLocation("Mexico City, Mexico")).toBe("MXN");
  });
  it("retains legacy ISO codes alongside normal dropdown options", () => {
    expect(reportCurrencyOptions("ZWL")).toContain("ZWL");
    expect(reportCurrencyOptions("CAD").filter(code => code === "CAD")).toHaveLength(1);
    expect(normalizeReportCurrency(" gbp ")).toBe("GBP");
    expect(normalizeReportCurrency("dollars")).toBe("");
  });
});
