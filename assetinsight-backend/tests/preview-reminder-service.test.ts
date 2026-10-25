import { describe, expect, it } from "vitest";
import {
  buildPreviewReminderEmailHtml,
  getPreviewReminderEligibility,
} from "../src/service/previewReminderService.js";

const activeOwner = {
  _id: "66f000000000000000000001",
  username: "Report Owner",
  email: "owner@example.com",
  isBlocked: false,
};

describe("preview reminder eligibility", () => {
  it("allows a ready, unsubmitted preview with an active owner", () => {
    expect(
      getPreviewReminderEligibility({
        workflowStage: "preview_ready",
        owner: activeOwner,
      })
    ).toEqual({ eligible: true, reason: null });
  });

  it.each([
    ["processing", undefined, "Reminders can be sent after the preview is ready"],
    ["preview_ready", new Date("2026-08-14T10:00:00Z"), "already been submitted"],
  ])(
    "rejects stage %s or an already submitted preview",
    (workflowStage, previewSubmittedAt, expectedReason) => {
      const result = getPreviewReminderEligibility({
        workflowStage,
        previewSubmittedAt,
        owner: activeOwner,
      });

      expect(result.eligible).toBe(false);
      expect(result.reason).toContain(expectedReason);
    }
  );

  it("rejects blocked owners and owners without an email address", () => {
    expect(
      getPreviewReminderEligibility({
        workflowStage: "preview_ready",
        owner: { ...activeOwner, isBlocked: true },
      }).reason
    ).toContain("blocked");

    expect(
      getPreviewReminderEligibility({
        workflowStage: "preview_ready",
        owner: { ...activeOwner, email: "" },
      }).reason
    ).toContain("email address");
  });
});

describe("preview reminder email", () => {
  it("escapes custom content while retaining intentional paragraph breaks", () => {
    const html = buildPreviewReminderEmailHtml({
      owner: { ...activeOwner, username: "Owner <Admin>" },
      reportType: "Asset",
      contractNo: "CTR-<123>",
      waitingSince: new Date("2026-08-14T10:00:00Z"),
      message: "Please review <script>alert('x')</script>.\nThen submit it.\n\nThank you.",
      previewUrl: "https://example.com/previews?highlight=<id>",
    });

    expect(html).toContain("Owner &lt;Admin&gt;");
    expect(html).toContain("CTR-&lt;123&gt;");
    expect(html).toContain("Please review &lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;.<br/>Then submit it.");
    expect(html).toContain("Thank you.");
    expect(html).not.toContain("<script>");
    expect(html).toContain("https://example.com/previews?highlight=&lt;id&gt;");
  });
});
