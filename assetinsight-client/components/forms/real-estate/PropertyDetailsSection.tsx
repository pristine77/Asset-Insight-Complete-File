"use client";

import { Home } from "lucide-react";
import CollapsibleSection from "./CollapsibleSection";
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

  const inputClass = "w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] from-gray-50 via-white to-gray-100 px-3 py-2.5 text-sm text-[var(--app-text)] shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/60 focus:border-blue-400 focus:shadow-sm transition-all placeholder:text-[var(--app-text-muted)] hover:border-gray-400";
  const labelClass = "block text-[11px] font-bold text-[var(--app-text-muted)] mb-1.5 tracking-wide uppercase drop-shadow-sm";

  return (
    <CollapsibleSection title="Property Details" icon={<Home />} filledCount={filledCount} totalCount={allFields.length} required>
      {/* Language */}
      <div className="flex items-center gap-2 mb-2 pb-2 border-b border-[var(--app-border)]">
        <span className="text-[11px] text-[var(--app-text-muted)]">Lang:</span>
        <select
          className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] from-gray-50 via-white to-gray-100 px-2.5 py-1.5 text-xs text-[var(--app-text)] shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/60 focus:border-blue-400 transition-all cursor-pointer hover:border-gray-400"
          value={details.language || "en"}
          onChange={(e) => onLanguageChange(e.target.value as "en" | "fr" | "es")}
        >
          <option value="en">EN</option>
          <option value="fr">FR</option>
          <option value="es">ES</option>
        </select>
      </div>

      <div className="grid gap-2 grid-cols-2">
        <div>
          <label className={labelClass}>Owner *</label>
          <input required className={inputClass} value={pd.owner_name} onChange={(e) => onChange("property_details", "owner_name", e.target.value)} placeholder="Owner name" />
        </div>
        <div>
          <label className={labelClass}>Municipality *</label>
          <input required className={inputClass} value={pd.municipality} onChange={(e) => onChange("property_details", "municipality", e.target.value)} placeholder="City" />
        </div>
        <div className="col-span-2">
          <label className={labelClass}>Address *</label>
          <input required className={inputClass} value={pd.address} onChange={(e) => onChange("property_details", "address", e.target.value)} placeholder="Full address" />
        </div>
        <div className="col-span-2">
          <label className={labelClass}>Land Description *</label>
          <input required className={inputClass} value={pd.land_description} onChange={(e) => onChange("property_details", "land_description", e.target.value)} placeholder="Legal description" />
        </div>
        <div>
          <label className={labelClass}>Title # *</label>
          <input required className={inputClass} value={pd.title_number} onChange={(e) => onChange("property_details", "title_number", e.target.value)} placeholder="Title #" />
        </div>
        <div>
          <label className={labelClass}>Parcel # *</label>
          <input required className={inputClass} value={pd.parcel_number} onChange={(e) => onChange("property_details", "parcel_number", e.target.value)} placeholder="Parcel ID" />
        </div>
        <div>
          <label className={labelClass}>Land Area (ac) *</label>
          <input required className={inputClass} value={pd.land_area_acres} onChange={(e) => onChange("property_details", "land_area_acres", e.target.value)} placeholder="160" />
        </div>
        <div>
          <label className={labelClass}>Quarter Section *</label>
          <input required className={inputClass} value={pd.source_quarter_section} onChange={(e) => onChange("property_details", "source_quarter_section", e.target.value)} placeholder="NE 12-34-5" />
        </div>
      </div>

      {/* Dates */}
      <div className="mt-2 pt-2 border-t border-[var(--app-border)]">
        <div className="grid gap-2 grid-cols-3">
          <div>
            <label className={labelClass}>Report Date *</label>
            <input type="date" required className={inputClass} value={rd.report_date} onChange={(e) => onChange("report_dates", "report_date", e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>Effective *</label>
            <input type="date" required className={inputClass} value={rd.effective_date} onChange={(e) => onChange("report_dates", "effective_date", e.target.value)} />
          </div>
          <div>
            <label className={labelClass}>Inspection *</label>
            <input type="date" required className={inputClass} value={rd.inspection_date} onChange={(e) => onChange("report_dates", "inspection_date", e.target.value)} />
          </div>
        </div>
      </div>
    </CollapsibleSection>
  );
}
