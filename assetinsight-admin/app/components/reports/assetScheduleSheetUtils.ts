import type {
  AssetAdminScheduleEvaluatorColumn,
  AssetAdminScheduleFileSummary,
  AssetAdminScheduleMarketCheck,
  AssetAdminScheduleRow,
  AssetAdminScheduleSheet,
} from "@/app/components/reports/reportPreviewTypes";

export type AssetScheduleRiskBucket = "Low" | "Medium" | "High";

export type AssetScheduleDerivedSummary = {
  evaluator_totals: Record<string, number>;
  row_appraiser_averages: Record<string, number>;
  total_asset_value: number;
  total_low_est_value: number;
  total_high_est_value: number;
  total_capped_bp: number;
  total_expected_gross: number;
  total_allocated_value: number;
  total_cleaning: number;
  total_lien_search: number;
  total_video_cost: number;
  total_lotting_fee: number;
  total_advertising: number;
  total_projected_costs: number;
  low_risk_value: number;
  medium_risk_value: number;
  high_risk_value: number;
  low_risk_percent: number | null;
  medium_risk_percent: number | null;
  high_risk_percent: number | null;
  weighted_average_risk_score: number;
  overall_file_risk_rating: AssetScheduleRiskBucket;
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

const MARKET_CHECK_SCORE_MAP: Record<
  keyof Omit<AssetAdminScheduleMarketCheck, "notes">,
  Record<string, number>
> = {
  comparable_count: { High: 1, Moderate: 2, Low: 3 },
  avg_retail_asking_price: { High: 1, Moderate: 2, Low: 3 },
  market_saturation: { Low: 1, Moderate: 2, High: 3 },
  market_velocity: { Fast: 1, Normal: 2, Slow: 3 },
  regional_demand: { Strong: 1, Average: 2, Weak: 3 },
};

export function cloneAssetScheduleSheet(sheet: AssetAdminScheduleSheet): AssetAdminScheduleSheet {
  return JSON.parse(JSON.stringify(sheet)) as AssetAdminScheduleSheet;
}

function toNumberOrNull(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const normalized = String(value).replace(/,/g, "").trim();
  if (!normalized) return null;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function toFiniteNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function divideOrNull(numerator: number, denominator: number) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }
  return numerator / denominator;
}

function normalizeRatio(value: number | null | undefined, fallback: number) {
  const parsed = toNumberOrNull(value);
  if (parsed === null) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function normalizeFileSummary(fileSummary: AssetAdminScheduleFileSummary | undefined): AssetAdminScheduleFileSummary {
  return {
    buyers_premium_basis: fileSummary?.buyers_premium_basis === "capped" ? "capped" : "uncapped",
    total_risk_weighted_value: toNumberOrNull(fileSummary?.total_risk_weighted_value),
    file_risk_multiplier: toNumberOrNull(fileSummary?.file_risk_multiplier),
    commission_percent_no_guarantee: toNumberOrNull(fileSummary?.commission_percent_no_guarantee),
    offer2_nmg_percent: normalizeRatio(fileSummary?.offer2_nmg_percent, 0.785),
    capped_threshold_percent: normalizeRatio(fileSummary?.capped_threshold_percent, 0.1),
  };
}

export function makeEvaluatorColumnId() {
  return `eval_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function recalculateRow(
  row: AssetAdminScheduleRow,
  evaluatorColumns: AssetAdminScheduleEvaluatorColumn[]
): AssetAdminScheduleRow {
  const evaluatorValues = Object.fromEntries(
    evaluatorColumns.map((column) => [column.id, toNumberOrNull(row.evaluator_values?.[column.id])])
  ) as Record<string, number | null>;

  const filledValues = Object.values(evaluatorValues).filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value)
  );

  const low = filledValues.length ? Math.min(...filledValues) : null;
  const high = filledValues.length ? Math.max(...filledValues) : null;
  const average = filledValues.length
    ? filledValues.reduce((sum, value) => sum + value, 0) / filledValues.length
    : null;
  const buyerPremiumPercent = 15;
  const buyerPremiumAmount = average === null ? null : Math.min(average * 0.15, 2000);
  const totalExpectedGross =
    average === null || buyerPremiumAmount === null ? null : average + buyerPremiumAmount;
  const allocatedValue = totalExpectedGross;
  const cleaning = high === null ? null : high * 0.01;
  const lottingFee = high === null ? null : high * 0.01;
  const advertising = high === null ? null : high * 0.01;

  return {
    ...row,
    market_check: {
      comparable_count: row.market_check?.comparable_count || "",
      avg_retail_asking_price: row.market_check?.avg_retail_asking_price || "",
      market_saturation: row.market_check?.market_saturation || "",
      market_velocity: row.market_check?.market_velocity || "",
      regional_demand: row.market_check?.regional_demand || "",
      notes: String(row.market_check?.notes || ""),
    },
    evaluator_values: evaluatorValues,
    low_est_sale_value: low,
    high_est_sale_value: high,
    buyer_premium_percent: buyerPremiumPercent,
    buyer_premium_amount: buyerPremiumAmount,
    total_expected_gross: totalExpectedGross,
    allocated_value: allocatedValue,
    cleaning,
    lotting_fee: lottingFee,
    advertising,
    lien_search: toNumberOrNull(row.lien_search),
    video_cost: toNumberOrNull(row.video_cost),
  };
}

export function getRowAppraiserAverage(
  row: AssetAdminScheduleRow,
  evaluatorColumns: AssetAdminScheduleEvaluatorColumn[]
) {
  const values = evaluatorColumns
    .map((column) => toNumberOrNull(row.evaluator_values?.[column.id]))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getRiskScore(marketCheck: AssetAdminScheduleMarketCheck) {
  const scores = Object.entries(MARKET_CHECK_SCORE_MAP)
    .map(([field, scoreMap]) => scoreMap[marketCheck[field as keyof typeof MARKET_CHECK_SCORE_MAP]])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  if (!scores.length) return 2;
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

function getRiskBucket(score: number): AssetScheduleRiskBucket {
  if (score < 1.67) return "Low";
  if (score < 2.34) return "Medium";
  return "High";
}

export function deriveAssetScheduleSummary(sheet: AssetAdminScheduleSheet): AssetScheduleDerivedSummary {
  const evaluatorTotals = Object.fromEntries(sheet.evaluator_columns.map((column) => [column.id, 0]));
  const rowAverages: Record<string, number> = {};
  let totalAssetValue = 0;
  let totalLowEstValue = 0;
  let totalHighEstValue = 0;
  let totalCappedBp = 0;
  let totalExpectedGross = 0;
  let totalAllocatedValue = 0;
  let totalCleaning = 0;
  let totalLienSearch = 0;
  let totalVideoCost = 0;
  let totalLottingFee = 0;
  let totalAdvertising = 0;
  let totalProjectedCosts = 0;
  let lowRiskValue = 0;
  let mediumRiskValue = 0;
  let highRiskValue = 0;
  let weightedRiskScoreTotal = 0;

  for (const row of sheet.rows) {
    // Aggregate the complete sheet, independently of the table's current page.
    // Empty evaluator columns match Excel SUM (zero); individual row blanks stay blank.
    for (const column of sheet.evaluator_columns) {
      evaluatorTotals[column.id] += toNumberOrNull(row.evaluator_values?.[column.id]) ?? 0;
    }
    const rowAverage = getRowAppraiserAverage(row, sheet.evaluator_columns);
    rowAverages[row.lot_id] = rowAverage;
    totalAssetValue += rowAverage;
    totalLowEstValue += toFiniteNumber(row.low_est_sale_value);
    totalHighEstValue += toFiniteNumber(row.high_est_sale_value);
    totalCappedBp += toFiniteNumber(row.buyer_premium_amount);
    totalExpectedGross += toFiniteNumber(row.total_expected_gross);
    totalAllocatedValue += toFiniteNumber(row.allocated_value);
    totalCleaning += toFiniteNumber(row.cleaning);
    totalLienSearch += toFiniteNumber(row.lien_search);
    totalVideoCost += toFiniteNumber(row.video_cost);
    totalLottingFee += toFiniteNumber(row.lotting_fee);
    totalAdvertising += toFiniteNumber(row.advertising);
    totalProjectedCosts +=
      toFiniteNumber(row.cleaning) +
      toFiniteNumber(row.lien_search) +
      toFiniteNumber(row.video_cost) +
      toFiniteNumber(row.lotting_fee) +
      toFiniteNumber(row.advertising);

    const score = getRiskScore(row.market_check);
    const bucket = getRiskBucket(score);
    if (bucket === "Low") lowRiskValue += rowAverage;
    if (bucket === "Medium") mediumRiskValue += rowAverage;
    if (bucket === "High") highRiskValue += rowAverage;
    weightedRiskScoreTotal += rowAverage * score;
  }

  const weightedAverageRiskScore =
    totalAssetValue > 0 ? weightedRiskScoreTotal / totalAssetValue : 2;
  const overallFileRiskRating = getRiskBucket(weightedAverageRiskScore);

  const uncappedGet = totalAssetValue + totalCappedBp;
  const uncappedCosts = totalProjectedCosts;
  const uncappedGetAfterCosts = uncappedGet - uncappedCosts;
  const uncappedAdjustedGet = uncappedGetAfterCosts / 1.15;
  const uncappedBp15 = uncappedGet - uncappedAdjustedGet;
  const uncappedPotentialGet = totalHighEstValue + totalCappedBp;
  const uncappedAdjustedPotentialGet = uncappedPotentialGet / 1.15;
  const uncappedPotentialBp15 = uncappedPotentialGet - uncappedAdjustedPotentialGet;
  const uncappedOffer1CashOffer = uncappedGet * 0.9;
  const uncappedOffer1TotalCosts = uncappedOffer1CashOffer + uncappedCosts;
  const uncappedOffer1McdTake = uncappedGet - uncappedOffer1TotalCosts;
  const uncappedOffer2Nmg = uncappedGet * sheet.file_summary.offer2_nmg_percent;
  const uncappedOffer2Threshold = uncappedOffer2Nmg * 0.15;
  const uncappedOffer2UpperValue = uncappedOffer2Nmg + uncappedOffer2Threshold;
  const uncappedOffer2TotalCosts = uncappedOffer2Nmg + uncappedCosts;
  const uncappedOffer2McdTake = uncappedBp15 - uncappedCosts;
  const uncappedAquajetsPotentialTake =
    uncappedOffer2Nmg + (uncappedAdjustedPotentialGet - uncappedOffer2UpperValue) * 0.98;
  const uncappedMcdPotentialTake =
    uncappedPotentialBp15 -
    uncappedCosts +
    uncappedOffer2Threshold +
    (uncappedAdjustedPotentialGet - uncappedOffer2UpperValue) * 0.02;

  const cappedAvg = totalAssetValue;
  const cappedThreshold = cappedAvg * sheet.file_summary.capped_threshold_percent;
  const cappedAds = cappedAvg * 0.01;
  const cappedSvr = cappedAvg * 0.01;
  const cappedRefurb = cappedAvg * 0.01;
  const cappedTotalCost = cappedAds + cappedSvr + cappedRefurb;
  const cappedNmg = cappedAvg - cappedTotalCost - cappedThreshold;

  return {
    evaluator_totals: evaluatorTotals,
    row_appraiser_averages: rowAverages,
    total_asset_value: totalAssetValue,
    total_low_est_value: totalLowEstValue,
    total_high_est_value: totalHighEstValue,
    total_capped_bp: totalCappedBp,
    total_expected_gross: totalExpectedGross,
    total_allocated_value: totalAllocatedValue,
    total_cleaning: totalCleaning,
    total_lien_search: totalLienSearch,
    total_video_cost: totalVideoCost,
    total_lotting_fee: totalLottingFee,
    total_advertising: totalAdvertising,
    total_projected_costs: totalProjectedCosts,
    low_risk_value: lowRiskValue,
    medium_risk_value: mediumRiskValue,
    high_risk_value: highRiskValue,
    low_risk_percent: divideOrNull(lowRiskValue, totalAssetValue),
    medium_risk_percent: divideOrNull(mediumRiskValue, totalAssetValue),
    high_risk_percent: divideOrNull(highRiskValue, totalAssetValue),
    weighted_average_risk_score: weightedAverageRiskScore,
    overall_file_risk_rating: overallFileRiskRating,
    selected_nmg:
      sheet.file_summary.buyers_premium_basis === "capped" ? cappedNmg : uncappedOffer2Nmg,
    selected_cash_purchase_price:
      sheet.file_summary.buyers_premium_basis === "capped" ? cappedAvg : uncappedOffer1CashOffer,
    selected_commission_basis_value:
      sheet.file_summary.buyers_premium_basis === "capped" ? totalCappedBp : uncappedBp15,
    uncapped: {
      get: uncappedGet,
      costs: uncappedCosts,
      get_after_costs: uncappedGetAfterCosts,
      adjusted_get: uncappedAdjustedGet,
      bp_15: uncappedBp15,
      potential_get: uncappedPotentialGet,
      adjusted_potential_get: uncappedAdjustedPotentialGet,
      potential_bp_15: uncappedPotentialBp15,
      offer1_cash_offer: uncappedOffer1CashOffer,
      offer1_total_costs: uncappedOffer1TotalCosts,
      offer1_mcd_take: uncappedOffer1McdTake,
      offer1_roi: divideOrNull(uncappedOffer1McdTake, uncappedOffer1TotalCosts),
      offer1_risk: totalLowEstValue + totalCappedBp - uncappedOffer1TotalCosts,
      offer2_nmg: uncappedOffer2Nmg,
      offer2_threshold: uncappedOffer2Threshold,
      offer2_upper_value: uncappedOffer2UpperValue,
      offer2_total_costs: uncappedOffer2TotalCosts,
      offer2_aquajets_take: uncappedOffer2Nmg,
      offer2_overage: uncappedAdjustedGet - uncappedOffer2Nmg,
      offer2_mcd_take: uncappedOffer2McdTake,
      offer2_roi: divideOrNull(uncappedOffer2McdTake, uncappedOffer2TotalCosts),
      offer2_risk: totalLowEstValue + totalCappedBp - uncappedOffer2TotalCosts,
      aquajets_potential_take: uncappedAquajetsPotentialTake,
      mcd_potential_take: uncappedMcdPotentialTake,
      potential_roi: divideOrNull(uncappedMcdPotentialTake, uncappedOffer2TotalCosts),
      offer3_mcd_take: uncappedBp15,
    },
    capped: {
      avg: cappedAvg,
      high: totalHighEstValue,
      low: totalLowEstValue,
      bp: totalCappedBp,
      sale_total_inc_bp: cappedAvg + totalCappedBp,
      ads: cappedAds,
      svr: cappedSvr,
      refurb: cappedRefurb,
      total_cost: cappedTotalCost,
      nmg: cappedNmg,
      threshold: cappedThreshold,
      risk:
        cappedAvg === 0 ? null : 1 - ((cappedTotalCost + cappedNmg - totalCappedBp) / cappedAvg),
    },
  };
}

export function recalculateAssetScheduleSheet(sheet: AssetAdminScheduleSheet): AssetAdminScheduleSheet {
  return {
    evaluator_columns: sheet.evaluator_columns.map((column) => ({
      id: column.id,
      name: String(column.name || "").trim() || "Evaluator",
      ...(column.user_id ? { user_id: String(column.user_id) } : {}),
      ...(column.email ? { email: String(column.email) } : {}),
      ...(column.avatar_url ? { avatar_url: String(column.avatar_url) } : {}),
    })),
    rows: sheet.rows.map((row) => recalculateRow(row, sheet.evaluator_columns)),
    file_summary: normalizeFileSummary(sheet.file_summary),
  };
}

export function additionalEvaluatorIds(sheet: AssetAdminScheduleSheet, ownerColumnId?: string | null): Set<string> {
  const ownerId = sheet.evaluator_columns.find(column => column.id === ownerColumnId)?.user_id;
  return new Set(sheet.evaluator_columns
    .filter(column => column.id !== ownerColumnId && column.user_id && column.user_id !== ownerId)
    .map(column => column.user_id!));
}

export function canRemoveEvaluator(column: AssetAdminScheduleEvaluatorColumn, ownerColumnId?: string | null): boolean {
  return Boolean(column.user_id) && column.id !== ownerColumnId;
}

export function canAddEvaluator(sheet: AssetAdminScheduleSheet, userId: string, ownerColumnId?: string | null): boolean {
  return Boolean(userId) && !sheet.evaluator_columns.some(column => column.user_id === userId)
    && additionalEvaluatorIds(sheet, ownerColumnId).size < 4;
}

export function formatCurrencyCell(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatPercentCell(
  value: number | null | undefined,
  options?: { scale?: "ratio" | "percent"; fractionDigits?: number }
) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  const scale = options?.scale || "ratio";
  const fractionDigits = options?.fractionDigits ?? 2;
  const displayValue = scale === "ratio" ? value * 100 : value;
  return `${displayValue.toFixed(fractionDigits)}%`;
}
