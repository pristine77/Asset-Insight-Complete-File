import { useState } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SalvageVehicleDetails as VehicleDetails } from "@/lib/salvageAssessment";
import SalvageVehicleDetails from "./SalvageVehicleDetails";

function fixture(): VehicleDetails {
  return { schemaVersion: 1, category: "Light Duty Pickup Truck", warnings: ["Engine readings conflict; verify the uploaded labels."], fields: [
    { key: "make", label: "Make", value: "Ford", status: "observed", evidence: [{ photoId: "photo-001", value: "Ford", evidence: "Manufacturer label reads FORD.", accepted: true, rejectionReason: null }] },
    { key: "vin", label: "VIN", value: null, status: "unknown", evidence: [] },
    { key: "engineDisplacement", label: "Engine displacement", value: null, status: "conflict", evidence: [
      { photoId: "photo-002", value: "3.5L", evidence: "Engine label reads 3.5L.", accepted: true, rejectionReason: null },
      { photoId: "photo-003", value: "5.0L", evidence: "Second engine label reads 5.0L.", accepted: true, rejectionReason: null },
    ] },
    { key: "odometerUnit", label: "Odometer unit", value: null, status: "unknown", evidence: [] },
    { key: "spec:Transmission Type", label: "Transmission Type", value: null, status: "unknown", evidence: [{ photoId: "photo-099", value: "Automatic", evidence: "Not readable", accepted: false, rejectionReason: "Unreadable source photo" }] },
  ] };
}

describe("Salvage image-only vehicle detail review", () => {
  it("uses catalogue categories and unknown-first checkbox controls without assuming false", () => {
    const changed = vi.fn(), details = fixture();
    details.fields.push({ key: "category", label: "Vehicle category", value: null, status: "unknown", evidence: [], type: "select", options: ["Light Duty Pickup Truck", "Utility Vehicle"] });
    details.fields.push({ key: "spec:Keys", label: "Keys", value: null, status: "unknown", evidence: [], type: "checkbox" });
    render(<SalvageVehicleDetails details={details} disabled={false} onChange={changed} />);
    expect(screen.getByRole("combobox", { name: "Vehicle category" })).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Keys" })).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Vehicle category"), { target: { value: "Utility Vehicle" } });
    expect(changed).toHaveBeenLastCalledWith({ category: "Utility Vehicle" });
    fireEvent.change(screen.getByLabelText("Keys"), { target: { value: "No" } });
    expect(changed).toHaveBeenLastCalledWith({ "spec:Keys": "No" });
  });

  it("displays observed values and explicit missing/conflicting catalogue fields without guessing", () => {
    render(<SalvageVehicleDetails details={fixture()} disabled={false} onChange={vi.fn()} />);
    expect(screen.getByLabelText("Make")).toHaveValue("Ford");
    expect(screen.getByLabelText("VIN")).toHaveValue("");
    expect(screen.getByLabelText("VIN")).toHaveAttribute("placeholder", "Cannot find from image");
    expect(screen.getByLabelText("Engine displacement")).toHaveValue("");
    expect(screen.getByText("Conflicting image evidence — review required")).toBeVisible();
    expect(screen.getByLabelText("Transmission Type")).toHaveValue("");
    expect(screen.getByText(/Vehicle-type specifications · Light Duty Pickup Truck/)).toBeVisible();
    expect(screen.getByText("4 of 5 fields not established")).toBeVisible();
  });

  it("sends manual overrides only, keeps original evidence immutable and supports explicit clearing", () => {
    const details = fixture(), changed = vi.fn();
    function Harness() {
      const [overrides, setOverrides] = useState<Record<string, string | null>>({ make: "Ford Canada" });
      return <SalvageVehicleDetails details={details} disabled={false} overrides={overrides}
        onChange={(value) => { changed(value); setOverrides(value); }} />;
    }
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("VIN"), { target: { value: "1ftfw1et1efb12345" } });
    expect(changed).toHaveBeenLastCalledWith({ make: "Ford Canada", vin: "1FTFW1ET1EFB12345" });
    fireEvent.change(screen.getByLabelText("Transmission Type"), { target: { value: "Automatic (appraiser checked)" } });
    expect(changed.mock.lastCall?.[0]["spec:Transmission Type"]).toBe("Automatic (appraiser checked)");
    expect(screen.getAllByText("User entered")).toHaveLength(3);
    fireEvent.change(screen.getByLabelText("Make"), { target: { value: "" } });
    expect(changed.mock.lastCall?.[0].make).toBeNull();
    expect(screen.getByText("Cleared by user")).toBeVisible();
    expect(details.fields[0].value).toBe("Ford");
    expect(details.fields[1].value).toBeNull();
    fireEvent.change(screen.getByLabelText("Odometer unit"), { target: { value: "km" } });
    expect(changed.mock.lastCall?.[0].odometerUnit).toBe("km");
  });

  it("opens only valid original photo IDs and exposes rejected evidence without executable content", () => {
    const details = fixture(), showPhoto = vi.fn();
    details.fields[0].evidence[0].evidence = "<script>alert(1)</script>";
    render(<SalvageVehicleDetails details={details} disabled={false} onChange={vi.fn()} onViewPhoto={showPhoto} photoCount={3} />);
    const make = screen.getByLabelText("Make").closest("div")!;
    fireEvent.click(within(make).getByText("Image evidence (1)"));
    fireEvent.click(screen.getByRole("button", { name: "View photo 1 for Make" }));
    expect(showPhoto).toHaveBeenCalledWith(0);
    expect(screen.queryByRole("button", { name: /View photo 99/ })).not.toBeInTheDocument();
    expect(screen.getByText("<script>alert(1)</script>", { exact: false })).toBeInTheDocument();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText(/Not accepted: Unreadable source photo/)).toBeInTheDocument();
  });

  it("locks editing while saving or processing without disabling inspection", () => {
    const changed = vi.fn();
    render(<SalvageVehicleDetails details={fixture()} disabled onChange={changed} onViewPhoto={vi.fn()} photoCount={3} />);
    expect(screen.getByLabelText("Make")).toBeDisabled();
    expect(screen.getByLabelText("VIN")).toBeDisabled();
    expect(screen.getByLabelText("Odometer unit")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Make"), { target: { value: "Ignored" } });
    expect(changed).not.toHaveBeenCalled();
  });
});
