import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { advanceAuthSession } from "@/lib/auth-storage";
import { SalvageService, type SalvageReport } from "@/services/salvage";
import SalvagePreviewWorkspace from "./SalvagePreviewWorkspace";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/forms/salvage/ImageAnnotatorModal", () => ({ default: () => null }));
vi.mock("@/services/salvage", async original => ({ ...await original<typeof import("@/services/salvage")>(),
  SalvageService: { getPreview: vi.fn(), savePreview: vi.fn(), submit: vi.fn(), addAppendix: vi.fn(), updateAppendices: vi.fn() } }));
function deferred() {
  let resolve!: (value: { data: SalvageReport }) => void;
  const promise = new Promise<{ data: SalvageReport }>(res => { resolve = res; });
  return { promise, resolve };
}
const appendix = { id: "a-1", title: "Estimate", note: "", kind: "pdf" as const, url: "https://example.test/estimate.pdf", pageCount: 1, filename: "estimate.pdf", bytes: 3 };
function report(extra: Partial<SalvageReport> = {}): SalvageReport {
  return { _id: "report-a", reportId: "report-a", file_number: "CLAIM-A", status: "preview", revision: 3, createdAt: "", imageUrls: [],
    preview_available: true, workflow_stage: "preview_ready", preview_data: { file_number: "CLAIM-A" }, appendices_version: 0, appendices: [], ...extra };
}
function selectFile() {
  fireEvent.change(screen.getByLabelText("Appendix file"), { target: { files: [new File(["pdf"], "estimate.pdf", { type: "application/pdf" })] } });
}
async function open(value = report()) {
  vi.mocked(SalvageService.getPreview).mockResolvedValue({ data: value });
  const view = render(<SalvagePreviewWorkspace key={value._id} reportId={value._id} />);
  await screen.findByDisplayValue(value.file_number);
  return view;
}
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});

describe("Salvage appendix and preview mutation ordering", () => {
  it("keeps dirty edits and the current revision while attachment blocks Save/Submit, then saves and submits that revision", async () => {
    const pending = deferred();
    vi.mocked(SalvageService.addAppendix).mockReturnValue(pending.promise);
    await open();
    selectFile();
    const attach = screen.getByRole("button", { name: "Attach" });
    act(() => { fireEvent.click(attach); fireEvent.click(attach); });
    expect(SalvageService.addAppendix).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("File number"), { target: { value: "Edited while uploading" } });
    expect(screen.getByLabelText("File number")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Submit report" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(SalvageService.getPreview).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ data: report({ revision: 1, status: "approved", workflow_stage: "ready", appendices_version: 1, appendices: [appendix] }) }));
    expect(screen.getByLabelText("File number")).toHaveValue("Edited while uploading");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Submit report" })).toBeDisabled();
    vi.mocked(SalvageService.savePreview).mockResolvedValue({ data: report({ revision: 4, preview_data: { file_number: "Edited while uploading" }, appendices_version: 1, appendices: [appendix] }) });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save changes" })));
    expect(SalvageService.savePreview).toHaveBeenCalledWith("report-a", expect.objectContaining({ file_number: "Edited while uploading" }), 3);
    expect(screen.getByText("Saved revision 4")).toBeVisible();
    vi.mocked(SalvageService.submit).mockResolvedValue({ data: report({ revision: 4, status: "processing" }) } as never);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Submit report" })));
    expect(SalvageService.submit).toHaveBeenCalledWith("report-a", 4, false);
  });

  it("prevents an attachment from overtaking a pending preview Save, even in the same render", async () => {
    const pending = deferred();
    vi.mocked(SalvageService.savePreview).mockReturnValue(pending.promise);
    await open(); selectFile();
    fireEvent.change(screen.getByLabelText("File number"), { target: { value: "Saved edit" } });
    const save = screen.getByRole("button", { name: "Save changes" });
    const attach = screen.getByRole("button", { name: "Attach" });
    act(() => { fireEvent.click(save); fireEvent.click(attach); });
    expect(SalvageService.addAppendix).not.toHaveBeenCalled();
    await act(async () => pending.resolve({ data: report({ revision: 4, preview_data: { file_number: "Saved edit" } }) }));
    expect(screen.getByText("Saved revision 4")).toBeVisible();
    expect(screen.getByRole("button", { name: "Attach" })).toBeEnabled();
  });

  it("preserves the accepted appendix order and invalidates downloads without adopting its full report snapshot", async () => {
    const pending = deferred();
    const second = { ...appendix, id: "a-2", title: "Invoice" };
    vi.mocked(SalvageService.updateAppendices).mockReturnValue(pending.promise);
    await open(report({ appendices_version: 2, appendices: [appendix, second], files_ready: true, downloadable: true, files: { pdf: "pdf-1" } }));
    fireEvent.click(screen.getByRole("button", { name: "Move appendix B up" }));
    expect(screen.getByRole("button", { name: "Move appendix A down" })).toBeDisabled();
    await act(async () => pending.resolve({ data: report({ revision: 1, appendices_version: 3, appendices: [second, appendix] }) }));
    expect(SalvageService.updateAppendices).toHaveBeenCalledWith("report-a", [{ id: "a-2", title: "Invoice", note: "" }, { id: "a-1", title: "Estimate", note: "" }], 2);
    expect(screen.getByText("Saved revision 3")).toBeVisible();
    expect(screen.getAllByLabelText("Title").slice(0, 2).map(input => (input as HTMLInputElement).value)).toEqual(["Invoice", "Estimate"]);
    expect(screen.getByRole("button", { name: "PDF" })).toBeDisabled();
  });

  it("ignores an attachment completion after the account session changes", async () => {
    const pending = deferred(); vi.mocked(SalvageService.addAppendix).mockReturnValue(pending.promise);
    await open(); selectFile(); fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    advanceAuthSession();
    await act(async () => pending.resolve({ data: report({ appendices_version: 1, appendices: [appendix] }) }));
    expect(screen.getByText("No appendices yet.")).toBeVisible();
    expect(screen.queryByText("Appendix attached.")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Title", { selector: "#appendix-new-title" })).toHaveValue("estimate");
  });

  it("ignores an earlier keyed report completion after opening a different report", async () => {
    const pending = deferred(); vi.mocked(SalvageService.addAppendix).mockReturnValue(pending.promise);
    const view = await open(); selectFile(); fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    const other = report({ _id: "report-b", reportId: "report-b", file_number: "CLAIM-B", preview_data: { file_number: "CLAIM-B" } });
    vi.mocked(SalvageService.getPreview).mockResolvedValue({ data: other });
    view.rerender(<SalvagePreviewWorkspace key="report-b" reportId="report-b" />);
    await screen.findByDisplayValue("CLAIM-B");
    await act(async () => pending.resolve({ data: report({ appendices_version: 1, appendices: [appendix] }) }));
    expect(screen.getByLabelText("File number")).toHaveValue("CLAIM-B");
    expect(screen.getByText("No appendices yet.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Submit report" })).toBeEnabled();
  });
});
