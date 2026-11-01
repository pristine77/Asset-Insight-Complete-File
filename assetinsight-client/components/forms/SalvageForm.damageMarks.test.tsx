/**
 * Owner, 2026-11-01: on a Salvage photo, draw a loop around the damage "so the
 * software knows exactly where the damage is"; Salvage only; freehand loop;
 * the report prints the photo with its loops. The form uploads the marked photo
 * and each loop's position by photo, and reopening a photo shows its loops again.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SalvageService } from "@/services/salvage";
import SalvageForm from "./SalvageForm";
import { damageLoopsOf, damageRegionsOf, type AnnotatorAction } from "./salvage/ImageAnnotatorModal";

const editor = vi.hoisted(() => ({ lastProps: null as any }));
vi.mock("@/context/AuthContext", () => ({ useAuthContext: () => ({ user: {
  username: "Test Appraiser", email: "test@example.test", contactPhone: "1234567890",
  companyName: "Company", companyAddress: "Test address",
} }) }));
vi.mock("@/services/salvage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/services/salvage")>();
  return { ...original, SalvageService: { create: vi.fn() } };
});
vi.mock("@/components/ui/toast", () => ({ toast: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));
vi.mock("./salvage/SalvageCamera", () => ({ default: () => null }));
// The editor itself draws on a canvas; here it saves one damage loop when asked.
vi.mock("./salvage/ImageAnnotatorModal", async (importOriginal) => {
  const original = await importOriginal<typeof import("./salvage/ImageAnnotatorModal")>();
  return {
    ...original,
    default: (props: any) => {
      editor.lastProps = props;
      if (!props.open) return null;
      const loop: AnnotatorAction = { type: "damage", points: [{ x: 100, y: 50 }, { x: 300, y: 50 }, { x: 300, y: 250 }, { x: 100, y: 250 }] };
      // Loops only: the photo uploads clean; the marked copy is just the thumbnail.
      return (
        <button type="button" onClick={() => props.onSave(props.file, {
          actions: [loop], damageLoops: [{ points: [[0.1, 0.05], [0.3, 0.05], [0.3, 0.25]] }],
          damageRegions: [{ x: 0.1, y: 0.05, width: 0.2, height: 0.2 }],
          displayFile: new File(["marked"], "marked.jpg", { type: "image/jpeg" }),
        })}>Save loop</button>
      );
    },
  };
});

function fillRequired() {
  for (const [label, value] of [["File Number", "F-1"], ["Claim Number", "C-1"], ["Policy Number", "P-1"],
    ["Adjuster Name", "Adjuster"], ["Insured Name", "Insured"], ["Appraiser Comments", "Notes"]]) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  }
}

beforeEach(() => {
  vi.mocked(SalvageService.create).mockReset();
  editor.lastProps = null;
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn((file: File) => `blob:${file.name}`) });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});

describe("damage loops on Salvage photos", () => {
  it("uploads the clean photo with its loop's points, by photo", async () => {
    vi.mocked(SalvageService.create).mockResolvedValue({ reportId: "r1", message: "Accepted" });
    render(<SalvageForm />);
    fillRequired();
    const clean = [new File(["a"], "a.jpg", { type: "image/jpeg" }), new File(["b"], "b.jpg", { type: "image/jpeg" })];
    fireEvent.change(screen.getByLabelText("Salvage images"), { target: { files: clean } });

    fireEvent.click(screen.getAllByRole("button", { name: "Edit image" })[1]);
    expect(editor.lastProps.defaultMode).toBe("damage");
    fireEvent.click(screen.getByRole("button", { name: "Save loop" }));
    expect(screen.getByText("1 damage area")).toBeVisible();

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create Report" })));
    const [details, images] = vi.mocked(SalvageService.create).mock.calls[0];
    expect(images.map((file) => file.name)).toEqual(["a.jpg", "b.jpg"]);
    expect(details.damage_marks).toEqual([{ photoIndex: 1, loops: [{ points: [[0.1, 0.05], [0.3, 0.05], [0.3, 0.25]] }] }]);
  });

  it("reopens the clean photo with its loops, and moves marks with the photos when one is removed", () => {
    render(<SalvageForm />);
    const clean = [new File(["a"], "a.jpg", { type: "image/jpeg" }), new File(["b"], "b.jpg", { type: "image/jpeg" })];
    fireEvent.change(screen.getByLabelText("Salvage images"), { target: { files: clean } });
    fireEvent.click(screen.getAllByRole("button", { name: "Edit image" })[1]);
    fireEvent.click(screen.getByRole("button", { name: "Save loop" }));

    fireEvent.click(screen.getAllByRole("button", { name: "Edit image" })[1]);
    expect(editor.lastProps.file.name).toBe("b.jpg");
    expect(editor.lastProps.initialActions).toHaveLength(1);
    editor.lastProps.onClose();

    fireEvent.click(screen.getAllByRole("button", { name: "Remove image" })[0]);
    expect(screen.getByText("1 damage area")).toBeVisible();
    fireEvent.click(screen.getAllByRole("button", { name: "Edit image" })[0]);
    expect(editor.lastProps.initialActions).toHaveLength(1);
  });

  it("sends no marks when nothing was looped", async () => {
    vi.mocked(SalvageService.create).mockResolvedValue({ reportId: "r2", message: "Accepted" });
    render(<SalvageForm />);
    fillRequired();
    fireEvent.change(screen.getByLabelText("Salvage images"), { target: { files: [new File(["a"], "a.jpg", { type: "image/jpeg" })] } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create Report" })));
    expect(vi.mocked(SalvageService.create).mock.calls[0][0]).not.toHaveProperty("damage_marks");
  });
});

describe("a loop's position", () => {
  it("is its points as fractions of the photo, thinned to at most 400", () => {
    const points = Array.from({ length: 1000 }, (_, i) => ({ x: 100 + (i % 50), y: 100 + Math.floor(i / 50) }));
    const [loop] = damageLoopsOf([{ type: "damage", points }], 1000, 1000);
    expect(loop.points.length).toBeLessThanOrEqual(400);
    expect(loop.points[0]).toEqual([0.1, 0.1]);
    expect(damageLoopsOf([{ type: "text", color: "#000", size: 12, text: "note", x: 1, y: 1 }], 100, 100)).toEqual([]);
  });


  it("is its box as fractions of the photo, ignoring pen notes", () => {
    const actions: AnnotatorAction[] = [
      { type: "stroke", color: "#000", size: 4, points: [{ x: 0, y: 0 }, { x: 999, y: 999 }] },
      { type: "damage", points: [{ x: 200, y: 100 }, { x: 600, y: 100 }, { x: 600, y: 400 }, { x: 250, y: 380 }] },
    ];
    expect(damageRegionsOf(actions, 1000, 800)).toEqual([{ x: 0.2, y: 0.125, width: 0.4, height: 0.375 }]);
  });
});
