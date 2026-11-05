import { beforeEach, describe, expect, it, vi } from "vitest";
import API from "@/lib/api";
import { getInitialPreviewRetry, retryInitialPreview } from "./initialPreviewRetry";
vi.mock("@/lib/api", () => ({ default: { get: vi.fn(), post: vi.fn() } }));
const revision = "a".repeat(64);
const signal = new AbortController().signal;
beforeEach(() => vi.clearAllMocks());
describe("same-report initial preview retry", () => {
  it.each(["asset", "lotListing"] as const)("uses a bounded revision-only %s mutation without 401 replay", async kind => {
    vi.mocked(API.post).mockResolvedValue({ status: 202, data: { data: { reportId: "report-1", retry_stage: "initial_preview", job_status: "queued" } } });
    await expect(retryInitialPreview(kind, "report-1", revision, signal)).resolves.toBe("queued");
    expect(API.post).toHaveBeenCalledExactlyOnceWith(`/${kind === "asset" ? "asset" : "lot-listing"}/report-1/retry-preview`, { baseRevision: revision }, { signal, timeout: 60_000, _retry: true });
  });
  it.each([{ status: 200 }, { status: 202, data: { data: { reportId: "other", retry_stage: "initial_preview", job_status: "queued" } } },
    { status: 202, data: { data: { reportId: "report-1", retry_stage: "files", job_status: "queued" } } },
    { status: 202, data: { data: { reportId: "report-1", retry_stage: "initial_preview", job_status: "error" } } }])("rejects unconfirmed acceptance %#", async response => {
    vi.mocked(API.post).mockResolvedValue(response);
    await expect(retryInitialPreview("asset", "report-1", revision, signal)).rejects.toThrow("confirmation");
  });
  it("accepts a completed replay only when its saved preview is confirmed", async () => {
    vi.mocked(API.post).mockResolvedValue({ status: 202, data: { data: { reportId: "report-1", retry_stage: "initial_preview", job_status: "done", preview_available: true } } });
    await expect(retryInitialPreview("asset", "report-1", revision, signal)).resolves.toBe("ready");
  });
  it("does not expose an eligible action from a malformed capability", async () => {
    vi.mocked(API.get).mockResolvedValue({ data: { data: { initialPreviewRetryEligible: true, initialPreviewRetryRevision: "" } } });
    await expect(getInitialPreviewRetry("asset", "report-1", signal)).rejects.toThrow("availability");
  });
  it("rejects an invalid unavailable-reason value instead of rendering an object", async () => {
    vi.mocked(API.get).mockResolvedValue({ data: { data: { initialPreviewRetryEligible: false, initialPreviewRetryIneligibleReason: { details: "bad response" } } } });
    await expect(getInitialPreviewRetry("asset", "report-1", signal)).rejects.toThrow("availability");
  });
});
