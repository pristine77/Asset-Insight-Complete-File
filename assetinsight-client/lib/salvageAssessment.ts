// Transport-only copy of backend src/service/salvageAssessment.ts, schema v2.
// Keep the exported type block synchronized across independently deployed repositories.
// Do not reproduce valuation arithmetic or provider verification in clients.
/** Read-only photo extraction, separate from the appraiser's editable values. */
export type SalvageVehicleOverrides = Record<string, string | null>;
export interface SalvageVehicleEvidence {
  photoId: string;
  value: string | null;
  evidence: string;
  accepted: boolean;
  rejectionReason: string | null;
}
export interface SalvageVehicleField {
  key: string;
  label: string;
  value: string | null;
  status: "observed" | "unknown" | "conflict" | "manual";
  evidence: SalvageVehicleEvidence[];
  type?: "text" | "number" | "select" | "checkbox";
  options?: string[];
  required?: boolean;
  source?: "standard" | "workbook";
  manualOverride?: { value: string | null; source: "manual" | "supplied" } | null;
}
export interface SalvageVehicleDetails {
  schemaVersion: 1;
  category: string | null;
  fields: SalvageVehicleField[];
  warnings: string[];
}

/** Server-owned, auditable assessment. Legacy snapshots without this object stay legacy. */
export const SALVAGE_ASSESSMENT_VERSION = 2 as const;
export type SalvageBasket = "pre_loss" | "as_is";
export type SalvagePriceBasis = "sold" | "asking" | "reserve" | "current_bid" | "unknown";
export interface SalvageReference {
  id: string;
  kind: "web" | "appraiser" | "photo";
  url: string | null;
  title: string;
  publisher: string | null;
  accessedAt: string | null;
  /** Saved source text, not an AI assertion that the URL was consulted. */
  excerpt: string;
  photoIds: string[];
}
export interface SalvageFieldEvidence { referenceId: string; quote: string }
export interface SalvageAdjustment {
  description: string;
  amount: number | null;
  referenceIds: string[];
  appraiserReason: string | null;
}
export interface SalvageComparableEvidence {
  id: string;
  basket: SalvageBasket;
  title: string;
  url: string | null;
  sourceName: string | null;
  listingId: string | null;
  vin: string | null;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  powertrain: string | null;
  odometer: number | null;
  odometerUnit: "km" | "mi" | null;
  condition: string | null;
  brand: string | null;
  location: string | null;
  province: string | null;
  country: string | null;
  eventDate: string | null;
  price: number | null;
  currency: string | null;
  priceBasis: SalvagePriceBasis;
  verification: "verified" | "unverified" | "appraiser_supplied";
  evidence: Record<string, SalvageFieldEvidence>;
  referenceIds: string[];
  adjustments: SalvageAdjustment[];
  fx: { cadPerUnit: number; date: string; referenceId: string } | null;
  appraiserReason: string | null;
  photoIds: string[];
  eligible: boolean;
  selected: boolean;
  exclusionReasons: string[];
  adjustedPrice: number | null;
  ageDays: number | null;
}
export interface SalvagePhotoFinding {
  photoId: string;
  status: "analyzed" | "not_analyzed";
  observations: string[];
  facts: { field: string; value: string | null; evidence: string; source: "observed" | "supplied" }[];
  uncertainties: string[];
}
export interface SalvageCostInput {
  description: string;
  amount: number | null;
  referenceIds: string[];
  appraiserReason: string | null;
}
export interface SalvageRepairItem {
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  referenceIds: string[];
  appraiserReason: string | null;
}
export interface SalvageLabourItem {
  description: string;
  hours: number | null;
  rate: number | null;
  referenceIds: string[];
  appraiserReason: string | null;
}
export interface SalvageAssessmentInputs {
  /** Explicit appraiser corrections, kept separate from immutable photo evidence. */
  vehicleOverrides?: SalvageVehicleOverrides;
  year: number | null;
  make: string | null;
  model: string | null;
  trim: string | null;
  powertrain: string | null;
  vin: string | null;
  odometer: number | null;
  odometerUnit: "km" | "mi" | null;
  province: string | null;
  market: string | null;
  effectiveDate: string | null;
  lossType: string | null;
  condition: string | null;
  damageDescription: string | null;
  documentedBrand: string | null;
  brandProvince: string | null;
  brandEvidenceRef: string | null;
  currency: "CAD";
  repairItems: SalvageRepairItem[];
  labourItems: SalvageLabourItem[];
  charges: SalvageCostInput[];
  /** Null means not established. Explicit, documented zero is valid. */
  sellerCosts: { fees: SalvageCostInput | null; transport: SalvageCostInput | null;
    storage: SalvageCostInput | null; disposal: SalvageCostInput | null };
  suppliedComparables: SalvageComparableEvidence[];
  suppliedReferences: SalvageReference[];
  overrides: { preLoss: SalvageCostInput | null; asIs: SalvageCostInput | null };
}
export interface SalvageValueConclusion {
  amount: number | null;
  low: number | null;
  high: number | null;
  currency: "CAD";
  priceBasis: "sold" | "asking" | null;
  status: "supported" | "provisional" | "insufficient_evidence" | "appraiser_override";
  comparableIds: string[];
  method: string;
  referenceIds: string[];
}
export interface SalvageLimitation {
  code: string;
  message: string;
  severity: "warning" | "critical";
  acknowledgementRequired: boolean;
}
export interface SalvageAssessmentV2 {
  schemaVersion: 2;
  generatedAt: string;
  inputs: SalvageAssessmentInputs;
  /** Inputs at the paid research run: never rewritten by preview edits. */
  researchedInputs: SalvageAssessmentInputs;
  stale: boolean;
  photoFindings: SalvagePhotoFinding[];
  /** Absent for legacy reports until explicitly researched again. */
  vehicleDetails?: SalvageVehicleDetails;
  candidates: SalvageComparableEvidence[];
  comparables: SalvageComparableEvidence[];
  references: SalvageReference[];
  valuations: { preLoss: SalvageValueConclusion; asIs: SalvageValueConclusion };
  repairs: {
    parts: (SalvageRepairItem & { total: number | null })[];
    labour: (SalvageLabourItem & { total: number | null })[];
    charges: SalvageCostInput[];
    partsTotal: number | null; labourTotal: number | null; chargesTotal: number | null;
    knownSubtotal: number; total: number | null; status: "complete" | "incomplete";
  };
  netRecovery: { gross: number | null; deductions: SalvageAssessmentInputs["sellerCosts"];
    knownDeductions: number; total: number | null; status: "complete" | "incomplete"; formula: string };
  limitations: SalvageLimitation[];
  research: Record<string, unknown>;
}

/** A structural display guard; the backend alone verifies/calculates this object. */
export function isSalvageAssessmentV2(value: unknown): value is SalvageAssessmentV2 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const isObject = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
  return row.schemaVersion === 2 && typeof row.generatedAt === "string" && typeof row.stale === "boolean"
    && isObject(row.inputs) && isObject(row.valuations) && isObject(row.repairs) && isObject(row.netRecovery)
    && [row.photoFindings, row.candidates, row.comparables, row.references, row.limitations].every(Array.isArray);
}
export function formatAssessmentMoney(value: unknown, language = "en", currency = "CAD"): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return language === "fr" ? "Indisponible" : language === "es" ? "No disponible" : "Unavailable";
  const locale = language === "fr" ? "fr-CA" : language === "es" ? "es-CA" : "en-CA";
  const code = /^[A-Z]{3}$/.test(currency) ? currency : "CAD";
  return new Intl.NumberFormat(locale, { style: "currency", currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}
export function salvageRequiredAcknowledgements(assessment: SalvageAssessmentV2): SalvageLimitation[] {
  return assessment.limitations.filter((item) => item && item.acknowledgementRequired === true);
}
