"use client";

import { Wheat, TrendingUp, FileText, DollarSign, Building2 } from "lucide-react";
import CollapsibleSection from "./CollapsibleSection";
import type { RealEstateDetails } from "@/services/realEstate";

interface FarmlandDetailsSectionProps {
  details: RealEstateDetails;
  onChange: <K extends keyof NonNullable<RealEstateDetails["farmland_details"]>>(
    field: K,
    value: NonNullable<RealEstateDetails["farmland_details"]>[K]
  ) => void;
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

export default function FarmlandDetailsSection({ details, onChange }: FarmlandDetailsSectionProps) {
  const fd = details.farmland_details;
  const fields = [fd?.total_title_acres, fd?.cultivated_acres, fd?.rm_area, fd?.soil_class, fd?.crop_type, fd?.access_quality, fd?.distance_to_city_km];
  const filledCount = fields.filter((f) => f !== undefined && f !== null && f !== "").length;

  const inputClass = "w-full rounded-lg border border-emerald-300/80 bg-[var(--app-panel)] from-emerald-50/50 via-white to-emerald-100/40 px-3 py-2.5 text-sm text-[var(--app-text)] shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/60 focus:border-emerald-400 focus:shadow-sm transition-all placeholder:text-[var(--app-text-muted)] hover:border-emerald-400";
  const labelClass = "block text-[11px] font-bold text-[var(--app-text-muted)] mb-1.5 tracking-wide uppercase drop-shadow-sm";

  return (
    <CollapsibleSection title="Farmland" icon={<Wheat className="text-emerald-600" />} filledCount={filledCount} totalCount={fields.length} variant="success" required>
      <div className="space-y-4">
        {/* Basic Farmland Details */}
        <div className="grid gap-2 grid-cols-2 lg:grid-cols-3">
          <div>
            <label className={labelClass}>Total Title Acres *</label>
            <input required type="number" min="0" className={inputClass} value={fd?.total_title_acres ?? ""} onChange={(e) => onChange("total_title_acres", e.target.value ? parseFloat(e.target.value) : undefined)} placeholder="160" />
          </div>
          <div>
            <label className={labelClass}>Cultivated Acres *</label>
            <input required type="number" min="0" className={inputClass} value={fd?.cultivated_acres ?? ""} onChange={(e) => onChange("cultivated_acres", e.target.value ? parseFloat(e.target.value) : undefined)} placeholder="150" />
          </div>
          <div>
            <label className={labelClass}>RM / Area *</label>
            <input required className={inputClass} value={fd?.rm_area || ""} onChange={(e) => onChange("rm_area", e.target.value)} placeholder="RM of Corman Park" />
          </div>
          <div>
            <label className={labelClass}>Soil Class *</label>
            <select required className={inputClass} value={fd?.soil_class || ""} onChange={(e) => onChange("soil_class", e.target.value)}>
              <option value="">Select</option>
              <option value="1">1-Excellent</option>
              <option value="2">2-Good</option>
              <option value="3">3-Average</option>
              <option value="4">4-Fair</option>
              <option value="5">5-Poor</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Crop Type *</label>
            <input required className={inputClass} value={fd?.crop_type || ""} onChange={(e) => onChange("crop_type", e.target.value)} placeholder="Wheat, Canola" />
          </div>
          <div>
            <label className={labelClass}>Access Quality *</label>
            <select required className={inputClass} value={fd?.access_quality || "good"} onChange={(e) => onChange("access_quality", e.target.value as any)}>
              <option value="excellent">Excellent</option>
              <option value="good">Good</option>
              <option value="fair">Fair</option>
              <option value="poor">Poor</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Dist. to City (km) *</label>
            <input required type="number" min="0" className={inputClass} value={fd?.distance_to_city_km ?? ""} onChange={(e) => onChange("distance_to_city_km", e.target.value ? parseFloat(e.target.value) : undefined)} placeholder="25" />
          </div>
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-1.5 text-[11px] text-[var(--app-text-muted)] cursor-pointer">
              <input type="checkbox" className="h-4 w-4 rounded border-[var(--app-border)] text-emerald-600" checked={fd?.is_rented || false} onChange={(e) => onChange("is_rented", e.target.checked)} />
              Rented
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-[var(--app-text-muted)] cursor-pointer">
              <input type="checkbox" className="h-4 w-4 rounded border-[var(--app-border)] text-emerald-600" checked={fd?.irrigation || false} onChange={(e) => onChange("irrigation", e.target.checked)} />
              Irrigation
            </label>
          </div>
          {fd?.is_rented && (
            <div>
              <label className={labelClass}>Annual Rent ($/acre)</label>
              <input type="number" min="0" className={inputClass} value={fd?.annual_rent_per_acre ?? ""} onChange={(e) => onChange("annual_rent_per_acre", e.target.value ? parseFloat(e.target.value) : undefined)} placeholder="80" />
            </div>
          )}
        </div>

        {/* Valuation Method Selection */}
        <div className="border-t border-emerald-200 pt-3">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="h-4 w-4 text-emerald-600" />
            <span className="text-xs font-bold text-[var(--app-text-muted)] uppercase tracking-wide">Valuation Approaches</span>
            <span className="text-[10px] text-[var(--app-text-muted)] ml-auto">(Select one or more)</span>
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 p-2.5 rounded-lg border border-emerald-200 bg-emerald-50/50 cursor-pointer hover:bg-emerald-100/50 transition-colors">
              <input 
                type="checkbox" 
                className="h-4 w-4 rounded border-emerald-400 text-emerald-600 focus:ring-emerald-500" 
                checked={fd?.use_direct_comparable || false} 
                onChange={(e) => onChange("use_direct_comparable", e.target.checked)} 
              />
              <div>
                <span className="text-sm font-semibold text-[var(--app-text)]">1. Direct Comparable Approach</span>
                <p className="text-[10px] text-[var(--app-text-muted)]">Software finds comparable farmland sales and calculates adjustments</p>
              </div>
            </label>
            <label className="flex items-center gap-2 p-2.5 rounded-lg border border-amber-200 bg-amber-50/50 cursor-pointer hover:bg-amber-100/50 transition-colors">
              <input 
                type="checkbox" 
                className="h-4 w-4 rounded border-amber-400 text-amber-600 focus:ring-amber-500" 
                checked={fd?.use_income_approach || false} 
                onChange={(e) => onChange("use_income_approach", e.target.checked)} 
              />
              <div>
                <span className="text-sm font-semibold text-[var(--app-text)]">2. Income Capitalization Approach</span>
                <p className="text-[10px] text-[var(--app-text-muted)]">For rented/cultivated portions - calculates value based on rental income</p>
              </div>
            </label>
            <label className="flex items-center gap-2 p-2.5 rounded-lg border border-blue-200 bg-blue-50/50 cursor-pointer hover:bg-blue-100/50 transition-colors">
              <input 
                type="checkbox" 
                className="h-4 w-4 rounded border-blue-400 text-blue-600 focus:ring-blue-500" 
                checked={fd?.use_cost_approach || false} 
                onChange={(e) => onChange("use_cost_approach", e.target.checked)} 
              />
              <div>
                <span className="text-sm font-semibold text-[var(--app-text)]">3. Cost Approach</span>
                <p className="text-[10px] text-[var(--app-text-muted)]">Software calculates land value, replacement cost, and depreciation automatically</p>
              </div>
            </label>
          </div>
        </div>

        {/* Direct Comparable Subject Details (shown when approach is selected) */}
        {fd?.use_direct_comparable && (
          <div className="border border-emerald-300 rounded-xl p-3 bg-[var(--app-panel)] from-emerald-50/80 to-white">
            <div className="flex items-center gap-2 mb-3">
              <FileText className="h-4 w-4 text-emerald-600" />
              <span className="text-xs font-bold text-[var(--app-text-muted)] uppercase tracking-wide">Subject Property Details</span>
            </div>
            <div className="grid gap-2 grid-cols-1 lg:grid-cols-2">
              <div>
                <label className={labelClass}>Subject Name *</label>
                <input 
                  required={fd?.use_direct_comparable}
                  className={inputClass} 
                  value={fd?.subject_name || ""} 
                  onChange={(e) => onChange("subject_name", e.target.value)} 
                  placeholder="Langham Area Quarter Section" 
                />
              </div>
              <div>
                <label className={labelClass}>Valuation Date *</label>
                <input 
                  required={fd?.use_direct_comparable}
                  type="date" 
                  className={inputClass} 
                  value={fd?.valuation_date || isoDate(new Date())} 
                  onChange={(e) => onChange("valuation_date", e.target.value)} 
                />
              </div>
              <div className="lg:col-span-2">
                <label className={labelClass}>Notes</label>
                <textarea 
                  className={`${inputClass} min-h-[60px] resize-none`}
                  value={fd?.notes || ""} 
                  onChange={(e) => onChange("notes", e.target.value)} 
                  placeholder="Vacant agricultural land near Langham, typical quality for area. Good access, no buildings..."
                  rows={2}
                />
              </div>
            </div>
            <div className="mt-2 p-2 rounded-lg bg-emerald-100/50 border border-emerald-200">
              <p className="text-[10px] text-emerald-700">
                <strong>Software will search for:</strong> Recent comparable farmland sales in the area, calculate adjustments for time, size, location, soil quality, and access, then provide a weighted average rate per cultivated acre.
              </p>
            </div>
          </div>
        )}

        {/* Income Capitalization Approach Details (shown when approach is selected) */}
        {fd?.use_income_approach && (
          <div className="border border-amber-300 rounded-xl p-3 bg-[var(--app-panel)] from-amber-50/80 to-white">
            <div className="flex items-center gap-2 mb-3">
              <DollarSign className="h-4 w-4 text-amber-600" />
              <span className="text-xs font-bold text-[var(--app-text-muted)] uppercase tracking-wide">Income Capitalization Inputs</span>
            </div>
            <div className="grid gap-2 grid-cols-2 lg:grid-cols-4">
              <div>
                <label className={labelClass}>Market Rent ($/acre) *</label>
                <input 
                  required={fd?.use_income_approach}
                  type="number" 
                  step="0.01"
                  className={inputClass.replace(/border-emerald/g, "border-amber").replace(/emerald/g, "amber")} 
                  min="0"
                  value={fd?.market_rent_per_acre ?? ""}
                  onChange={(e) => onChange("market_rent_per_acre", e.target.value ? parseFloat(e.target.value) : undefined)} 
                  placeholder="80" 
                />
              </div>
              <div>
                <label className={labelClass}>Vacancy Loss (%) *</label>
                <input 
                  required={fd?.use_income_approach}
                  type="number" 
                  step="0.1"
                  className={inputClass.replace(/border-emerald/g, "border-amber").replace(/emerald/g, "amber")} 
                  value={fd?.vacancy_loss_percent ?? 2} 
                  min="0" max="100"
                  onChange={(e) => onChange("vacancy_loss_percent", e.target.value ? parseFloat(e.target.value) : undefined)} 
                  placeholder="2" 
                />
              </div>
              <div>
                <label className={labelClass}>Operating Expense (%) *</label>
                <input 
                  required={fd?.use_income_approach}
                  type="number" 
                  step="0.1"
                  className={inputClass.replace(/border-emerald/g, "border-amber").replace(/emerald/g, "amber")} 
                  value={fd?.operating_expense_ratio ?? 20} 
                  min="0" max="100"
                  onChange={(e) => onChange("operating_expense_ratio", e.target.value ? parseFloat(e.target.value) : undefined)} 
                  placeholder="20" 
                />
              </div>
              <div>
                <label className={labelClass}>Cap Rate (%) *</label>
                <input 
                  required={fd?.use_income_approach}
                  type="number" 
                  step="0.1"
                  className={inputClass.replace(/border-emerald/g, "border-amber").replace(/emerald/g, "amber")} 
                  value={fd?.cap_rate ?? 5} 
                  min="0.1"
                  onChange={(e) => onChange("cap_rate", e.target.value ? parseFloat(e.target.value) : undefined)} 
                  placeholder="5" 
                />
              </div>
            </div>
            <div className="mt-2 p-2 rounded-lg bg-amber-100/50 border border-amber-200">
              <p className="text-[10px] text-amber-700">
                <strong>Software will calculate:</strong> Potential Gross Income, Effective Gross Income, Net Operating Income, and Indicated Value using the Income Capitalization formula.
              </p>
            </div>
          </div>
        )}

        {/* Cost Approach info (shown when approach is selected) */}
        {fd?.use_cost_approach && (
          <div className="border border-blue-300 rounded-xl p-3 bg-[var(--app-panel)] from-blue-50/80 to-white">
            <div className="flex items-center gap-2 mb-2">
              <Building2 className="h-4 w-4 text-blue-600" />
              <span className="text-xs font-bold text-[var(--app-text-muted)] uppercase tracking-wide">Cost Approach (Software-Calculated)</span>
            </div>
            <div className="p-2 rounded-lg bg-blue-100/50 border border-blue-200">
              <p className="text-[10px] text-blue-700">
                <strong>Software will estimate:</strong> Land Value, Replacement Cost New, Physical Depreciation, Functional Obsolescence, External Obsolescence, and calculate Total Depreciation and Depreciated Cost of Improvements automatically based on property details and images.
              </p>
            </div>
          </div>
        )}

        {/* Reconciliation note when multiple approaches selected */}
        {((fd?.use_direct_comparable ? 1 : 0) + (fd?.use_income_approach ? 1 : 0) + (fd?.use_cost_approach ? 1 : 0)) >= 2 && (
          <div className="p-3 rounded-lg bg-[var(--app-panel)] from-emerald-100/50 via-amber-100/50 to-blue-100/50 border border-[var(--app-border)]">
            <p className="text-xs text-[var(--app-text-muted)]">
              <strong>📊 Reconciliation:</strong> When multiple approaches are selected, the final value will be reconciled using weighted averages based on the reliability of each approach for this property type.
            </p>
          </div>
        )}
      </div>
    </CollapsibleSection>
  );
}
