import { describe, expect, it } from "vitest";
import { crmEmailHref, crmEmailPlainText, crmPhoneOptions, crmSocialLinks, crmWebsite } from "./crmDetailHelpers";

describe("CRM contact and email helpers", () => {
  it("ignores placeholder phones while preserving a raw primary, deduplicating and keeping extensions", () => {
    expect(crmPhoneOptions({ phoneFormatted: "Researching...", phoneRaw: "+1 (306) 555-0123", contactPhones: ["306-555-0123", "306-555-0123 ext. 25", "pending"] })).toEqual([
      { label: "Primary", value: "+1 (306) 555-0123", href: "tel:+13065550123" },
      { label: "Contact 2", value: "306-555-0123 ext. 25", href: "tel:3065550123,25" },
    ]);
  });
  it("rejects executable and credential URLs", () => {
    expect(crmWebsite("javascript:alert(1)")).toBeUndefined();
    expect(crmWebsite("https://user:pass@example.test")).toBeUndefined();
    expect(crmWebsite("example.test")).toBe("https://example.test/");
  });
  it("links native social handles and bare domains without executable or ambiguous links", () => {
    expect(crmSocialLinks("instagram: @asset.insight; www.linkedin.com/company/equipment; x: equipment; example.test; javascript:alert(1); @unknown")).toEqual([
      "https://instagram.com/asset.insight", "https://www.linkedin.com/company/equipment", "https://x.com/equipment", "https://example.test/",
    ]);
  });
  it("converts returned HTML to editable text without interpreting scripts or embedded media", () => {
    expect(crmEmailPlainText('<p>Hello &amp; welcome</p><script>bad()</script><p>Review<br>details.</p><img src="https://example.test/pixel">')).toBe("Hello & welcome\n\nReview\ndetails.");
    expect(crmEmailPlainText("A < B and &#x1F600; &lt;literal&gt;")).toBe("A < B and 😀 <literal>");
  });
  it("creates an encoded email handoff and prevents recipient header injection", () => {
    expect(() => crmEmailHref("a@example.test\nBcc:b@example.test", "Subject", "Body", { id: "owner" })).toThrow(/recipient/);
    const url = crmEmailHref("a@example.test", "Review\nrequest", "First\nSecond", { id: "owner", name: "Agent", company: "Company" });
    expect(url).toBe("mailto:a%40example.test?subject=Review%20request&body=First%0ASecond%0A%0A%E2%80%94%0AAgent%0ACompany");
  });
});
