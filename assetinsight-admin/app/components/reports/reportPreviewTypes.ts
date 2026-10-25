import type { SalvageAssessmentInputs, SalvageAssessmentV2 } from "@/lib/salvageAssessment";
import type { SalvageReportContext, SalvageReportEnrichment } from "@/lib/salvageReportEnrichment";
export type { SalvageAssessmentInputs, SalvageAssessmentV2 } from "@/lib/salvageAssessment";

export type ReportPreviewField = {
  label: string;
  value: string;
};

export type AssetAdminScheduleMarketCheck = {
  comparable_count: "" | "High" | "Moderate" | "Low";
  avg_retail_asking_price: "" | "High" | "Moderate" | "Low";
  market_saturation: "" | "Low" | "Moderate" | "High";
  market_velocity: "" | "Fast" | "Normal" | "Slow";
  regional_demand: "" | "Strong" | "Average" | "Weak";
  notes: string;
};

export type AssetAdminScheduleBuyersPremiumBasis = "uncapped" | "capped";

export type AssetAdminScheduleFileSummary = {
  buyers_premium_basis: AssetAdminScheduleBuyersPremiumBasis;
  total_risk_weighted_value: number | null;
  file_risk_multiplier: number | null;
  commission_percent_no_guarantee: number | null;
  offer2_nmg_percent: number;
  capped_threshold_percent: number;
};

export type AssetAdminScheduleEvaluatorColumn = {
  id: string;
  name: string;
  user_id?: string;
  email?: string;
  avatar_url?: string;
};

export type AssetAdminScheduleEvaluatorOption = {
  id: string;
  username?: string;
  companyName?: string;
  email: string;
  avatarUrl?: string;
};

export type AssetAdminScheduleRow = {
  lot_id: string;
  asset_id: string;
  asset_category: string;
  year: string;
  make: string;
  model: string;
  serial_number: string;
  cr_details: string;
  condition_score: string;
  location: string;
  pictures: number;
  picture_urls: string[];
  market_check: AssetAdminScheduleMarketCheck;
  asset_insight: string;
  evaluator_values: Record<string, number | null>;
  low_est_sale_value: number | null;
  high_est_sale_value: number | null;
  buyer_premium_percent: number;
  buyer_premium_amount: number | null;
  total_expected_gross: number | null;
  allocated_value: number | null;
  notes: string;
  cleaning: number | null;
  lien_search: number | null;
  video_cost: number | null;
  lotting_fee: number | null;
  advertising: number | null;
};

export type AssetAdminScheduleSheet = {
  evaluator_columns: AssetAdminScheduleEvaluatorColumn[];
  rows: AssetAdminScheduleRow[];
  file_summary: AssetAdminScheduleFileSummary;
};

export type AssetAdminScheduleCalculation = {
  key: string;
  label: string;
  value: number | string | null;
  formula: string;
  inputs: Record<string, number | string | null>;
};

export type ReportPreviewPayload = {
  reportId?: string;
  title: string;
  meta: ReportPreviewField[];
  data: Record<string, unknown> & {
    readonly assessment?: SalvageAssessmentV2;
    assessment_inputs?: Partial<SalvageAssessmentInputs>;
    readonly report_enrichment?: SalvageReportEnrichment;
    report_context?: SalvageReportContext;
  };
  variant?: "assetScheduleSheet";
  currencyCode?: string;
  assetScheduleSheet?: AssetAdminScheduleSheet;
  /** Server-projected intrinsic owner column; not an editable assignment. */
  ownerColumnId?: string | null;
  revision?: number;
  summary?: Record<string, unknown>;
  calculationVersion?: string;
  calculations?: AssetAdminScheduleCalculation[];
  files_regeneration_queued?: boolean;
  files_regeneration_coalesced?: boolean;
  files_regeneration_warning?: string;
};
