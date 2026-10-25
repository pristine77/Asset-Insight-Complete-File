import type {
  ProposalValuationCalculation,
  ProposalValuationDerivedSummary,
  ProposalValuationEvaluator,
  ProposalValuationMarketCheck,
  ProposalValuationRow,
  ProposalValuationSheet,
} from "./types";

type RiskBucket = "Low" | "Medium" | "High";

const MARKET_CHECK_SCORE_MAP: Record<
  keyof Omit<ProposalValuationMarketCheck, "notes">,
  Record<string, number>
> = {
  comparable_count: { High: 1, Moderate: 2, Low: 3 },
  avg_retail_asking_price: { High: 1, Moderate: 2, Low: 3 },
  market_saturation: { Low: 1, Moderate: 2, High: 3 },
  market_velocity: { Fast: 1, Normal: 2, Slow: 3 },
  regional_demand: { Strong: 1, Average: 2, Weak: 3 },
};

function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number.parseFloat(String(value).replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function finite(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function divideOrNull(numerator: number, denominator: number) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return null;
  }
  return numerator / denominator;
}

function riskScore(marketCheck: ProposalValuationMarketCheck) {
  const scores = Object.entries(MARKET_CHECK_SCORE_MAP)
    .map(([field, scoreMap]) =>
      scoreMap[marketCheck[field as keyof typeof MARKET_CHECK_SCORE_MAP]]
    )
    .filter((value): value is number => Number.isFinite(value));
  return scores.length
    ? scores.reduce((sum, value) => sum + value, 0) / scores.length
    : 2;
}

function riskBucket(score: number): RiskBucket {
  if (score < 1.67) return "Low";
  if (score < 2.34) return "Medium";
  return "High";
}

export function makeEvaluatorId() {
  return `eval_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export function cloneProposalValuationSheet(sheet: ProposalValuationSheet) {
  return structuredClone(sheet);
}

function evaluatorAmounts(values: number[]) {
  const average = values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
  const low = values.length ? Math.min(...values) : null;
  const high = values.length ? Math.max(...values) : null;
  const premium = average === null ? null : Math.min(average * 0.15, 2000);
  const gross = average === null || premium === null ? null : average + premium;
  return { average, low, high, premium, gross };
}

/** One formula for stored recalculation, live rows and whole-sheet totals. */
export function rowValuationAmounts(
  row: ProposalValuationRow,
  evaluators: ProposalValuationEvaluator[]
) {
  const values = evaluators
    .map((evaluator) => numberOrNull(row.evaluator_values?.[evaluator.id]))
    .filter((value): value is number => value !== null);
  return evaluatorAmounts(values);
}

export function rowAverage(
  row: ProposalValuationRow,
  evaluators: ProposalValuationEvaluator[]
) {
  return rowValuationAmounts(row, evaluators).average ?? 0;
}

export function recalculateProposalValuationSheet(
  sheet: ProposalValuationSheet
): ProposalValuationSheet {
  const evaluators = sheet.evaluator_columns.map((column) => ({
    ...column,
    id: column.id,
    name: String(column.name || "").trim() || "Evaluator",
  }));

  return {
    ...sheet,
    evaluator_columns: evaluators,
    rows: sheet.rows.map((row) => {
      const evaluatorValues = Object.fromEntries(
        evaluators.map((column) => [
          column.id,
          numberOrNull(row.evaluator_values?.[column.id]),
        ])
      ) as Record<string, number | null>;
      const filled = Object.values(evaluatorValues).filter(
        (value): value is number => value !== null
      );
      const { low, high, premium, gross } = evaluatorAmounts(filled);

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
        buyer_premium_percent: 15,
        buyer_premium_amount: premium,
        total_expected_gross: gross,
        allocated_value: gross,
        cleaning: high === null ? null : high * 0.01,
        lotting_fee: high === null ? null : high * 0.01,
        advertising: high === null ? null : high * 0.01,
        lien_search: numberOrNull(row.lien_search),
        video_cost: numberOrNull(row.video_cost),
      };
    }),
    file_summary: {
      buyers_premium_basis:
        sheet.file_summary?.buyers_premium_basis === "capped" ? "capped" : "uncapped",
      total_risk_weighted_value: numberOrNull(
        sheet.file_summary?.total_risk_weighted_value
      ),
      file_risk_multiplier: numberOrNull(sheet.file_summary?.file_risk_multiplier),
      commission_percent_no_guarantee: numberOrNull(
        sheet.file_summary?.commission_percent_no_guarantee
      ),
      offer2_nmg_percent: Math.max(
        0,
        Math.min(1, numberOrNull(sheet.file_summary?.offer2_nmg_percent) ?? 0.785)
      ),
      capped_threshold_percent: Math.max(
        0,
        Math.min(
          1,
          numberOrNull(sheet.file_summary?.capped_threshold_percent) ?? 0.1
        )
      ),
    },
  };
}

/** Exact web counterpart of the admin/backend Schedule A summary. */
export function deriveProposalValuationSummary(
  input: ProposalValuationSheet
): ProposalValuationDerivedSummary {
  const sheet = recalculateProposalValuationSheet(input);
  const rowAverages: Record<string, number> = {};
  let totalAssetValue = 0;
  let totalLowEstValue = 0;
  let totalHighEstValue = 0;
  let totalCappedBp = 0;
  let totalProjectedCosts = 0;
  let lowRiskValue = 0;
  let mediumRiskValue = 0;
  let highRiskValue = 0;
  let weightedRiskScoreTotal = 0;

  for (const row of sheet.rows) {
    const average = rowAverage(row, sheet.evaluator_columns);
    rowAverages[row.lot_id] = average;
    totalAssetValue += average;
    totalLowEstValue += finite(row.low_est_sale_value);
    totalHighEstValue += finite(row.high_est_sale_value);
    totalCappedBp += finite(row.buyer_premium_amount);
    totalProjectedCosts +=
      finite(row.cleaning) +
      finite(row.lien_search) +
      finite(row.video_cost) +
      finite(row.lotting_fee) +
      finite(row.advertising);

    const score = riskScore(row.market_check);
    const bucket = riskBucket(score);
    if (bucket === "Low") lowRiskValue += average;
    if (bucket === "Medium") mediumRiskValue += average;
    if (bucket === "High") highRiskValue += average;
    weightedRiskScoreTotal += average * score;
  }

  const weightedAverageRiskScore =
    totalAssetValue > 0 ? weightedRiskScoreTotal / totalAssetValue : 2;
  const overallFileRiskRating = riskBucket(weightedAverageRiskScore);
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
    uncappedOffer2Nmg +
    (uncappedAdjustedPotentialGet - uncappedOffer2UpperValue) * 0.98;
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
    row_appraiser_averages: rowAverages,
    total_asset_value: totalAssetValue,
    total_low_est_value: totalLowEstValue,
    total_high_est_value: totalHighEstValue,
    total_capped_bp: totalCappedBp,
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
      sheet.file_summary.buyers_premium_basis === "capped"
        ? cappedNmg
        : uncappedOffer2Nmg,
    selected_cash_purchase_price:
      sheet.file_summary.buyers_premium_basis === "capped"
        ? cappedAvg
        : uncappedOffer1CashOffer,
    selected_commission_basis_value:
      sheet.file_summary.buyers_premium_basis === "capped"
        ? totalCappedBp
        : uncappedBp15,
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
      potential_roi: divideOrNull(
        uncappedMcdPotentialTake,
        uncappedOffer2TotalCosts
      ),
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
        cappedAvg === 0
          ? null
          : 1 - (cappedTotalCost + cappedNmg - totalCappedBp) / cappedAvg,
    },
  };
}

export function proposalValuationTotals(sheet: ProposalValuationSheet) {
  const summary = deriveProposalValuationSummary(sheet);
  return {
    evaluatorTotal: summary.total_asset_value,
    lowTotal: summary.total_low_est_value,
    highTotal: summary.total_high_est_value,
    projectedCosts: summary.total_projected_costs,
    offerTwo: summary.uncapped.offer2_nmg,
    threshold: summary.uncapped.offer2_threshold,
    overage: summary.uncapped.offer2_overage,
  };
}

/** Whole-report column sums, independent of the rendered page or search results. */
export function proposalValuationColumnTotals(
  sheet: ProposalValuationSheet,
  summary = deriveProposalValuationSummary(sheet)
) {
  const evaluatorTotals = sheet.evaluator_columns.map((column) => ({
    ...column,
    total: sheet.rows.reduce(
      (sum, row) => sum + (numberOrNull(row.evaluator_values?.[column.id]) ?? 0),
      0
    ),
  }));
  const monetaryTotals = {
    totalExpectedGross: 0,
    allocatedValue: 0,
    cleaning: 0,
    lienSearch: 0,
    videoCost: 0,
    lottingFee: 0,
    advertising: 0,
  };
  // Reuse row formulas so current edits win over stale saved derived amounts.
  // Gross and its premium use the unrounded average of entered evaluator values.
  for (const row of recalculateProposalValuationSheet(sheet).rows) {
    monetaryTotals.totalExpectedGross += finite(row.total_expected_gross);
    monetaryTotals.allocatedValue += finite(row.allocated_value);
    monetaryTotals.cleaning += finite(row.cleaning);
    monetaryTotals.lienSearch += finite(row.lien_search);
    monetaryTotals.videoCost += finite(row.video_cost);
    monetaryTotals.lottingFee += finite(row.lotting_fee);
    monetaryTotals.advertising += finite(row.advertising);
  }
  return {
    lotCount: sheet.rows.length,
    evaluators: evaluatorTotals,
    average: summary.total_asset_value,
    low: summary.total_low_est_value,
    high: summary.total_high_est_value,
    buyerPremium: summary.total_capped_bp,
    ...monetaryTotals,
  };
}

export type ProposalValuationColumnTotals = ReturnType<typeof proposalValuationColumnTotals>;

function calculation(
  key: string,
  label: string,
  formula: string,
  inputs: Record<string, number | string | null>,
  value: number | string | null
): ProposalValuationCalculation {
  return { key, label, formula, inputs, value };
}

export function buildProposalValuationCalculations(
  sheet: ProposalValuationSheet,
  summary = deriveProposalValuationSummary(sheet),
  currency = "CAD"
): ProposalValuationCalculation[] {
  const offer2Percent = sheet.file_summary.offer2_nmg_percent;
  const cappedPercent = sheet.file_summary.capped_threshold_percent;
  const base = {
    totalAssetValue: summary.total_asset_value,
    lowEstimate: summary.total_low_est_value,
    highEstimate: summary.total_high_est_value,
    buyerPremium: summary.total_capped_bp,
    projectedCosts: summary.total_projected_costs,
  };
  return [
    calculation("total_asset_value", "Total asset value", "Sum of each lot's evaluator average", { lots: sheet.rows.length }, summary.total_asset_value),
    calculation("estimated_range", "Estimated range", "Sum of low estimates through sum of high estimates", { totalLowEstimate: summary.total_low_est_value, totalHighEstimate: summary.total_high_est_value }, `${formatMoney(summary.total_low_est_value, currency)} – ${formatMoney(summary.total_high_est_value, currency)}`),
    calculation("total_low_est_value", "Total low estimated value", "Sum of each lot's lowest evaluator value", { lots: sheet.rows.length }, summary.total_low_est_value),
    calculation("total_high_est_value", "Total high estimated value", "Sum of each lot's highest evaluator value", { lots: sheet.rows.length }, summary.total_high_est_value),
    calculation("total_projected_costs", "Total projected costs", "Cleaning + lien search + video + lotting + advertising for every lot", { lots: sheet.rows.length }, summary.total_projected_costs),
    calculation("low_risk_percent", "% low risk value", "Low-risk asset value ÷ total asset value", { lowRiskValue: summary.low_risk_value, totalAssetValue: summary.total_asset_value }, summary.low_risk_percent),
    calculation("medium_risk_percent", "% medium risk value", "Medium-risk asset value ÷ total asset value", { mediumRiskValue: summary.medium_risk_value, totalAssetValue: summary.total_asset_value }, summary.medium_risk_percent),
    calculation("high_risk_percent", "% high risk value", "High-risk asset value ÷ total asset value", { highRiskValue: summary.high_risk_value, totalAssetValue: summary.total_asset_value }, summary.high_risk_percent),
    calculation("weighted_average_risk_score", "Weighted average risk score", "Sum of each asset average × market-check risk score, divided by total asset value", { totalAssetValue: summary.total_asset_value }, summary.weighted_average_risk_score),
    calculation("overall_file_risk_rating", "Overall file risk rating", "Asset-value-weighted market risk score: Low < 1.67; Medium < 2.34; otherwise High", { weightedAverageRiskScore: summary.weighted_average_risk_score }, summary.overall_file_risk_rating),
    calculation("selected_nmg", "Selected NMG", sheet.file_summary.buyers_premium_basis === "capped" ? "Capped average - capped costs - capped threshold" : "Uncapped Get × Offer #2 NMG %", { basis: sheet.file_summary.buyers_premium_basis, ...base, offer2Percent, cappedPercent }, summary.selected_nmg),
    calculation("selected_cash_purchase_price", "Cash purchase price", sheet.file_summary.buyers_premium_basis === "capped" ? "Total asset value" : "Uncapped Get × 90%", { basis: sheet.file_summary.buyers_premium_basis, ...base }, summary.selected_cash_purchase_price),
    calculation("selected_commission_basis_value", "Commission basis value", sheet.file_summary.buyers_premium_basis === "capped" ? "Total capped buyer premium" : "Uncapped Get - Adjusted Get", { basis: sheet.file_summary.buyers_premium_basis, ...base, adjustedGet: summary.uncapped.adjusted_get }, summary.selected_commission_basis_value),
    calculation("uncapped.get", "Get", "Total asset value + capped buyer premium", base, summary.uncapped.get),
    calculation("uncapped.costs", "Costs", "Total projected costs", { projectedCosts: summary.total_projected_costs }, summary.uncapped.costs),
    calculation("uncapped.get_after_costs", "Get after costs", "Get - projected costs", { get: summary.uncapped.get, projectedCosts: summary.total_projected_costs }, summary.uncapped.get_after_costs),
    calculation("uncapped.adjusted_get", "Adjusted Get", "Get after costs ÷ 1.15", { getAfterCosts: summary.uncapped.get_after_costs }, summary.uncapped.adjusted_get),
    calculation("uncapped.bp_15", "15% B.P.", "Get - Adjusted Get", { get: summary.uncapped.get, adjustedGet: summary.uncapped.adjusted_get }, summary.uncapped.bp_15),
    calculation("uncapped.potential_get", "Potential Get", "Total high estimated value + capped buyer premium", base, summary.uncapped.potential_get),
    calculation("uncapped.adjusted_potential_get", "Adjusted Potential Get", "Potential Get ÷ 1.15", { potentialGet: summary.uncapped.potential_get }, summary.uncapped.adjusted_potential_get),
    calculation("uncapped.potential_bp_15", "Potential 15% B.P.", "Potential Get - Adjusted Potential Get", { potentialGet: summary.uncapped.potential_get, adjustedPotentialGet: summary.uncapped.adjusted_potential_get }, summary.uncapped.potential_bp_15),
    calculation("uncapped.offer1_cash_offer", "Offer #1 cash offer", "Get × 90%", { get: summary.uncapped.get }, summary.uncapped.offer1_cash_offer),
    calculation("uncapped.offer1_total_costs", "Offer #1 total costs", "Cash offer + projected costs", { cashOffer: summary.uncapped.offer1_cash_offer, projectedCosts: summary.total_projected_costs }, summary.uncapped.offer1_total_costs),
    calculation("uncapped.offer1_mcd_take", "Offer #1 McD Take", "Get - Offer #1 total costs", { get: summary.uncapped.get, totalCosts: summary.uncapped.offer1_total_costs }, summary.uncapped.offer1_mcd_take),
    calculation("uncapped.offer1_roi", "Offer #1 ROI", "McD Take ÷ Offer #1 total costs", { mcdTake: summary.uncapped.offer1_mcd_take, totalCosts: summary.uncapped.offer1_total_costs }, summary.uncapped.offer1_roi),
    calculation("uncapped.offer1_risk", "Offer #1 risk", "Low estimate + buyer premium - Offer #1 total costs", { ...base, totalCosts: summary.uncapped.offer1_total_costs }, summary.uncapped.offer1_risk),
    calculation("uncapped.offer2_nmg", "Offer #2 NMG", "Get × Offer #2 NMG %", { get: summary.uncapped.get, offer2Percent }, summary.uncapped.offer2_nmg),
    calculation("uncapped.offer2_threshold", "Offer #2 threshold", "Offer #2 NMG × 15%", { nmg: summary.uncapped.offer2_nmg }, summary.uncapped.offer2_threshold),
    calculation("uncapped.offer2_upper_value", "Offer #2 upper value", "Offer #2 NMG + threshold", { nmg: summary.uncapped.offer2_nmg, threshold: summary.uncapped.offer2_threshold }, summary.uncapped.offer2_upper_value),
    calculation("uncapped.offer2_total_costs", "Offer #2 total costs", "Offer #2 NMG + projected costs", { nmg: summary.uncapped.offer2_nmg, projectedCosts: summary.total_projected_costs }, summary.uncapped.offer2_total_costs),
    calculation("uncapped.offer2_aquajets_take", "Offer #2 Aquajet's take", "Offer #2 NMG", { nmg: summary.uncapped.offer2_nmg }, summary.uncapped.offer2_aquajets_take),
    calculation("uncapped.offer2_overage", "Offer #2 overage", "Adjusted Get - Offer #2 NMG", { adjustedGet: summary.uncapped.adjusted_get, nmg: summary.uncapped.offer2_nmg }, summary.uncapped.offer2_overage),
    calculation("uncapped.offer2_mcd_take", "Offer #2 McD Take", "15% B.P. - projected costs", { buyerPremium15: summary.uncapped.bp_15, projectedCosts: summary.total_projected_costs }, summary.uncapped.offer2_mcd_take),
    calculation("uncapped.offer2_roi", "Offer #2 ROI", "McD Take ÷ Offer #2 total costs", { mcdTake: summary.uncapped.offer2_mcd_take, totalCosts: summary.uncapped.offer2_total_costs }, summary.uncapped.offer2_roi),
    calculation("uncapped.offer2_risk", "Offer #2 risk", "Low estimate + buyer premium - Offer #2 total costs", { ...base, totalCosts: summary.uncapped.offer2_total_costs }, summary.uncapped.offer2_risk),
    calculation("uncapped.aquajets_potential_take", "Aquajet's potential take", "NMG + (Adjusted Potential Get - Upper Value) × 98%", { nmg: summary.uncapped.offer2_nmg, adjustedPotentialGet: summary.uncapped.adjusted_potential_get, upperValue: summary.uncapped.offer2_upper_value }, summary.uncapped.aquajets_potential_take),
    calculation("uncapped.mcd_potential_take", "McD potential take", "Potential B.P. - costs + threshold + potential overage × 2%", { potentialBuyerPremium: summary.uncapped.potential_bp_15, projectedCosts: summary.total_projected_costs, threshold: summary.uncapped.offer2_threshold, adjustedPotentialGet: summary.uncapped.adjusted_potential_get, upperValue: summary.uncapped.offer2_upper_value }, summary.uncapped.mcd_potential_take),
    calculation("uncapped.potential_roi", "Potential ROI", "McD potential take ÷ Offer #2 total costs", { mcdPotentialTake: summary.uncapped.mcd_potential_take, totalCosts: summary.uncapped.offer2_total_costs }, summary.uncapped.potential_roi),
    calculation("uncapped.offer3_mcd_take", "Offer #3 commission", "Uncapped 15% B.P.", { buyerPremium15: summary.uncapped.bp_15 }, summary.uncapped.offer3_mcd_take),
    calculation("capped.avg", "Capped average", "Total asset value", { totalAssetValue: summary.total_asset_value }, summary.capped.avg),
    calculation("capped.high", "Capped high", "Total high estimated value", { totalHighEstimate: summary.total_high_est_value }, summary.capped.high),
    calculation("capped.low", "Capped low", "Total low estimated value", { totalLowEstimate: summary.total_low_est_value }, summary.capped.low),
    calculation("capped.bp", "Capped buyer premium", "Sum of each lot's buyer premium, capped at the lot limit", { buyerPremium: summary.total_capped_bp }, summary.capped.bp),
    calculation("capped.sale_total_inc_bp", "Sale total including B.P.", "Capped average + buyer premium", { average: summary.capped.avg, buyerPremium: summary.capped.bp }, summary.capped.sale_total_inc_bp),
    calculation("capped.ads", "Capped ads", "Capped average × 1%", { average: summary.capped.avg }, summary.capped.ads),
    calculation("capped.svr", "Capped SVR", "Capped average × 1%", { average: summary.capped.avg }, summary.capped.svr),
    calculation("capped.refurb", "Capped refurb", "Capped average × 1%", { average: summary.capped.avg }, summary.capped.refurb),
    calculation("capped.total_cost", "Capped total cost", "Ads + SVR + refurb", { ads: summary.capped.ads, svr: summary.capped.svr, refurb: summary.capped.refurb }, summary.capped.total_cost),
    calculation("capped.threshold", "Capped threshold", "Capped average × threshold %", { average: summary.capped.avg, cappedPercent }, summary.capped.threshold),
    calculation("capped.nmg", "Capped NMG", "Average - total cost - threshold", { average: summary.capped.avg, totalCost: summary.capped.total_cost, threshold: summary.capped.threshold }, summary.capped.nmg),
    calculation("capped.risk", "Capped risk", "1 - ((total cost + NMG - buyer premium) ÷ average)", { average: summary.capped.avg, totalCost: summary.capped.total_cost, nmg: summary.capped.nmg, buyerPremium: summary.capped.bp }, summary.capped.risk),
  ];
}

export function formatMoney(value: number | null | undefined, currency = "CAD") {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `${(value * 100).toFixed(2)}%`;
}
