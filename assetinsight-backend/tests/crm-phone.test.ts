import { describe, expect, it } from "vitest";

import {
  isCrmPhonePlaceholder,
  normalizeCrmPhone,
  normalizeCrmPhoneFields,
} from "../src/utils/crmPhone.js";

describe("CRM phone normalization", () => {
  it("rejects research placeholders and non-dialable values", () => {
    for (const value of ["Researching...", "Pending", "Unknown", "N/A", "No phone"]) {
      expect(isCrmPhonePlaceholder(value)).toBe(true);
      expect(normalizeCrmPhone(value)).toBeNull();
    }
    expect(normalizeCrmPhone("1234")).toBeNull();
  });

  it("promotes the first valid alternate when the primary is a placeholder", () => {
    const normalized = normalizeCrmPhoneFields({
      phoneRaw: "Researching...",
      contactPhones: ["204-857-4151", "204-857-4151"],
      contactMobilePhones: ["(204) 555-0100"],
    });

    expect(normalized.phoneRaw).toBe("204-857-4151");
    expect(normalized.phoneFormatted).toBe("+1 (204) 857-4151");
    expect(normalized.contactPhones).toEqual([]);
    expect(normalized.contactMobilePhones).toEqual(["(204) 555-0100"]);
  });

  it("preserves an explicit primary and deduplicates every alternate collection", () => {
    const normalized = normalizeCrmPhoneFields({
      phoneRaw: "+1 204 857 4151",
      contactPhones: ["204-857-4151", "204-555-0100 ext 4"],
      contactMobilePhones: ["204-555-0100 x4", "204-555-0199"],
      companyPhones: ["204-555-0199", "204-555-0188"],
    });

    expect(normalized.phoneRaw).toBe("+1 204 857 4151");
    expect(normalized.contactPhones).toEqual(["204-555-0100 ext 4"]);
    expect(normalized.contactMobilePhones).toEqual(["204-555-0199"]);
    expect(normalized.companyPhones).toEqual(["204-555-0188"]);
  });

  it("returns empty fields when no valid number exists", () => {
    expect(
      normalizeCrmPhoneFields({
        phoneRaw: "Pending",
        contactPhones: ["Unknown", "N/A"],
      })
    ).toEqual({
      phoneRaw: "",
      phoneFormatted: "",
      contactPhones: [],
      contactMobilePhones: [],
      companyPhones: [],
    });
  });
});
