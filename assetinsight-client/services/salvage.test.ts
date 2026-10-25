import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AxiosProgressEvent } from "axios";
import API from "@/lib/api";
import { SALVAGE_MAX_IMAGES, SalvageService, type SalvageDetails, type SalvageAssessmentV2 } from "./salvage";

vi.mock("@/lib/api", () => ({ default: { post: vi.fn(), get: vi.fn(), patch: vi.fn() } }));

const details: SalvageDetails = {
  report_date: "2026-09-06", file_number: "SALVAGE-001", date_received: "2026-09-06",
  claim_number: "CLAIM-001", policy_number: "POLICY-001", appraiser_name: "Test Appraiser",
  appraiser_phone: "1234567890", appraiser_email: "appraiser@example.test", adjuster_name: "Adjuster",
  insured_name: "Insured", company_name: "Company", company_address: "Test address",
  appraiser_comments: "Test notes", next_report_due: "2026-09-07", language: "en", currency: "CAD",
};
const photos = (count: number) => Array.from({ length: count }, (_, index) =>
  new File([`photo-${index}`], `photo-${index}.jpg`, { type: "image/jpeg" }));

describe("SalvageService upload contract", () => {
  beforeEach(() => {
    vi.mocked(API.post).mockReset();
    vi.mocked(API.post).mockResolvedValue({ data: { jobId: "job-1", phase: "processing", message: "Accepted" } });
  });

  it.each([0, 1, 10, 11, 30, 31, 49, SALVAGE_MAX_IMAGES])("sends every selected image in order for %i photos", async (count) => {
    const images = photos(count);
    await expect(SalvageService.create(details, images)).resolves.toMatchObject({ jobId: "job-1", phase: "processing" });
    const [url, body] = vi.mocked(API.post).mock.calls[0];
    expect(url).toBe("/salvage");
    const formData = body as FormData;
    expect(JSON.parse(String(formData.get("details")))).toEqual(details);
    expect(formData.getAll("images").map((file) => (file as File).name)).toEqual(images.map((file) => file.name));
    expect(formData.getAll("images")).toHaveLength(count);
  });

  it("rejects over-limit submissions before posting instead of silently dropping images", async () => {
    await expect(SalvageService.create(details, photos(51))).rejects.toThrow("up to 50 images");
    expect(API.post).not.toHaveBeenCalled();
  });

  it("normalizes browser upload progress and leaves processing to the server", async () => {
    const onUploadProgress = vi.fn();
    await SalvageService.create(details, photos(1), { onUploadProgress });
    const listener = vi.mocked(API.post).mock.calls[0][2]?.onUploadProgress;
    listener?.({ loaded: 1, total: 4 } as AxiosProgressEvent);
    listener?.({ progress: 1.5 } as AxiosProgressEvent);
    listener?.({ progress: Number.NaN } as AxiosProgressEvent);
    expect(onUploadProgress.mock.calls.map(([fraction]) => fraction)).toEqual([0.25, 1, 0]);
  });
});

describe("SalvageService revision-safe lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(API.patch).mockResolvedValue({ data: { data: { _id: "report", revision: 2 } } });
    vi.mocked(API.post).mockResolvedValue({ data: { data: { _id: "report", revision: 2 } } });
    vi.mocked(API.get).mockResolvedValue({ data: { data: { _id: "report", revision: 2 } } });
  });

  it("sends only editable preview fields with the observed revision, not media or ownership", async () => {
    await SalvageService.savePreview("report/one", {
      file_number: "REVIEWED", year: "2020", valuation: { fairMarketValue: "CAD 1000" },
      item_condition: "Damaged", damage_description: "Left door", repair_facility: "Reviewed shop",
      actual_cash_value: 1200, recommended_reserve: 500, repair_estimate: { taxes: 20 },
      parts_subtotal: 99999, labour_total: 99999,
      user: "other-user", status: "approved", imageUrls: ["https://example.test/private.jpg"],
      aiExtractedDetails: { original: true }, comparableItems: [], revision: 100,
    }, 0);
    expect(API.patch).toHaveBeenCalledWith("/salvage/report%2Fone/preview", {
      data: { file_number: "REVIEWED", year: "2020", valuation: { fairMarketValue: "CAD 1000" },
        item_condition: "Damaged", damage_description: "Left door", repair_facility: "Reviewed shop",
        actual_cash_value: 1200, recommended_reserve: 500, repair_estimate: { taxes: 20 } }, baseRevision: 0,
    });
    expect(API.post).not.toHaveBeenCalled();
  });

  it("uses explicit submit/resubmit and retry of the same report, without another create", async () => {
    await SalvageService.submit("report", 3);
    await SalvageService.submit("report", 4, true);
    await SalvageService.retry("report");
    expect(vi.mocked(API.post).mock.calls).toEqual([
      ["/salvage/report/submit", { baseRevision: 3 }],
      ["/salvage/report/resubmit", { baseRevision: 4 }],
      ["/salvage/report/retry", {}],
    ]);
  });
  it("cancels the displayed generation and resumes stopped work with revision fencing", async () => {
    await SalvageService.cancel("report/one", 7, "current-job");
    await SalvageService.retry("report/one", 8);
    expect(vi.mocked(API.post).mock.calls).toEqual([
      ["/salvage/report%2Fone/cancel", { baseRevision: 7, jobId: "current-job" }],
      ["/salvage/report%2Fone/retry", { baseRevision: 8 }],
    ]);
  });

  it("saves editable assessment inputs but never provider-owned assessment results", async () => {
    await SalvageService.savePreview("report", { assessment_inputs: { province: "ON", market: "Toronto", odometer: null, vehicleOverrides: { engineModel: "Appraiser verified", vin: null } }, assessment: {} as SalvageAssessmentV2 }, 4);
    expect(API.patch).toHaveBeenCalledWith("/salvage/report/preview", { data: { assessment_inputs: { province: "ON", market: "Toronto", odometer: null, vehicleOverrides: { engineModel: "Appraiser verified", vin: null } } }, baseRevision: 4 });
    expect(API.post).not.toHaveBeenCalled();
  });

  it("sends only allowlisted report context with revision, never rendered enrichment", async () => {
    await SalvageService.savePreview("report", {
      report_context: { intended_use: "Insurance review", pre_loss_condition: null, scope_of_work: "" },
      report_enrichment: { schemaVersion: 1, sections: [] },
    }, 8);
    expect(API.patch).toHaveBeenCalledWith("/salvage/report/preview", { baseRevision: 8,
      data: { report_context: { intended_use: "Insurance review", pre_loss_condition: null, scope_of_work: "" } } });
    expect(API.post).not.toHaveBeenCalled();
  });

  it("uses the canonical authenticated list and preview endpoints", async () => {
    await SalvageService.getReports();
    await SalvageService.getPreview("report/one");
    expect(API.get).toHaveBeenNthCalledWith(1, "/salvage");
    expect(API.get).toHaveBeenNthCalledWith(2, "/salvage/report%2Fone/preview");
  });
  it("researches only through an explicit revision-bound request with stable retry identity", async () => {
    await SalvageService.research("report/one", 7, "research-attempt-1");
    await SalvageService.research("report/one", 7, "research-attempt-1");
    expect(API.post).toHaveBeenNthCalledWith(1, "/salvage/report%2Fone/research", { baseRevision: 7, client_request_id: "research-attempt-1" });
    expect(vi.mocked(API.post).mock.calls[1]).toEqual(vi.mocked(API.post).mock.calls[0]);
    expect(API.patch).not.toHaveBeenCalled();
  });
});
