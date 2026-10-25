import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RealEstateForm from "./RealEstateForm";
import { RealEstateService, type RealEstateCreateResponse } from "@/services/realEstate";
import type { RealEstateProperty } from "./real-estate";

vi.mock("@/context/AuthContext", () => ({ useAuthContext: () => ({ user: { username: "Appraiser", email: "test@example.test" } }) }));
vi.mock("@/components/ui/toast", () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock("@/services/realEstate", () => ({ RealEstateService: { create: vi.fn() } }));
vi.mock("@/services/savedInputs", () => ({ SavedInputService: {} }));
vi.mock("@/services/ai", () => ({ AIService: {} }));
vi.mock("./real-estate", () => ({
  RealEstateSection: ({ onChange }: { onChange: (property: RealEstateProperty) => void }) => <button type="button" onClick={() => onChange({
    id: "property", propertyType: "residential", mainImages: [new File(["main"], "main.jpg")], extraImages: [new File(["extra"], "extra.jpg")], videoFile: new File(["video"], "video.mp4"),
  })}>Attach property media</button>,
  PropertyDetailsSection: ({ details, onChange }: { details: { property_details: { address: string } }; onChange: (section: string, field: string, value: string) => void }) => <input aria-label="Address" value={details.property_details.address} onChange={(event) => onChange("property_details", "address", event.target.value)} />,
  MapUploadSection: ({ onMapImageChange }: { onMapImageChange: (files: FileList | null) => void }) => <input type="file" aria-label="Map" onChange={(event) => onMapImageChange(event.target.files)} />,
  BuildingDetailsSection: () => null,
  FarmlandDetailsSection: () => null,
  AIAssistSection: () => null,
}));

beforeEach(() => { vi.mocked(RealEstateService.create).mockReset(); });

describe("Real Estate capture compatibility", () => {
  it("uploads the captured video and report-only map, locks duplicates and treats202 as accepted", async () => {
    let finish!: (value: RealEstateCreateResponse) => void;
    vi.mocked(RealEstateService.create).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const onSubmittingChange = vi.fn();
    render(<RealEstateForm onSubmittingChange={onSubmittingChange} />);
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "Test address" } });
    fireEvent.click(screen.getByRole("button", { name: "Attach property media" }));
    const map = new File(["map"], "map.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Map"), { target: { files: [map] } });
    const form = screen.getByRole("button", { name: "Create" }).closest("form")!;
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    expect(RealEstateService.create).toHaveBeenCalledTimes(1);
    const args = vi.mocked(RealEstateService.create).mock.calls[0];
    expect(args[1].map((file) => file.name)).toEqual(["main.jpg"]);
    expect(args[2]?.map((file) => file.name)).toEqual(["extra.jpg", "map.png"]);
    expect(args[3]?.map((file) => file.name)).toEqual(["video.mp4"]);
    expect(onSubmittingChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole("status")).toHaveTextContent("Keep this page open");
    expect(screen.queryByRole("button", { name: "Create" })).not.toBeInTheDocument();
    await act(async () => { finish({ message: "Processing", phase: "processing", jobId: "re-job" }); });
    expect(screen.getByRole("status")).toHaveTextContent("Upload accepted");
    expect(screen.getByRole("status")).toHaveTextContent("preview is processing");
    expect(onSubmittingChange).toHaveBeenLastCalledWith(false);
    fireEvent.submit(form);
    expect(RealEstateService.create).toHaveBeenCalledTimes(1);
  });

  it("preserves form data and media after upload failure", async () => {
    vi.mocked(RealEstateService.create).mockRejectedValue(new Error("Upload unavailable"));
    render(<RealEstateForm />);
    fireEvent.change(screen.getByLabelText("Address"), { target: { value: "Retain address" } });
    fireEvent.click(screen.getByRole("button", { name: "Attach property media" }));
    await act(async () => { fireEvent.submit(screen.getByRole("button", { name: "Create" }).closest("form")!); });
    expect(screen.getByText("Upload unavailable")).toBeVisible();
    expect(screen.getByDisplayValue("Retain address")).toBeVisible();
    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
  });
});
