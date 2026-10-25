import { describe, expect, it } from "vitest";
import { previewQueueSummary } from "../src/utils/previewQueueSummary.js";
import { resolveReportGenerationStateForProfile } from "../src/utils/reportFileState.js";

describe("compact owner preview queue", () => {
  it.each(["asset", "lotListing"] as const)("keeps %s workflow, counts and saved-preview access without transmitting 5000-photo manifests", kind => {
    const images = Array.from({ length: 5000 }, (_, i) => `https://example.test/original/${i}.jpg`);
    const raw = { _id: "owned-report", status: "error", job_status: "error", contract_no: "94677", imageUrls: images,
      preview_data: { client_name: "Preview owner", lots: Array.from({ length: 25 }, (_, i) => ({ title: "PRIVATE LONG DETAILS", image_urls: images.slice(i * 200, (i + 1) * 200) })) },
      files: {}, preview_files: {}, source_details: { private: "DO NOT SEND" }, activity_outbox: [{ private: "DO NOT SEND" }] };
    const row = previewQueueSummary({ ...raw, ...resolveReportGenerationStateForProfile(kind, raw) }, kind);
    expect(row).toMatchObject({ _id: raw._id, status: "error", preview_available: true, lot_count: 25, image_count: 5000, thumbnail_url: images[0] });
    expect(row.preview_data.client_name).toBe("Preview owner");
    expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThan(2000);
    expect(JSON.stringify(row)).not.toMatch(/PRIVATE|DO NOT SEND|image_urls|activity_outbox/);
    expect(raw.imageUrls).toHaveLength(5000); expect(raw.preview_data.lots).toHaveLength(25);
  });
  it("retains accepted processing reports and independent identities under one contract", () => {
    const rows = Array.from({ length: 5 }, (_, i) => {
      const raw = { _id: `report-${i}`, status: "processing", job_status: "queued", generation_target_status: "approved", contract_no: "shared" };
      return previewQueueSummary({ ...raw, ...resolveReportGenerationStateForProfile("lotListing", raw) }, "lotListing");
    });
    expect(new Set(rows.map(row => row._id)).size).toBe(5);
    expect(rows.every(row => row.workflow_stage === "generating_files" && row.generation_target_status === "approved")).toBe(true);
  });
  it("does not revive explicitly cleared preview lots from old root data", () => {
    expect(previewQueueSummary({ preview_data: { lots: [] }, lots: [{ title: "old" }] }, "lotListing").lot_count).toBe(0);
    expect(previewQueueSummary({ lots: [{ title: "legacy" }] }, "lotListing").lot_count).toBe(1);
  });
});
