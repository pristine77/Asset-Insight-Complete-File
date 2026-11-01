"use client";

import { Home } from "lucide-react";
import CollapsibleSection from "./CollapsibleSection";
import Field, { FIELD_CLASS } from "./Field";
import type { RealEstateDetails } from "@/services/realEstate";

interface PropertyDetailsSectionProps {
  details: RealEstateDetails;
  onChange: <K1 extends keyof RealEstateDetails, K2 extends keyof RealEstateDetails[K1] & string>(
    section: K1,
    field: K2,
    value: string
  ) => void;
  onLanguageChange: (lang: "en" | "fr" | "es") => void;
}

/*
   Who owns the property, where it is and its legal description, then the
   report's language and dates (owner, 2026-11-01: "professional and easy
   usability"). Plain labels instead of abbreviations ("Report language", not
   "Lang"; "Land area (acres)", not "Land Area (ac)"); the same fields and
   values as before.
*/
export default function PropertyDetailsSection({
  details,
  onChange,
  onLanguageChange,
}: PropertyDetailsSectionProps) {
  const pd = details.property_details;
  const rd = details.report_dates;

  const propertyFields = [pd.owner_name, pd.address, pd.land_description, pd.municipality, pd.title_number, pd.parcel_number, pd.land_area_acres, pd.source_quarter_section];
  const dateFields = [rd.report_date, rd.effective_date, rd.inspection_date];
  const allFields = [...propertyFields, ...dateFields];
  const filledCount = allFields.filter((f) => f && f.toString().trim() !== "").length;

  return (
    <CollapsibleSection
      step={3}
      title="Property details"
      description="Owner, location and legal description, then the report's language and dates."
      icon={<Home />}
      filledCount={filledCount}
      totalCount={allFields.length}
      required
    >
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
        <Field label="Owner" required>
          <input required className={FIELD_CLASS} value={pd.owner_name} onChange={(e) => onChange("property_details", "owner_name", e.target.value)} placeholder="Owner name" />
        </Field>
        <Field label="Municipality" required>
          <input required className={FIELD_CLASS} value={pd.municipality} onChange={(e) => onChange("property_details", "municipality", e.target.value)} placeholder="City or rural municipality" />
        </Field>
        <Field label="Address" required span={2}>
          <input required className={FIELD_CLASS} value={pd.address} onChange={(e) => onChange("property_details", "address", e.target.value)} placeholder="Street, city, province, postal code" />
        </Field>
        <Field label="Land description" required span={2}>
          <input required className={FIELD_CLASS} value={pd.land_description} onChange={(e) => onChange("property_details", "land_description", e.target.value)} placeholder="Legal description as on the title" />
        </Field>
        <Field label="Title number" required>
          <input required className={FIELD_CLASS} value={pd.title_number} onChange={(e) => onChange("property_details", "title_number", e.target.value)} placeholder="Title #" />
        </Field>
        <Field label="Parcel number" required>
          <input required className={FIELD_CLASS} value={pd.parcel_number} onChange={(e) => onChange("property_details", "parcel_number", e.target.value)} placeholder="Parcel ID" />
        </Field>
        <Field label="Land area (acres)" required>
          <input required className={FIELD_CLASS} value={pd.land_area_acres} onChange={(e) => onChange("property_details", "land_area_acres", e.target.value)} placeholder="160" inputMode="decimal" />
        </Field>
        <Field label="Quarter section" required>
          <input required className={FIELD_CLASS} value={pd.source_quarter_section} onChange={(e) => onChange("property_details", "source_quarter_section", e.target.value)} placeholder="NE 12-34-5" />
        </Field>
      </div>

      <div className="mt-4 grid gap-x-4 gap-y-3 border-t border-[var(--app-border)] pt-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Report language">
          <select className={FIELD_CLASS} value={details.language || "en"} onChange={(e) => onLanguageChange(e.target.value as "en" | "fr" | "es")}>
            <option value="en">English</option>
            <option value="fr">French</option>
            <option value="es">Spanish</option>
          </select>
        </Field>
        <Field label="Report date" required>
          <input type="date" required className={FIELD_CLASS} value={rd.report_date} onChange={(e) => onChange("report_dates", "report_date", e.target.value)} />
        </Field>
        <Field label="Effective date" required>
          <input type="date" required className={FIELD_CLASS} value={rd.effective_date} onChange={(e) => onChange("report_dates", "effective_date", e.target.value)} />
        </Field>
        <Field label="Inspection date" required>
          <input type="date" required className={FIELD_CLASS} value={rd.inspection_date} onChange={(e) => onChange("report_dates", "inspection_date", e.target.value)} />
        </Field>
      </div>
    </CollapsibleSection>
  );
}
