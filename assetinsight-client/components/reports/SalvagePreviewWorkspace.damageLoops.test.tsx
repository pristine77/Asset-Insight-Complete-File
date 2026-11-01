/**
 * Owner, 2026-11-01: the Salvage preview shows each photo's damage loops and
 * lets the appraiser mark or change them; "Save changes" keeps them, and the
 * saved photo itself is never re-uploaded.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SalvageService, salvageEditableData, type SalvageReport } from "@/services/salvage";
import SalvagePreviewWorkspace from "./SalvagePreviewWorkspace";

const editor = vi.hoisted(() => ({ lastProps: null as any }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/services/salvage", async (original) => ({
  ...await original<typeof import("@/services/salvage")>(),
  SalvageService: { getPreview: vi.fn(), savePreview: vi.fn(), submit: vi.fn(), retry: vi.fn(), research: vi.fn() },
}));
vi.mock("@/services/reports", () => ({ ReportsService: { downloadReport: vi.fn() } }));
// The canvas editor itself; here it saves one new loop when asked.
vi.mock("@/components/forms/salvage/ImageAnnotatorModal", () => ({
  default: (props: any) => {
    editor.lastProps = props;
    if (!props.open) return null;
    return <button type="button" onClick={() => props.onSave(null, { actions: [], damageLoops: [{ points: [[0.5, 0.5], [0.7, 0.5], [0.7, 0.7]] }], damageRegions: [], displayFile: null })}>Save loops</button>;
  },
}));

const savedLoop = { points: [[0.1, 0.1], [0.3, 0.1], [0.3, 0.3]] as [number, number][] };
const report = (): SalvageReport => ({
  _id: "salvage-1", file_number: "CLAIM-157", createdAt: "2026-09-07T10:00:00Z",
  status: "preview", revision: 2, workflow_stage: "preview_ready", downloadable: false,
  imageUrls: ["https://assetinsight.pro/one.jpg", "https://assetinsight.pro/two.jpg"],
  preview_data: { file_number: "CLAIM-157", damage_marks: [{ photoIndex: 0, loops: [savedLoop] }] },
});

beforeEach(() => {
  vi.clearAllMocks();
  editor.lastProps = null;
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
});

describe("damage loops in the Salvage preview", () => {
  it("shows which photos are marked and opens a photo's saved loops for editing", async () => {
    vi.mocked(SalvageService.getPreview).mockResolvedValue({ data: report() });
    render(<SalvagePreviewWorkspace reportId="salvage-1" />);
    await screen.findByDisplayValue("CLAIM-157");
    expect(screen.getByText("1 damage area")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "View photo 1" }));
    fireEvent.click(screen.getByRole("button", { name: /Edit damage loops/ }));
    expect(editor.lastProps).toMatchObject({ open: true, damageOnly: true, file: null, imageUrl: "https://assetinsight.pro/one.jpg", initialDamageLoops: [savedLoop] });
  });

  it("keeps new loops with Save changes, without uploading the photo again", async () => {
    vi.mocked(SalvageService.getPreview).mockResolvedValue({ data: report() });
    vi.mocked(SalvageService.savePreview).mockResolvedValue({ data: { ...report(), revision: 3 } });
    render(<SalvagePreviewWorkspace reportId="salvage-1" />);
    await screen.findByDisplayValue("CLAIM-157");

    fireEvent.click(screen.getByRole("button", { name: "View photo 2" }));
    fireEvent.click(screen.getByRole("button", { name: /Mark damage/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save loops" }));
    expect(screen.getByText("Unsaved changes")).toBeVisible();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Save changes/ })));
    const [, draft, revision] = vi.mocked(SalvageService.savePreview).mock.calls[0];
    expect(revision).toBe(2);
    expect(draft.damage_marks).toEqual([
      { photoIndex: 0, loops: [savedLoop] },
      { photoIndex: 1, loops: [{ points: [[0.5, 0.5], [0.7, 0.5], [0.7, 0.7]] }] },
    ]);
  });

  it("are part of what Save changes sends to the server", () => {
    // savePreview sends only the fields in this list; the loops must be among them.
    const marks = [{ photoIndex: 1, loops: [savedLoop] }];
    expect(salvageEditableData({ damage_marks: marks, imageUrls: ["x"] })).toEqual({ damage_marks: marks });
  });
});
