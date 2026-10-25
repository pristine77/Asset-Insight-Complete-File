import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SalvageService, type SalvageReport } from "@/services/salvage";
import SalvageProgressWorkspace from "./SalvageProgressWorkspace";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));
vi.mock("@/services/salvage", async (original) => ({ ...await original<typeof import("@/services/salvage")>(), SalvageService: {
  getPreview: vi.fn(), cancel: vi.fn(), retry: vi.fn(),
} }));
function report(patch: Partial<SalvageReport> = {}): SalvageReport {
  return { _id: "salvage-1", file_number: "SALVAGE-001", revision: 2, status: "processing", createdAt: "2026-09-09T00:00:00Z",
    generation_state: "processing", workflow_stage: "preparing_preview", workflow_message: "GPT-6-astra AI processing using OpenAI",
    imageUrls: ["https://assetinsight.pro/original.jpg"], preview_data: { file_number: "SALVAGE-001" },
    preview_available: false, can_cancel: true, job_id: "job-a", workflow_progress_percent: 42,
    workflow_steps: [{ key: "upload", label: "Upload received", status: "completed" }, { key: "photos", label: "AI photo review", status: "active" }, { key: "preview", label: "Prepare preview", status: "pending" }],
    ...patch };
}
const stopped = (preview = true, patch: Partial<SalvageReport> = {}) => report({ status: "cancelled", generation_state: "cancelled", workflow_stage: "stopped", workflow_message: "Processing stopped", revision: 3,
  preview_available: preview, can_cancel: false, workflow_steps: [{ key: "upload", label: "Upload received", status: "completed" }, { key: "photos", label: "Photo review", status: "cancelled" }], ...patch });
async function open(snapshot = report()) {
  vi.mocked(SalvageService.getPreview).mockResolvedValue({ data: snapshot });
  render(<SalvageProgressWorkspace reportId="salvage-1" />);
  await screen.findByText("SALVAGE-001");
}
describe("durable Salvage progress and cancellation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(SalvageService.getPreview).mockReset(); vi.mocked(SalvageService.cancel).mockReset(); vi.mocked(SalvageService.retry).mockReset();
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });
  it("shows actual saved steps, strips implementation labels and never auto-opens a ready preview", async () => {
    await open();
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "42");
    expect(screen.getByRole("list", { name: "Report processing steps" }).querySelectorAll('li[data-state="completed"]')).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Open preview" })).toBeDisabled();
    expect(document.body.textContent).not.toMatch(/\bAI\b|OpenAI|GPT-/);
    vi.mocked(SalvageService.getPreview).mockResolvedValue({ data: report({ status: "preview", generation_state: "ready", workflow_stage: "preview_ready", preview_available: true, can_cancel: false }) });
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(screen.getByRole("button", { name: "Open preview" })).toBeEnabled();
    expect(navigation.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open preview" }));
    expect(navigation.push).toHaveBeenCalledWith("/salvage/preview/salvage-1");
  });
  it("fences stop to the displayed job/revision and prevents duplicate same-tick requests", async () => {
    await open(report({ preview_available: true, workflow_stage: "generating_files" }));
    let finish!: (value: { data: SalvageReport }) => void;
    vi.mocked(SalvageService.cancel).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const button = screen.getByRole("button", { name: "Stop processing" });
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    expect(SalvageService.cancel).toHaveBeenCalledExactlyOnceWith("salvage-1", 2, "job-a");
    expect(screen.getByRole("button", { name: "Stopping…" })).toBeDisabled();
    await act(async () => finish({ data: stopped() }));
    expect(screen.getByRole("button", { name: "Open preview" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Stop processing" })).not.toBeInTheDocument();
    expect(navigation.push).not.toHaveBeenCalled();
  });
  it("resumes stopped originals and stops a subsequent run using its new identity", async () => {
    await open(stopped(false));
    expect(screen.getByText(/first preview was not completed/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Open preview" })).toBeDisabled();
    vi.mocked(SalvageService.retry).mockResolvedValue({ data: report({ revision: 4, job_id: "job-b" }) });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Resume processing" })));
    expect(SalvageService.retry).toHaveBeenCalledExactlyOnceWith("salvage-1", 3);
    vi.mocked(SalvageService.cancel).mockResolvedValue({ data: stopped(false, { revision: 5, job_id: "job-b" }) });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop processing" })));
    expect(SalvageService.cancel).toHaveBeenCalledExactlyOnceWith("salvage-1", 4, "job-b");
    expect(screen.getByText("Saved revision 5")).toBeVisible();
  });
  it("requires a refresh on concurrent generation changes before stopping the current run", async () => {
    await open();
    vi.mocked(SalvageService.cancel).mockRejectedValue({ response: { data: { code: "SALVAGE_GENERATION_CONFLICT" } } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop processing" })));
    expect(screen.getByRole("alert")).toHaveTextContent("changed on another device");
    expect(screen.getByRole("button", { name: "Stop processing" })).toBeDisabled();
    vi.mocked(SalvageService.getPreview).mockResolvedValue({ data: report({ job_id: "job-c", revision: 8 }) });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh progress" })));
    vi.mocked(SalvageService.cancel).mockResolvedValue({ data: stopped(false, { revision: 9, job_id: "job-c" }) });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop processing" })));
    expect(SalvageService.cancel).toHaveBeenLastCalledWith("salvage-1", 8, "job-c");
  });
  it("leaves processing untouched when confirmation is declined or server cannot cancel", async () => {
    await open();
    vi.mocked(window.confirm).mockReturnValue(false);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Stop processing" })));
    expect(SalvageService.cancel).not.toHaveBeenCalled();
    vi.mocked(SalvageService.getPreview).mockResolvedValue({ data: report({ can_cancel: false }) });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh progress" })));
    expect(screen.queryByRole("button", { name: "Stop processing" })).not.toBeInTheDocument();
  });
});
