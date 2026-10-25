import assert from "node:assert/strict";
import test from "node:test";
import { buildSalvageReviewAcknowledgement, groupPendingApprovalRows, parseReportApprovalRequest,
  pendingApprovalBlockReason, releasesWithApproval, salvageApprovalReviewFromPreview } from "../lib/reportApprovalUiPolicy.ts";

test("only Real Estate and Salvage release with approval", () => {
  for (const reportType of ["RealEstate", "Real Estate", "Salvage"]) assert.equal(releasesWithApproval({ reportType }), true);
  for (const reportType of ["Asset", "LotListing", "", undefined]) assert.equal(releasesWithApproval({ reportType }), false);
});

test("Pdf siblings group once but retain an actionable artifact id", () => {
  const rows = groupPendingApprovalRows([
    { _id: "salvage-pdf", report: "salvage-parent", createdAt: "2026-09-07", reportType: "Salvage" },
    { _id: "salvage-docx", report: "salvage-parent", createdAt: "2026-09-07", reportType: "Salvage" },
    { _id: "re-preview", report: "re-preview", createdAt: "2026-09-06", reportType: "RealEstate" },
    { _id: "legacy-re-docx", report: "legacy-re-parent", createdAt: "2026-09-05", reportType: "RealEstate" },
  ]);
  assert.deepEqual(rows.map(row => row.actionId), ["salvage-pdf", "re-preview", "legacy-re-docx"]);
});

test("incomplete/processing files cannot be approved; legacy absent flags remain server-authorized", () => {
  for (const state of [{ files_generating: true }, { files_regenerating: true }, { files_ready: false }, { generation_state: "processing" }, { generation_state: "ready", job_status: "queued" }, { workflow_stage: "error" }]) {
    assert.ok(pendingApprovalBlockReason(state));
  }
  assert.equal(pendingApprovalBlockReason({ files_ready: true, generation_state: "ready" }), null);
  assert.equal(pendingApprovalBlockReason({}), null);
});

const preview = (assessment = {}) => ({ revision: 7, data: { assessment: {
  schemaVersion: 2, stale: false, limitations: [
    { code: "INSUFFICIENT_EVIDENCE", message: "Insufficient sold evidence.", acknowledgementRequired: true },
    { code: "INFORMATION_ONLY", message: "Review source links.", acknowledgementRequired: false },
  ], ...assessment,
} } });

test("legacy previews require no enterprise acknowledgement, malformed previews do not downgrade to legacy", () => {
  assert.equal(salvageApprovalReviewFromPreview({ revision: 0, data: { item_type: "Legacy vehicle" } }), null);
  for (const bad of [{}, { data: [] }, { data: { assessment: {} } }, { data: { assessment: [] } },
    { ...preview(), revision: undefined }, { ...preview(), revision: -1 }, preview({ schemaVersion: 3 }),
    preview({ limitations: [{ code: "MISSING", acknowledgementRequired: true }] }),
    preview({ limitations: [{ code: "MISSING", message: "Missing data" }] })]) {
    assert.throws(() => salvageApprovalReviewFromPreview(bad));
  }
});

test("every current limitation and a note are required and bound to the loaded revision", () => {
  const review = salvageApprovalReviewFromPreview(preview());
  assert.deepEqual(review, { baseRevision: 7, limitations: [{ code: "INSUFFICIENT_EVIDENCE", message: "Insufficient sold evidence." }], requiredLimitationCodes: ["INSUFFICIENT_EVIDENCE"] });
  assert.equal(buildSalvageReviewAcknowledgement(review, [], "I reviewed the evidence."), null);
  assert.equal(buildSalvageReviewAcknowledgement(review, ["INSUFFICIENT_EVIDENCE"], " "), null);
  assert.equal(buildSalvageReviewAcknowledgement(review, ["INSUFFICIENT_EVIDENCE"], "x".repeat(2001)), null);
  assert.deepEqual(buildSalvageReviewAcknowledgement(review, ["INSUFFICIENT_EVIDENCE"], " Reviewed the limitations. "), {
    baseRevision: 7, limitationCodes: ["INSUFFICIENT_EVIDENCE"], note: "Reviewed the limitations.",
  });
  // A stale-error state removes the loaded review, making old checkbox state unusable.
  assert.equal(buildSalvageReviewAcknowledgement(null, ["INSUFFICIENT_EVIDENCE"], "Previous note"), null);
});

test("stale research is acknowledged once visually while forwarding both compatible server codes", () => {
  const review = salvageApprovalReviewFromPreview(preview({ stale: true, limitations: [
    { code: "RESEARCH_STALE", message: "Research is stale.", acknowledgementRequired: true },
  ] }));
  assert.deepEqual(review.limitations, [{ code: "RESEARCH_STALE", message: "Research is stale." }]);
  assert.deepEqual(buildSalvageReviewAcknowledgement(review, ["RESEARCH_STALE"], "Reviewed the changed inputs.")?.limitationCodes, ["RESEARCH_STALE", "research_stale"]);
  const synthetic = salvageApprovalReviewFromPreview(preview({ stale: true, limitations: [] }));
  assert.equal(buildSalvageReviewAcknowledgement(synthetic, [], "Reviewed"), null);
  assert.equal(synthetic.limitations[0].code, "research_stale");
});

test("an evidence-complete assessment still binds approval to its loaded revision", () => {
  const review = salvageApprovalReviewFromPreview(preview({ limitations: [] }));
  assert.deepEqual(buildSalvageReviewAcknowledgement(review, [], ""), { baseRevision: 7, limitationCodes: [], note: "" });
});

test("BFF decision parsing forwards only the typed acknowledgement and never actor or audit authority", () => {
  assert.deepEqual(parseReportApprovalRequest({}), {});
  assert.deepEqual(parseReportApprovalRequest({ reviewed_by: "forged", salvageReviewAcknowledgement: {
    baseRevision: 7, limitationCodes: ["B", "A", "B"], note: " Approved with documented limitations. ", reviewed_by: "forged",
  } }), { salvageReviewAcknowledgement: { baseRevision: 7, limitationCodes: ["A", "B"], note: "Approved with documented limitations." } });
  for (const bad of [null, [], "invalid", { salvageReviewAcknowledgement: null },
    { salvageReviewAcknowledgement: { baseRevision: "7", limitationCodes: [], note: "" } },
    { salvageReviewAcknowledgement: { baseRevision: 7, limitationCodes: [3], note: "" } },
    { salvageReviewAcknowledgement: { baseRevision: 7, limitationCodes: ["unsafe code"], note: "" } },
    { salvageReviewAcknowledgement: { baseRevision: 7, limitationCodes: [], note: "x".repeat(2001) } }]) {
    assert.throws(() => parseReportApprovalRequest(bad));
  }
});
