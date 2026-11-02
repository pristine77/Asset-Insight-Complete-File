import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SalvageService, type SalvageReport } from "@/services/salvage";
import { SalvageAppendicesPanel, SalvageUnitsPreview } from "./SalvageAppraisalEditor";

// Appendices and more units in the Salvage preview (owner, 2026-11-01).
vi.mock("@/components/forms/salvage/ImageAnnotatorModal", () => ({ default: () => null }));

const report = (extra: Partial<SalvageReport> = {}) => ({
  _id: "r1", reportId: "r1", file_number: "F", status: "preview", revision: 4, createdAt: "", imageUrls: [], preview_data: {},
  appendices_version: 2,
  appendices: [
    { id: "a-1", title: "Truck estimate", note: "", kind: "pdf", url: "https://cdn.example/a.pdf", pageCount: 3, filename: "est.pdf", bytes: 10 },
    { id: "a-2", title: "Invoice", note: "", kind: "image", url: "https://cdn.example/b.jpg", pageCount: 1, filename: "inv.jpg", bytes: 10 },
  ],
  ...extra,
}) as SalvageReport;

describe("Salvage appendices panel", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("attaches a file with its title and the current version", async () => {
    const add = vi.spyOn(SalvageService, "addAppendix").mockResolvedValue({ data: report({ appendices_version: 3 }) });
    const onReport = vi.fn();
    render(<SalvageAppendicesPanel report={report()} disabled={false} onReport={onReport} />);
    const file = new File(["%PDF-"], "quote.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Appendix file"), { target: { files: [file] } });
    expect(screen.getByLabelText("Title", { selector: "#appendix-new-title" })).toHaveValue("quote");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Attach/ })));
    expect(add).toHaveBeenCalledWith("r1", file, { title: "quote", note: "" }, 2);
    expect(onReport).toHaveBeenCalledWith(expect.objectContaining({ appendices_version: 3 }));
  });

  it("reorders by sending the whole list in its new order", async () => {
    const update = vi.spyOn(SalvageService, "updateAppendices").mockResolvedValue({ data: report() });
    render(<SalvageAppendicesPanel report={report()} disabled={false} onReport={vi.fn()} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Move appendix B up" })));
    expect(update).toHaveBeenCalledWith("r1", [{ id: "a-2", title: "Invoice", note: "" }, { id: "a-1", title: "Truck estimate", note: "" }], 2);
  });

  it("shows the server's reason when a change is refused, and keeps the form", async () => {
    vi.spyOn(SalvageService, "addAppendix").mockRejectedValue({ response: { data: { message: "This PDF has 61 pages; an appendix can have at most 60." } } });
    render(<SalvageAppendicesPanel report={report({ appendices: [] })} disabled={false} onReport={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Appendix file"), { target: { files: [new File(["x"], "big.pdf", { type: "application/pdf" })] } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Attach/ })));
    expect(screen.getByRole("alert")).toHaveTextContent("at most 60");
    expect(screen.getByLabelText("Title", { selector: "#appendix-new-title" })).toHaveValue("big");
  });
});

describe("Salvage units in the preview", () => {
  it("adds a unit without photos and edits a unit's fields", () => {
    const onChange = vi.fn();
    const { rerender } = render(<SalvageUnitsPreview units={[]} onChange={onChange} disabled={false} appendices={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /Add unit/ }));
    expect(onChange).toHaveBeenCalledWith([{ research: false }]);
    rerender(<SalvageUnitsPreview units={[{ id: "u2", unit_label: "Lead", imageUrls: ["https://cdn.example/1.jpg"] }]} onChange={onChange} disabled={false} appendices={[]} />);
    fireEvent.change(screen.getByLabelText("Licence plate"), { target: { value: "ABC" } });
    expect(onChange).toHaveBeenLastCalledWith([{ id: "u2", unit_label: "Lead", imageUrls: ["https://cdn.example/1.jpg"], licence_plate: "ABC" }]);
  });
});
