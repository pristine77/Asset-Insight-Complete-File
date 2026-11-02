import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import API from "@/lib/api";
import { SalvageService, type SalvageDetails } from "@/services/salvage";
import { salvageUnitPayload, newSalvageUnitDraft } from "./SalvageUnitsEditor";
import SalvageForm from "../SalvageForm";

// Several units in one Salvage report (owner, 2026-11-01).
vi.mock("@/lib/api", () => ({ default: { post: vi.fn(), get: vi.fn(), patch: vi.fn() } }));
vi.mock("@/context/AuthContext", () => ({ useAuthContext: () => ({ user: { username: "Test Appraiser", email: "test@example.test", contactPhone: "1", companyName: "Co", companyAddress: "Addr" } }) }));
vi.mock("@/components/ui/toast", () => ({ toast: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn() } }));
vi.mock("./SalvageCamera", () => ({ default: () => null }));
vi.mock("./ImageAnnotatorModal", () => ({ default: () => null }));

const photo = (name: string) => new File([name], `${name}.jpg`, { type: "image/jpeg" });
const loop = { points: [[0.1, 0.1], [0.3, 0.1], [0.3, 0.3]] as [number, number][] };

describe("Salvage unit payload", () => {
  it("researches a unit only when it has photos, and sends its loops as data", () => {
    const draft = newSalvageUnitDraft();
    expect(salvageUnitPayload({ ...draft, fields: { unit_label: "Bin 4", research: true } })).toEqual({ unit_label: "Bin 4", research: false });
    const file = photo("lead");
    const payload = salvageUnitPayload({ ...draft, fields: { unit_label: "Lead", make: "", research: true }, images: [file],
      edits: [{ original: file, actions: [], damageLoops: [loop], displayFile: file }] });
    expect(payload).toEqual({ unit_label: "Lead", research: true, damage_marks: [{ photoIndex: 0, loops: [loop] }] });
  });
});

describe("Salvage service units upload", () => {
  beforeEach(() => { vi.mocked(API.post).mockReset(); vi.mocked(API.post).mockResolvedValue({ data: { reportId: "r1", message: "ok" } }); });
  it("sends each unit's photos after unit 1's, with each unit's photo count", async () => {
    const details = { file_number: "F", additional_units: [{ unit_label: "Lead" }, { unit_label: "Bin 4" }] } as SalvageDetails;
    await SalvageService.create(details, [photo("u1")], undefined, [[photo("lead-1"), photo("lead-2")], []]);
    const body = vi.mocked(API.post).mock.calls[0][1] as FormData;
    expect(JSON.parse(String(body.get("details"))).additional_units).toEqual([{ unit_label: "Lead", photo_count: 2 }, { unit_label: "Bin 4", photo_count: 0 }]);
    expect(body.getAll("images").map((file) => (file as File).name)).toEqual(["u1.jpg"]);
    expect(body.getAll("unit_images").map((file) => (file as File).name)).toEqual(["lead-1.jpg", "lead-2.jpg"]);
  });
});

describe("Salvage form with more units", () => {
  it("adds a unit with its own photos and sends it with the report", async () => {
    const create = vi.spyOn(SalvageService, "create").mockResolvedValue({ reportId: "r1", message: "Accepted" });
    render(<SalvageForm />);
    for (const [label, value] of [["File Number", "F-1"], ["Claim Number", "C-1"], ["Policy Number", "P-1"], ["Adjuster Name", "A"], ["Insured Name", "I"], ["Appraiser Comments", "N"]]) {
      fireEvent.change(screen.getByText(label, { selector: "label" }).parentElement!.querySelector("input, textarea")!, { target: { value } });
    }
    fireEvent.change(screen.getByLabelText("Licence plate"), { target: { value: "ABC-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Add another unit" }));
    const unit2 = within(screen.getByRole("region", { name: "Unit 2" }));
    fireEvent.change(unit2.getByLabelText("Unit name"), { target: { value: "Lead trailer" } });
    fireEvent.change(unit2.getByLabelText("Photos for Lead trailer"), { target: { files: [photo("lead-1")] } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create Report" })));
    const [payload, , , unitImages] = create.mock.calls[0];
    expect(payload).toMatchObject({ licence_plate: "ABC-123", report_number: 1, additional_units: [{ unit_label: "Lead trailer", research: true }] });
    expect(unitImages).toEqual([[expect.objectContaining({ name: "lead-1.jpg" })]]);
  });
});
