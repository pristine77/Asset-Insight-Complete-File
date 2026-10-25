import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SalvageAssessmentEditor from "./SalvageAssessmentEditor";
import type { SalvageAssessmentInputs, SalvageAssessmentV2, SalvageComparableEvidence } from "@/lib/salvageAssessment";

const emptyInputs: SalvageAssessmentInputs = {
  year: 2018, make: "Ford", model: "F-150", trim: "XLT", powertrain: null, vin: null, odometer: 100000,
  odometerUnit: "km", province: "ON", market: "Toronto", effectiveDate: "2026-09-08", lossType: "Collision",
  condition: "Front damage", damageDescription: "Front bumper damaged", documentedBrand: null, brandProvince: null, brandEvidenceRef: null,
  currency: "CAD", repairItems: [], labourItems: [], charges: [], sellerCosts: { fees: null, transport: null, storage: null, disposal: null },
  suppliedComparables: [], suppliedReferences: [], overrides: { preLoss: null, asIs: null },
};
const conclusion = { amount: 12000, low: 10000, high: 14000, currency: "CAD" as const, priceBasis: "sold" as const,
  status: "supported" as const, comparableIds: [], method: "Median", referenceIds: [] };
function assessment(): SalvageAssessmentV2 {
  return {
    schemaVersion: 2, generatedAt: "2026-09-08T00:00:00.000Z", inputs: structuredClone(emptyInputs), researchedInputs: structuredClone(emptyInputs), stale: false,
    photoFindings: [{ photoId: "photo-001", status: "analyzed", facts: [], observations: [], uncertainties: [] }], candidates: [], comparables: [],
    references: [{ id: "provider-ref", kind: "web", title: "Verified source", url: "https://auctions.example.ca/lot/1", publisher: "Auctions", accessedAt: "2026-09-08", excerpt: "Source evidence text", photoIds: [] }],
    valuations: { preLoss: { ...conclusion, amount: 25000 }, asIs: { ...conclusion } },
    repairs: { parts: [], labour: [], charges: [], partsTotal: null, labourTotal: null, chargesTotal: null, knownSubtotal: 0, total: null, status: "incomplete" },
    netRecovery: { gross: 12000, deductions: { ...emptyInputs.sellerCosts }, knownDeductions: 0, total: null, status: "incomplete", formula: "Gross minus seller costs" },
    limitations: [{ code: "REPAIR_ESTIMATE_INCOMPLETE", message: "Repair costs need supporting evidence.", severity: "warning", acknowledgementRequired: true }], research: {},
  };
}
function setup(saved = assessment(), disabled = false) {
  const changed = vi.fn();
  function Harness() {
    const [inputs, setInputs] = useState<Partial<SalvageAssessmentInputs>>(saved.inputs);
    return <SalvageAssessmentEditor assessment={saved} inputs={inputs} disabled={disabled} photos={["https://assetinsight.pro/photo.jpg"]}
      onChange={(next) => { changed(next); setInputs(next); }} />;
  }
  render(<Harness />);
  return changed;
}

describe("canonical Canadian salvage review editor", () => {
  it("replaces duplicate identity fields with photo-derived values and isolated owner overrides", () => {
    const saved = assessment();
    saved.vehicleDetails = { schemaVersion: 1, category: null, warnings: [], fields: [
      { key: "vin", label: "VIN", value: null, status: "unknown", evidence: [] },
      { key: "engineModel", label: "Engine model", value: "EcoBoost", status: "observed", evidence: [] },
    ] };
    const changed = setup(saved);
    expect(screen.queryByLabelText("Assessment VIN")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Assessment powertrain")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Engine model")).toHaveValue("EcoBoost");
    fireEvent.change(screen.getByLabelText("VIN"), { target: { value: "1FTFW1ET1EFB12345" } });
    expect(changed.mock.lastCall?.[0]).toMatchObject({ vin: null, vehicleOverrides: { vin: "1FTFW1ET1EFB12345" } });
    expect(saved.vehicleDetails.fields[0].value).toBeNull();
    expect(screen.getByLabelText("Market city / region")).toHaveValue("Toronto");
  });

  it("renders saved conclusions separately and never recalculates money while editing", () => {
    const saved = assessment(), changed = setup(saved);
    expect(screen.getByTestId("saved-pre-loss-value")).toHaveTextContent("25,000.00");
    expect(screen.getByTestId("saved-repair-value")).toHaveTextContent("Unavailable");
    fireEvent.change(screen.getByLabelText("Assessment year"), { target: { value: "2020" } });
    expect(changed).toHaveBeenLastCalledWith(expect.objectContaining({ year: 2020 }));
    expect(screen.getByTestId("saved-pre-loss-value")).toHaveTextContent("25,000.00");
    expect(saved.inputs.year).toBe(2018);
    expect(screen.getByText(/Editing an input does not recalculate/)).toBeVisible();
  });

  it("converts blank numbers to null and permits explicit zero rather than manufacturing zero", () => {
    const changed = setup();
    fireEvent.change(screen.getByLabelText("Assessment odometer"), { target: { value: "" } });
    expect(changed.mock.lastCall?.[0].odometer).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add repair part" }));
    expect(changed.mock.lastCall?.[0].repairItems[0]).toMatchObject({ quantity: null, unitPrice: null, appraiserReason: null });
    fireEvent.change(screen.getByLabelText("Part 1 quantity"), { target: { value: "0" } });
    expect(changed.mock.lastCall?.[0].repairItems[0].quantity).toBe(0);
    fireEvent.change(screen.getByLabelText("Part 1 rationale"), { target: { value: "No replacement parts are required after the professional inspection." } });
    expect(changed.mock.lastCall?.[0].repairItems[0].appraiserReason).toContain("professional inspection");
    expect(screen.getByTestId("saved-repair-value")).toHaveTextContent("Unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Remove repair part 1" }));
    expect(changed.mock.lastCall?.[0].repairItems).toEqual([]);
  });

  it("edits parts, labour and charges with explicit rationale and source IDs", () => {
    const changed = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add labour task" }));
    fireEvent.change(screen.getByLabelText("Labour 1 task"), { target: { value: "Fit bumper" } });
    fireEvent.change(screen.getByLabelText("Labour 1 hours"), { target: { value: "2.5" } });
    fireEvent.change(screen.getByLabelText("Labour 1 hourly rate (CAD)"), { target: { value: "120" } });
    fireEvent.click(screen.getByLabelText("Labour 1 evidence: provider-ref"));
    expect(changed.mock.lastCall?.[0].labourItems[0]).toMatchObject({ description: "Fit bumper", hours: 2.5, rate: 120, referenceIds: ["provider-ref"] });
    fireEvent.click(screen.getByRole("button", { name: "Add repair charge" }));
    fireEvent.change(screen.getByLabelText("Charge 1 description"), { target: { value: "Delivery" } });
    fireEvent.change(screen.getByLabelText("Charge 1 amount (CAD)"), { target: { value: "25" } });
    expect(changed.mock.lastCall?.[0].charges[0]).toMatchObject({ description: "Delivery", amount: 25 });
  });

  it("retains seller categories unknown and exposes independent documented overrides", () => {
    const changed = setup();
    fireEvent.change(screen.getByLabelText("Seller fees amount (CAD)"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Seller fees rationale"), { target: { value: "Seller agreement confirms no fee for this sale." } });
    expect(changed.mock.lastCall?.[0].sellerCosts).toMatchObject({ fees: { amount: 0, appraiserReason: "Seller agreement confirms no fee for this sale." }, transport: null });
    fireEvent.change(screen.getByLabelText("As-is override amount (CAD)"), { target: { value: "15000" } });
    fireEvent.change(screen.getByLabelText("As-is override rationale"), { target: { value: "The documented inspection and supplier evidence support this override." } });
    expect(changed.mock.lastCall?.[0].overrides.asIs).toMatchObject({ amount: 15000 });
    expect(screen.getByTestId("saved-as-is-value")).toHaveTextContent("12,000.00");
    fireEvent.click(screen.getByRole("button", { name: "Remove as-is override", hidden: true }));
    expect(changed.mock.lastCall?.[0].overrides.asIs).toBeNull();
  });

  it("adds attributed source records with only uploaded photo IDs and safe link feedback", () => {
    const changed = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add evidence reference", hidden: true }));
    fireEvent.change(screen.getByLabelText("Reference 1 title"), { target: { value: "Ontario vehicle registration" } });
    fireEvent.change(screen.getByLabelText("Reference 1 kind"), { target: { value: "photo" } });
    fireEvent.click(screen.getByLabelText("Reference 1 uploaded photos: photo-001"));
    expect(screen.queryByLabelText("Reference 1 uploaded photos: photo-050")).not.toBeInTheDocument();
    expect(changed.mock.lastCall?.[0].suppliedReferences[0]).toMatchObject({ kind: "photo", photoIds: ["photo-001"], title: "Ontario vehicle registration" });
    const generatedId = changed.mock.lastCall?.[0].suppliedReferences[0].id;
    fireEvent.change(screen.getByLabelText("Reference 1 source URL"), { target: { value: "http://127.0.0.1/private" } });
    expect(screen.getByLabelText("Reference 1 source URL")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/Enter a public HTTP/)).toBeInTheDocument();
    expect(changed.mock.lastCall?.[0].suppliedReferences[0].id).toBe(generatedId);
    expect(screen.queryByRole("link", { name: /127.0.0.1/ })).not.toBeInTheDocument();
  });

  it("records comparable price basis, source evidence and adjustments without exposing provider flags", () => {
    const changed = setup();
    fireEvent.click(screen.getByRole("button", { name: "Add supplied comparable", hidden: true }));
    fireEvent.change(screen.getByLabelText("Comparable 1 title"), { target: { value: "2018 Ford F-150" } });
    fireEvent.change(screen.getByLabelText("Comparable 1 price basis"), { target: { value: "current_bid" } });
    fireEvent.change(screen.getByLabelText("Comparable 1 original price"), { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("button", { name: "Add adjustment for comparable 1", hidden: true }));
    fireEvent.change(screen.getByLabelText("Comparable 1 adjustment 1 amount (CAD)"), { target: { value: "-1000" } });
    expect(changed.mock.lastCall?.[0].suppliedComparables[0]).toMatchObject({ title: "2018 Ford F-150", priceBasis: "current_bid", price: 5000, verification: "appraiser_supplied", eligible: false, adjustments: [expect.objectContaining({ amount: -1000 })] });
    expect(screen.queryByLabelText(/verification/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("saved-as-is-value")).toHaveTextContent("12,000.00");
  });

  it("disables every editable field and mutation while report processing or saving is active", () => {
    const changed = setup(assessment(), true);
    expect(screen.getByLabelText("Assessment make")).toBeDisabled();
    expect(screen.getByLabelText("Seller fees amount (CAD)")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add repair part" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add supplied comparable", hidden: true })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Add repair part" }));
    expect(changed).not.toHaveBeenCalled();
  });

  it("renders saved exclusions, required limitations and source content as text, never executable markup", () => {
    const saved = assessment();
    saved.stale = true;
    saved.references.push({ id: "unsafe", kind: "web", url: "javascript:alert(1)", title: "Unsafe source", publisher: null, accessedAt: null, excerpt: "<script>alert('x')</script>", photoIds: [] });
    saved.candidates = [{ id: "candidate-1", basket: "as_is", title: "Excluded bid", url: "javascript:alert(1)", price: 5000, currency: "CAD", priceBasis: "current_bid", sourceName: "Unsafe comparable", eligible: false, selected: false, adjustedPrice: null, eventDate: null, location: null, odometer: null,
      referenceIds: [], exclusionReasons: ["Current bid is not a completed sale"], evidence: {} } as unknown as SalvageComparableEvidence];
    setup(saved);
    expect(screen.getByText(/Research is stale/)).toBeVisible();
    expect(screen.getByText(/Repair costs need supporting evidence/)).toBeVisible();
    expect(screen.getByText("Current bid is not a completed sale")).toBeInTheDocument();
    expect(screen.getByText("<script>alert('x')</script>")).toBeInTheDocument();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(document.querySelector("script")).toBeNull();
  });
});
