import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SalvageService, type CreateOptions, type SalvageCreateResponse } from "@/services/salvage";
import SalvageForm from "./SalvageForm";

const mocks = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }));
vi.mock("@/context/AuthContext", () => ({ useAuthContext: () => ({ user: {
  username: "Test Appraiser", email: "test@example.test", contactPhone: "1234567890",
  companyName: "Company", companyAddress: "Test address",
} }) }));
vi.mock("@/services/salvage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/services/salvage")>();
  return { ...original, SalvageService: { create: vi.fn() } };
});
vi.mock("@/components/ui/toast", () => ({ toast: mocks }));
vi.mock("./salvage/SalvageCamera", () => ({ default: () => null }));
vi.mock("./salvage/ImageAnnotatorModal", () => ({ default: () => null }));

function fillForm() {
  for (const [label, value] of [
    ["File Number", "FILE-001"], ["Claim Number", "CLAIM-001"],
    ["Policy Number", "POLICY-001"], ["Adjuster Name", "Adjuster"],
    ["Insured Name", "Insured"], ["Appraiser Comments", "Important damage notes"],
  ]) {
    const field = screen.getByText(label, { selector: "label" }).parentElement?.querySelector("input, textarea");
    expect(field).toBeTruthy();
    fireEvent.change(field!, { target: { value } });
  }
}

function addPhotos(count: number) {
  const files = Array.from({ length: count }, (_, index) => new File([`photo${index}`], `photo${index}.jpg`, { type: "image/jpeg" }));
  fireEvent.change(screen.getByLabelText("Salvage images"), { target: { files } });
  return files;
}

describe("Salvage form upload/acceptance workflow", () => {
  beforeEach(() => {
    vi.mocked(SalvageService.create).mockReset();
    vi.clearAllMocks();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn((file: File) => `blob:${file.name}`) });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
  });

  it("keeps all 50 selected photos, locks same-tick duplicate submits and shows upload then accepted state", async () => {
    let resolve!: (value: SalvageCreateResponse) => void;
    let options: CreateOptions | undefined;
    vi.mocked(SalvageService.create).mockImplementation((_details, _images, createOptions) => {
      options = createOptions;
      return new Promise((res) => { resolve = res; });
    });
    const onSubmittingChange = vi.fn();
    const onSuccess = vi.fn();
    const onCancel = vi.fn();
    render(<SalvageForm onSuccess={onSuccess} onCancel={onCancel} onSubmittingChange={onSubmittingChange} />);
    fillForm();
    const files = addPhotos(50);
    expect(screen.getByText("Selected: 50/50 photos")).toBeVisible();
    expect(screen.getByRole("button", { name: "Select Images" })).toBeDisabled();
    const form = screen.getByRole("button", { name: "Create Report" }).closest("form")!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(SalvageService.create).toHaveBeenCalledTimes(1);
    expect(vi.mocked(SalvageService.create).mock.calls[0][1]).toEqual(files);
    expect(onSubmittingChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Salvage images")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Uploading salvage report");
    const leavingDuringUpload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leavingDuringUpload);
    expect(leavingDuringUpload.defaultPrevented).toBe(true);
    act(() => options?.onUploadProgress?.(0.5));
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "50");
    act(() => options?.onUploadProgress?.(1));
    expect(screen.getByRole("status")).toHaveTextContent("Confirming your upload");
    await act(async () => resolve({ jobId: "job-1", phase: "processing", message: "Processing" }));
    expect(screen.getByRole("status")).toHaveTextContent("Upload accepted");
    expect(screen.getByRole("status")).toHaveTextContent("processing in the background");
    expect(screen.queryByRole("button", { name: "Create Report" })).not.toBeInTheDocument();
    expect(onSubmittingChange).toHaveBeenLastCalledWith(false);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    const leavingAfterAcceptance = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leavingAfterAcceptance);
    expect(leavingAfterAcceptance.defaultPrevented).toBe(false);
  });

  it("retains entered details and every photo after failure and allows retry", async () => {
    vi.mocked(SalvageService.create).mockRejectedValueOnce(new Error("Upload failed"));
    vi.mocked(SalvageService.create).mockResolvedValueOnce({ jobId: "job-2", message: "Processing" });
    render(<SalvageForm />);
    fillForm();
    const files = addPhotos(11);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create Report" })));
    expect(screen.getByRole("alert")).toHaveTextContent("Upload failed");
    expect(screen.getByDisplayValue("Important damage notes")).toBeVisible();
    expect(screen.getByText("Selected: 11/50 photos")).toBeVisible();
    expect(screen.getAllByRole("img")).toHaveLength(11);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create Report" })));
    expect(SalvageService.create).toHaveBeenCalledTimes(2);
    expect(vi.mocked(SalvageService.create).mock.calls[1][1]).toEqual(files);
    const attempts = vi.mocked(SalvageService.create).mock.calls;
    expect(attempts[0][0].client_submission_id).toBeTruthy();
    expect(attempts[1][0].client_submission_id).toBe(attempts[0][0].client_submission_id);
  });

  it("hands off the accepted persisted report id for preview instead of announcing completion", async () => {
    vi.mocked(SalvageService.create).mockResolvedValue({ reportId: "salvage-1", jobId: "job-1", message: "Accepted", phase: "processing" });
    const onReportAccepted = vi.fn();
    const onSuccess = vi.fn();
    render(<SalvageForm onReportAccepted={onReportAccepted} onSuccess={onSuccess} />);
    fillForm();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create Report" })));
    expect(onReportAccepted).toHaveBeenCalledWith("salvage-1");
    expect(onSuccess).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Review the preview when it is ready");
  });

  it("collects market/loss context without vehicle inputs or fabricated identity defaults", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No automatic provider request is allowed"));
    vi.mocked(SalvageService.create).mockResolvedValue({ reportId: "salvage-vehicle", message: "Accepted" });
    render(<SalvageForm />);
    fillForm();
    for (const label of ["Vehicle year", "Vehicle make", "Vehicle model", "Trim / edition", "Engine / powertrain", "VIN (if readable)", "Odometer reading", "Odometer unit"]) {
      expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
    }
    expect(screen.getByRole("heading", { name: "Vehicle details come from your photos" })).toBeVisible();
    expect(screen.getByText(/Missing details show “Cannot find from image”/)).toBeVisible();
    for (const [label, value] of [
      ["City / local market", "Ottawa"], ["Effective valuation date", "2026-09-08"],
      ["Type / cause of loss", "Collision"], ["Documented vehicle brand", "Salvage"], ["Observed damage", "Front bumper damaged"],
    ]) fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.change(screen.getByLabelText("Market province / territory"), { target: { value: "ON" } });
    fireEvent.change(screen.getByLabelText("Brand document province / territory"), { target: { value: "ON" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Create Report" })));
    expect(SalvageService.create).toHaveBeenCalledWith(expect.objectContaining({ currency: "CAD", assessment_inputs: expect.objectContaining({
      province: "ON", market: "Ottawa", effectiveDate: "2026-09-08", lossType: "Collision", documentedBrand: "Salvage", brandProvince: "ON",
      condition: null, damageDescription: "Front bumper damaged", currency: "CAD",
    }) }), [], expect.any(Object));
    const inputs = vi.mocked(SalvageService.create).mock.calls[0][0].assessment_inputs;
    for (const key of ["year", "make", "model", "trim", "powertrain", "vin", "odometer", "odometerUnit"]) {
      expect(inputs).not.toHaveProperty(key);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("warns clearly when a selection would exceed the backend's 50-photo limit", () => {
    render(<SalvageForm />);
    addPhotos(51);
    expect(screen.getByRole("alert")).toHaveTextContent("Extra files were not added");
    expect(screen.getByText("Selected: 50/50 photos")).toBeVisible();
  });
});
