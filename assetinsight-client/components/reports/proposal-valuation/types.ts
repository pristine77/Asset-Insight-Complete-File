export type ProposalValuationMarketCheck = {
  comparable_count: "" | "High" | "Moderate" | "Low";
  avg_retail_asking_price: "" | "High" | "Moderate" | "Low";
  market_saturation: "" | "Low" | "Moderate" | "High";
  market_velocity: "" | "Fast" | "Normal" | "Slow";
  regional_demand: "" | "Strong" | "Average" | "Weak";
  notes: string;
};

export type ProposalValuationEvaluator = {
  id: string;
  name: string;
  user_id?: string;
  email?: string;
  avatar_url?: string;
};

export type ProposalValuationPermissions = {
  canManageEvaluators: boolean;
  canEditAll: boolean;
  evaluatorColumnId: string | null;
  canRegenerateFiles: boolean;
};

export type ProposalValuationParticipant = {
  id: string;
  username?: string;
  companyName?: string;
  email: string;
  avatarUrl?: string;
  columnId: string | null;
  isOwner: boolean;
};

export type ProposalValuationCandidate = {
  id: string;
  username?: string;
  companyName?: string;
  email: string;
  avatarUrl?: string;
};

export type ProposalValuationRow = {
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
  market_check: ProposalValuationMarketCheck;
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

export type ProposalValuationFileSummary = {
  buyers_premium_basis: "uncapped" | "capped";
  total_risk_weighted_value: number | null;
  file_risk_multiplier: number | null;
  commission_percent_no_guarantee: number | null;
  offer2_nmg_percent: number;
  capped_threshold_percent: number;
};

export type ProposalValuationSheet = {
  evaluator_columns: ProposalValuationEvaluator[];
  rows: ProposalValuationRow[];
  file_summary: ProposalValuationFileSummary;
};

export type ProposalValuationCalculation = {
  key: string;
  label: string;
  formula: string;
  inputs: Record<string, number | string | null>;
  value: number | string | null;
};

export type ProposalValuationDerivedSummary = {
  row_appraiser_averages: Record<string, number>;
  total_asset_value: number;
  total_low_est_value: number;
  total_high_est_value: number;
  total_capped_bp: number;
  total_projected_costs: number;
  low_risk_value: number;
  medium_risk_value: number;
  high_risk_value: number;
  low_risk_percent: number | null;
  medium_risk_percent: number | null;
  high_risk_percent: number | null;
  weighted_average_risk_score: number;
  overall_file_risk_rating: "Low" | "Medium" | "High";
  selected_nmg: number;
  selected_cash_purchase_price: number;
  selected_commission_basis_value: number;
  uncapped: {
    get: number;
    costs: number;
    get_after_costs: number;
    adjusted_get: number;
    bp_15: number;
    potential_get: number;
    adjusted_potential_get: number;
    potential_bp_15: number;
    offer1_cash_offer: number;
    offer1_total_costs: number;
    offer1_mcd_take: number;
    offer1_roi: number | null;
    offer1_risk: number;
    offer2_nmg: number;
    offer2_threshold: number;
    offer2_upper_value: number;
    offer2_total_costs: number;
    offer2_aquajets_take: number;
    offer2_overage: number;
    offer2_mcd_take: number;
    offer2_roi: number | null;
    offer2_risk: number;
    aquajets_potential_take: number;
    mcd_potential_take: number;
    potential_roi: number | null;
    offer3_mcd_take: number;
  };
  capped: {
    avg: number;
    high: number;
    low: number;
    bp: number;
    sale_total_inc_bp: number;
    ads: number;
    svr: number;
    refurb: number;
    total_cost: number;
    nmg: number;
    threshold: number;
    risk: number | null;
  };
};

export type ProposalValuationPayload = {
  reportId?: string;
  title: string;
  variant?: "assetScheduleSheet";
  meta?: Array<{ label: string; value: string }>;
  currencyCode?: string;
  assetScheduleSheet: ProposalValuationSheet;
  revision?: number;
  permissions?: ProposalValuationPermissions;
  participants?: ProposalValuationParticipant[];
  summary?: ProposalValuationDerivedSummary;
  calculationVersion?: string;
  calculations?: ProposalValuationCalculation[];
  idempotent?: boolean;
  files_regeneration_queued?: boolean;
  files_regeneration_coalesced?: boolean;
};

export type ProposalValuationListItem = {
  reportId: string;
  title: string;
  contractNo?: string;
  status: string;
  role: "owner" | "evaluator";
  updatedAt: string;
  revision: number;
  participantCount: number;
  currencyCode?: string;
};

export type ProposalValuationChange = {
  lotId: string | null;
  field: string;
  value: unknown;
};
