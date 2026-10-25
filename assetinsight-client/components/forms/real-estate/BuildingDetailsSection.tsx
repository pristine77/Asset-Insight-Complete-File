"use client";

import { Building2 } from "lucide-react";
import CollapsibleSection from "./CollapsibleSection";
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

export default function BuildingDetailsSection({
  details,
  onChange,
  onKnownIssuesChange,
}: BuildingDetailsSectionProps) {
  const hd = details.house_details;
  const fields = [hd.year_built, hd.square_footage, hd.lot_size_sqft, hd.number_of_rooms, hd.number_of_full_bathrooms, hd.number_of_half_bathrooms];
  const filledCount = fields.filter((f) => f && f.toString().trim() !== "").length;

  const inputClass = "w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] from-gray-50 via-white to-gray-100 px-3 py-2.5 text-sm text-[var(--app-text)] shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500/60 focus:border-blue-400 focus:shadow-sm transition-all placeholder:text-[var(--app-text-muted)] hover:border-gray-400";
  const labelClass = "block text-[11px] font-bold text-[var(--app-text-muted)] mb-1.5 tracking-wide uppercase drop-shadow-sm";

  return (
    <CollapsibleSection title="Building Details" icon={<Building2 />} filledCount={filledCount} totalCount={fields.length} required>
      <div className="grid gap-2 grid-cols-3">
        <div>
          <label className={labelClass}>Year Built *</label>
          <input required type="number" className={inputClass} value={hd.year_built} onChange={(e) => onChange("house_details", "year_built", e.target.value)} placeholder="2005" />
        </div>
        <div>
          <label className={labelClass}>Sq Ft *</label>
          <input required type="number" className={inputClass} value={hd.square_footage} onChange={(e) => onChange("house_details", "square_footage", e.target.value)} placeholder="2500" />
        </div>
        <div>
          <label className={labelClass}>Lot (sqft) *</label>
          <input required type="number" className={inputClass} value={hd.lot_size_sqft} onChange={(e) => onChange("house_details", "lot_size_sqft", e.target.value)} placeholder="8000" />
        </div>
        <div>
          <label className={labelClass}>Beds *</label>
          <input required type="number" className={inputClass} value={hd.number_of_rooms} onChange={(e) => onChange("house_details", "number_of_rooms", e.target.value)} placeholder="4" />
        </div>
        <div>
          <label className={labelClass}>Full Bath *</label>
          <input required type="number" className={inputClass} value={hd.number_of_full_bathrooms} onChange={(e) => onChange("house_details", "number_of_full_bathrooms", e.target.value)} placeholder="2" />
        </div>
        <div>
          <label className={labelClass}>Half Bath *</label>
          <input required type="number" className={inputClass} value={hd.number_of_half_bathrooms} onChange={(e) => onChange("house_details", "number_of_half_bathrooms", e.target.value)} placeholder="1" />
        </div>
        <div className="col-span-3">
          <label className={labelClass}>Known Issues</label>
          <input className={inputClass} value={hd.known_issues?.join(", ") || ""} onChange={(e) => onKnownIssuesChange(e.target.value)} placeholder="Roof repair, Old furnace..." />
        </div>
      </div>
    </CollapsibleSection>
  );
}
