import { describe, expect, it } from "vitest";
import { getDeviceDecisionEmailHtml } from "../src/utils/deviceDecisionEmailHtml.js";

describe("device decision email", () => {
  it("renders a polished approval email with escaped device and support details", () => {
    const html = getDeviceDecisionEmailHtml({
      approved: true,
      deviceName: 'Samsung <S22> & "Work"',
      supportName: "Asset Insight Support",
      supportEmail: "support@example.test",
      supportPhone: "+1 (306) 555-0199",
      webAppUrl: "https://app.example.test/base/",
    });

    expect(html).toContain("Device approved");
    expect(html).toContain("Your device is ready to use");
    expect(html).toContain("Samsung &lt;S22&gt; &amp; &quot;Work&quot;");
    expect(html).toContain('href="https://app.example.test/base/device-access"');
    expect(html).toContain('href="mailto:support@example.test"');
    expect(html).toContain('href="tel:+13065550199"');
    expect(html).toContain("Security notice");
    expect(html).not.toContain("Samsung <S22>");
  });

  it("renders the rejected state and safely escapes an administrator reason", () => {
    const html = getDeviceDecisionEmailHtml({
      approved: false,
      deviceName: "Unknown browser",
      reason: '<script>alert("no")</script>',
    });

    expect(html).toContain("Device request rejected");
    expect(html).toContain("Administrator note");
    expect(html).toContain("&lt;script&gt;alert(&quot;no&quot;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("Review device access");
  });

  it("falls back to the production device access URL for an unsafe configured URL", () => {
    const html = getDeviceDecisionEmailHtml({
      approved: true,
      deviceName: "Chrome",
      webAppUrl: "javascript:alert(1)",
    });

    expect(html).toContain('href="https://assetinsightvaluator.com/device-access"');
    expect(html).not.toContain('href="javascript:');
  });
});
