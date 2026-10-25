import { describe, expect, it } from "vitest";
import { salvageApprovalAcknowledgement } from "../src/service/salvageApprovalReview.js";

const parent = (stale = false) => ({ revision: 4, preview_data: { assessment: {
  schemaVersion: 2, stale, limitations: [
    { code: "pre_loss_insufficient", acknowledgementRequired: true },
    { code: "disclaimer", acknowledgementRequired: false },
  ],
} } });
const input = { baseRevision: 4, limitationCodes: ["pre_loss_insufficient"], note: "Inspected supplied evidence; the pre-loss conclusion remains unavailable." };
describe("Salvage approval evidence acknowledgement", () => {
  it("preserves legacy approval without inventing an assessment", () => {
    expect(salvageApprovalAcknowledgement(null, undefined, "admin")).toBeUndefined();
    expect(salvageApprovalAcknowledgement({ revision: 1, preview_data: {} }, {}, "admin")).toBeUndefined();
  });
  it.each([undefined, {}, { ...input, baseRevision: 3 }, { ...input, limitationCodes: [] },
    { ...input, limitationCodes: ["pre_loss_insufficient", "not_current"] },
    { ...input, note: " " }, { ...input, note: "x".repeat(2001) }])("rejects absent, stale or incomplete acknowledgement: %j", (raw) => {
    expect(() => salvageApprovalAcknowledgement(parent(), raw, "admin"))
      .toThrow(expect.objectContaining({ code: "SALVAGE_REVIEW_ACKNOWLEDGEMENT_REQUIRED", statusCode: 409 }));
  });
  it("records the server reviewer and time, ignoring forged identity fields", () => {
    const now = new Date("2026-09-08T12:00:00Z");
    expect(salvageApprovalAcknowledgement(parent(), { ...input, reviewed_by: "forged", reviewed_at: "yesterday" }, "admin", now))
      .toEqual({ revision: 4, limitation_codes: ["pre_loss_insufficient"], note: input.note, reviewed_by: "admin", reviewed_at: now });
  });
  it("requires explicit stale-research acceptance too", () => {
    expect(() => salvageApprovalAcknowledgement(parent(true), input, "admin")).toThrow();
    expect(salvageApprovalAcknowledgement(parent(true), { ...input, limitationCodes: [...input.limitationCodes, "research_stale"] }, "admin")?.limitation_codes)
      .toEqual(["pre_loss_insufficient", "research_stale"]);
  });
});
