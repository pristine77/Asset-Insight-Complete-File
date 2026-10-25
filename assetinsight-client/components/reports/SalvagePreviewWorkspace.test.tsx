import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SalvageService, type SalvageReport } from "@/services/salvage";
import { ReportsService } from "@/services/reports";
import SalvagePreviewWorkspace from "./SalvagePreviewWorkspace";

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));
vi.mock("@/services/salvage", async (original) => ({
  ...await original<typeof import("@/services/salvage")>(),
  SalvageService: { getPreview: vi.fn(), savePreview: vi.fn(), submit: vi.fn(), retry: vi.fn(), research: vi.fn() },
}));
vi.mock("@/services/reports", () => ({ ReportsService: { downloadReport: vi.fn() } }));

function report(overrides: Partial<SalvageReport> = {}): SalvageReport {
  return {
    _id: "salvage-1", file_number: "CLAIM-157", createdAt: "2026-09-07T10:00:00Z",
    status: "preview", revision: 2, workflow_stage: "preview_ready", downloadable: false,
    imageUrls: ["https://assetinsight.pro/original.jpg", "https://images.sellsnap.store/legacy.jpg"],
    preview_data: {
      file_number: "CLAIM-157", report_date: "2026-09-07", year: "2020", make: "Ford",
      appraiser_comments: "Original notes", valuation: { fairMarketValue: "CA$10,000", summary: "Original estimate" },
      repair_items: [{ name: "Door", quantity: 1, unit_price: 100, line_total: 100 }],
      labour_breakdown: [{ task: "Fit door", hours: 2, rate_per_hour: 50, line_total: 100 }],
    }, ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function open(value = report()) {
  vi.mocked(SalvageService.getPreview).mockResolvedValue({ data: value });
  render(<SalvagePreviewWorkspace reportId="salvage-1" />);
  await screen.findByDisplayValue("CLAIM-157");
}

describe("Salvage full-page review lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(SalvageService.getPreview).mockReset();
    vi.mocked(SalvageService.savePreview).mockReset();
    vi.mocked(SalvageService.submit).mockReset();
    vi.mocked(SalvageService.retry).mockReset();
    vi.mocked(SalvageService.research).mockReset();
    sessionStorage.clear();
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
  });

  it("requires explicit research confirmation and reuses the same paid-action ID after an unknown outcome", async () => {
    await open();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Research again" })));
    expect(SalvageService.research).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    vi.mocked(SalvageService.research).mockRejectedValueOnce(new Error("Connection lost; refresh or retry the same request."));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Research again" })));
    const first = vi.mocked(SalvageService.research).mock.calls[0];
    expect(first).toEqual(["salvage-1", 2, expect.any(String)]);
    vi.mocked(SalvageService.research).mockResolvedValue({ data: report({ status: "processing", workflow_stage: "preparing_preview" }) });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Research again" })));
    expect(vi.mocked(SalvageService.research).mock.calls[1]).toEqual(first);
    expect(screen.queryByRole("button", { name: "Research again" })).not.toBeInTheDocument();
    expect(navigation.push).toHaveBeenLastCalledWith("/salvage/status/salvage-1");
    expect(SalvageService.savePreview).not.toHaveBeenCalled();
    expect(SalvageService.submit).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("shows the saved data and all photos, saves once with its base revision without generating files", async () => {
    await open();
    expect(screen.getAllByRole("button", { name: /^View photo/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "View photo 2" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Photo 2 of 2");
    fireEvent.click(screen.getByRole("button", { name: "Close photo" }));
    fireEvent.change(screen.getByLabelText("Appraiser comments"), { target: { value: "Reviewed multiline\nnotes" } });
    expect(screen.getByRole("button", { name: "Submit report" })).toBeDisabled();
    const saving = deferred<{ data: SalvageReport }>();
    vi.mocked(SalvageService.savePreview).mockReturnValue(saving.promise);
    const save = screen.getByRole("button", { name: "Save changes" });
    act(() => { fireEvent.click(save); fireEvent.click(save); });
    expect(SalvageService.savePreview).toHaveBeenCalledTimes(1);
    expect(SalvageService.savePreview).toHaveBeenCalledWith("salvage-1", expect.objectContaining({ appraiser_comments: "Reviewed multiline\nnotes" }), 2);
    expect(screen.getByLabelText("Appraiser comments")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reports" })).toBeDisabled();
    await act(async () => saving.resolve({ data: report({ revision: 3, preview_data: { ...report().preview_data, appraiser_comments: "Reviewed multiline\nnotes" } }) }));
    expect(screen.getByText("Saved revision 3")).toBeVisible();
    expect(SalvageService.submit).not.toHaveBeenCalled();
    expect(SalvageService.retry).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Submit report" })).toBeEnabled();
  });

  it("retains edits after a failed save and after background refresh", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Appraiser comments"), { target: { value: "Do not lose this" } });
    vi.mocked(SalvageService.savePreview).mockRejectedValue(new Error("Temporarily unavailable"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save changes" })));
    expect(screen.getByRole("alert")).toHaveTextContent("Temporarily unavailable");
    vi.mocked(SalvageService.getPreview).mockResolvedValue({ data: report({ revision: 9 }) });
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(screen.getByLabelText("Appraiser comments")).toHaveValue("Do not lose this");
    expect(screen.getByRole("alert")).toHaveTextContent("Temporarily unavailable");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save changes" })));
    expect(vi.mocked(SalvageService.savePreview).mock.calls[1][2]).toBe(2);
  });

  it("previews computed line totals and saves editable condition/cost inputs without changing valuation", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "3" } });
    fireEvent.change(screen.getByLabelText("Hours"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Taxes"), { target: { value: "25" } });
    fireEvent.change(screen.getByLabelText("Damage description"), { target: { value: "Reviewed damage" } });
    fireEvent.change(screen.getByLabelText("Actual cash value"), { target: { value: "1200" } });
    expect(screen.getAllByLabelText("Line total").map((input) => (input as HTMLInputElement).value)).toEqual(["300", "200"]);
    for (const input of screen.getAllByLabelText("Line total")) expect(input).toHaveAttribute("readonly");
    expect(screen.getByLabelText("Parts subtotal")).toHaveValue(300);
    expect(screen.getByLabelText("Labour total")).toHaveValue(200);
    expect(screen.getByLabelText("Total repair estimate")).toHaveValue(525);
    expect(screen.getByLabelText("Fair market value")).toHaveValue("CA$10,000");
    vi.mocked(SalvageService.savePreview).mockResolvedValue({ data: report({ revision: 3 }) });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save changes" })));
    expect(SalvageService.savePreview).toHaveBeenCalledWith("salvage-1", expect.objectContaining({
      damage_description: "Reviewed damage", actual_cash_value: 1200, repair_estimate: { taxes: 25 },
      repair_items: [expect.objectContaining({ quantity: 3 })], labour_breakdown: [expect.objectContaining({ hours: 4 })],
    }), 2);
  });

  it("explains revision conflicts and requires an explicit reload before overwriting edits", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Year"), { target: { value: "2021" } });
    vi.mocked(SalvageService.savePreview).mockRejectedValue({ response: { data: { code: "SALVAGE_REVISION_CONFLICT" } } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save changes" })));
    expect(screen.getByRole("alert")).toHaveTextContent("Your edits are still here");
    expect(screen.getByLabelText("Year")).toHaveValue("2021");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Reload latest" }));
    expect(SalvageService.getPreview).toHaveBeenCalledTimes(1);
    confirm.mockReturnValue(true);
    vi.mocked(SalvageService.getPreview).mockResolvedValue({ data: report({ revision: 9 }) });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reload latest" })));
    expect(screen.getByText("Saved revision 9")).toBeVisible();
    expect(screen.getByLabelText("Year")).toHaveValue("2020");
  });

  it.each(["preview", "declined", "pending_approval", "approved"] as const)("uses the correct submission mode for %s and waits for server file readiness", async (status) => {
    await open(report({ status }));
    const resubmit = ["pending_approval", "approved"].includes(status);
    const response = deferred<{ data: SalvageReport }>();
    vi.mocked(SalvageService.submit).mockReturnValue(response.promise);
    const button = screen.getByRole("button", { name: resubmit ? "Resubmit report" : "Submit report" });
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    expect(SalvageService.submit).toHaveBeenCalledTimes(1);
    expect(SalvageService.submit).toHaveBeenCalledWith("salvage-1", 2, resubmit);
    await act(async () => response.resolve({ data: report({ status: "processing", workflow_stage: "generating_files", files_generating: true, workflow_progress_percent: 35 }) }));
    expect(navigation.push).toHaveBeenLastCalledWith("/salvage/status/salvage-1");
    expect(screen.queryByLabelText("Appraiser comments")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "PDF" })).not.toBeInTheDocument();
    expect(SalvageService.retry).not.toHaveBeenCalled();
    expect(SalvageService.savePreview).not.toHaveBeenCalled();
  });

  it("keeps an analysis failure accessible and retries the same report without a new upload", async () => {
    await open(report({ status: "error", workflow_stage: "error", generation_state: "error", job_error: "Analysis failed" }));
    vi.mocked(SalvageService.retry).mockResolvedValue({ data: report({ status: "processing", workflow_stage: "preparing_preview" }) });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry processing" })));
    expect(SalvageService.retry).toHaveBeenCalledExactlyOnceWith("salvage-1");
    expect(navigation.push).toHaveBeenLastCalledWith("/salvage/status/salvage-1");
  });
  it("does not expose an intake-only preview after stopping initial preparation", async () => {
    vi.mocked(SalvageService.getPreview).mockResolvedValue({ data: report({ status: "cancelled", generation_state: "cancelled", workflow_stage: "stopped", preview_available: false }) });
    render(<SalvagePreviewWorkspace reportId="salvage-1" />);
    await screen.findByRole("heading", { name: "Opening report progress" });
    expect(navigation.replace).toHaveBeenCalledWith("/salvage/status/salvage-1");
    expect(screen.queryByLabelText("Appraiser comments")).not.toBeInTheDocument();
    expect(SalvageService.retry).not.toHaveBeenCalled();
  });

  it("keeps unsaved edits visible if another device starts processing", async () => {
    await open();
    fireEvent.change(screen.getByLabelText("Appraiser comments"), { target: { value: "Do not hide my unsaved notes" } });
    vi.mocked(SalvageService.getPreview).mockResolvedValue({ data: report({ status: "processing", generation_state: "processing", workflow_stage: "generating_files", revision: 8 }) });
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(screen.getByLabelText("Appraiser comments")).toHaveValue("Do not hide my unsaved notes");
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("gates every file by server download permission and uses the PDF-record id for downloads", async () => {
    const files = { pdf: "pdf-id", docx: "docx-id", xlsx: "xlsx-id", images: "zip-id" };
    await open(report({ status: "approved", workflow_stage: "awaiting_release", files }));
    for (const name of ["PDF", "DOCX", "XLSX", "Photo ZIP"]) expect(screen.getByRole("button", { name })).toBeDisabled();
    vi.mocked(SalvageService.getPreview).mockResolvedValue({ data: report({ status: "approved", workflow_stage: "ready", files_ready: true, downloadable: true, files }) });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh" })));
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:test") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    vi.mocked(ReportsService.downloadReport).mockResolvedValue({ blob: new Blob(["file"]), filename: "report.pdf" });
    for (const [name, id] of [["PDF", "pdf-id"], ["DOCX", "docx-id"], ["XLSX", "xlsx-id"], ["Photo ZIP", "zip-id"]]) {
      await act(async () => fireEvent.click(screen.getByRole("button", { name })));
      expect(ReportsService.downloadReport).toHaveBeenLastCalledWith(id);
    }
  });

  it("ignores a delayed load for a different report and shows a retryable initial error", async () => {
    const old = deferred<{ data: SalvageReport }>();
    vi.mocked(SalvageService.getPreview).mockReturnValueOnce(old.promise).mockRejectedValueOnce(new Error("Not found or not allowed"));
    const { rerender } = render(<SalvagePreviewWorkspace reportId="old" />);
    rerender(<SalvagePreviewWorkspace reportId="new" />);
    await screen.findByRole("alert");
    await act(async () => old.resolve({ data: report() }));
    expect(screen.queryByDisplayValue("CLAIM-157")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Not found or not allowed");
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    await waitFor(() => expect(SalvageService.getPreview).toHaveBeenCalledTimes(2));
  });
});
