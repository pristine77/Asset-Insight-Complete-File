"use client";

import { Building2 } from "lucide-react";
import CollapsibleSection from "./CollapsibleSection";
import Field, { FIELD_CLASS } from "./Field";
import type { RealEstateDetails } from "@/services/realEstate";

interface BuildingDetailsSectionProps {
  details: RealEstateDetails;
  onChange: <K1 extends keyof RealEstateDetails, K2 extends keyof RealEstateDetails[K1] & string>(
    section: K1,
    field: K2,
    value: string
  ) => void;
  onKnownIssuesChange: (value: string) => void;
}

/* The building's size, age and rooms (owner, 2026-11-01: "professional and easy usability"). */
export default function BuildingDetailsSection({
  details,
  onChange,
  onKnownIssuesChange,
}: BuildingDetailsSectionProps) {
  const hd = details.house_details;
  const fields = [hd.year_built, hd.square_footage, hd.lot_size_sqft, hd.number_of_rooms, hd.number_of_full_bathrooms, hd.number_of_half_bathrooms];
  const filledCount = fields.filter((f) => f && f.toString().trim() !== "").length;

  return (
    <CollapsibleSection
      step={4}
      title="Building details"
      description="Age, size and rooms of the main building."
      icon={<Building2 />}
      filledCount={filledCount}
      totalCount={fields.length}
      required
    >
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <Field label="Year built" required>
          <input required type="number" className={FIELD_CLASS} value={hd.year_built} onChange={(e) => onChange("house_details", "year_built", e.target.value)} placeholder="2005" />
        </Field>
        <Field label="Floor area (sq ft)" required>
          <input required type="number" className={FIELD_CLASS} value={hd.square_footage} onChange={(e) => onChange("house_details", "square_footage", e.target.value)} placeholder="2500" />
        </Field>
        <Field label="Lot size (sq ft)" required>
          <input required type="number" className={FIELD_CLASS} value={hd.lot_size_sqft} onChange={(e) => onChange("house_details", "lot_size_sqft", e.target.value)} placeholder="8000" />
        </Field>
        <Field label="Bedrooms" required>
          <input required type="number" className={FIELD_CLASS} value={hd.number_of_rooms} onChange={(e) => onChange("house_details", "number_of_rooms", e.target.value)} placeholder="4" />
        </Field>
        <Field label="Full bathrooms" required>
          <input required type="number" className={FIELD_CLASS} value={hd.number_of_full_bathrooms} onChange={(e) => onChange("house_details", "number_of_full_bathrooms", e.target.value)} placeholder="2" />
        </Field>
        <Field label="Half bathrooms" required>
          <input required type="number" className={FIELD_CLASS} value={hd.number_of_half_bathrooms} onChange={(e) => onChange("house_details", "number_of_half_bathrooms", e.target.value)} placeholder="1" />
        </Field>
        <Field label="Known issues" span="full" hint="Separate issues with commas.">
          <input className={FIELD_CLASS} value={hd.known_issues?.join(", ") || ""} onChange={(e) => onKnownIssuesChange(e.target.value)} placeholder="Roof repair, old furnace" />
        </Field>
      </div>
    </CollapsibleSection>
  );
}
