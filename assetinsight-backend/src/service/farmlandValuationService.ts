/**
 * Farmland Valuation Service
 * Implements:
 * 1. Direct Comparison Approach with adjustments
 * 2. Income Capitalization Approach
 * 3. Cost Approach (AI-calculated)
 * 4. Reconciliation of selected approaches
 */

import openai from "../utils/openaiClient.js";

// Types for farmland valuation
export interface FarmlandComparable {
  comp_id: string;
  sale_date: Date;
  rm_area: string;
  distance_to_subject_km: number;
  title_acres: number;
  cultivated_acres: number;
  sale_price: number;
  price_per_cultivated_acre: number;
  data_source: string;
  notes?: string;
}

export interface AdjustmentRates {
  time_percent_per_year: number; // default 5%
  size_per_10ac: number; // default -$25
  location_per_km: number; // default -$15
  soil_quality_per_step: number; // default $50
  access_lump_sum: number; // default $75
}

export interface SubjectProperty {
  subject_name: string;
  valuation_date: Date;
  total_title_acres: number;
  cultivated_acres: number;
  rm_area: string;
  soil_class?: string; // 1-5 scale
  access_quality?: "excellent" | "good" | "fair" | "poor";
  notes?: string;
}

export interface IncomeCapitalizationInput {
  cultivated_acres: number;
  market_rent_per_acre: number;
  vacancy_loss_percent?: number; // default 2%
  operating_expense_ratio?: number; // default 20%
  cap_rate?: number; // default 5%
}

export interface AdjustedComparable extends FarmlandComparable {
  unadjusted_rate: number;
  time_adj: number;
  size_adj: number;
  location_adj: number;
  soil_quality_adj: number;
  access_adj: number;
  other_adj: number;
  total_adj: number;
  adjusted_rate: number;
  weight_percent: number;
  weighted_rate: number;
}

export interface IncomeCapitalizationResult {
  cultivated_acres: number;
  market_rent_per_acre: number;
  potential_gross_income: number;
  vacancy_loss_percent: number;
  effective_gross_income: number;
  operating_expense_ratio: number;
  net_operating_income: number;
  cap_rate: number;
  indicated_value: number;
  indicated_value_per_acre: number;
}

export interface ReconciliationResult {
  direct_comparison_value: number;
  direct_comparison_weight: number;
  direct_comparison_weighted: number;
  income_value: number;
  income_weight: number;
  income_weighted: number;
  cost_value?: number;
  cost_weight?: number;
  cost_weighted?: number;
  final_reconciled_value: number;
}

export interface CostApproachResult {
  land_value: number;
  replacement_cost_new: number;
  physical_depreciation: number;
  functional_obsolescence: number;
  external_obsolescence: number;
  total_depreciation: number;
  depreciated_cost_of_improvements: number;
  indicated_value: number;
}

export interface FarmlandValuationResult {
  subject_name: string;
  valuation_date: Date;
  total_title_acres: number;
  cultivated_acres: number;
  rm_area: string;
  notes?: string;
  // Which approaches were used
  approaches_used?: {
    direct_comparable: boolean;
    income_capitalization: boolean;
    cost_approach: boolean;
  };
  // Direct Comparison
  comparables: AdjustedComparable[];
  adjustment_rates: AdjustmentRates;
  weighted_average_rate: number;
  direct_comparison_value: number;
  // Income Approach
  income_capitalization: IncomeCapitalizationResult;
  // Cost Approach (AI-calculated)
  cost_approach?: CostApproachResult;
  // Reconciliation
  reconciliation: ReconciliationResult;
  // Final
  fair_market_value: number;
  fair_market_value_formatted: string;
}

const DEFAULT_ADJUSTMENT_RATES: AdjustmentRates = {
  time_percent_per_year: 5.0,
  size_per_10ac: -25,
  location_per_km: -15,
  soil_quality_per_step: 50,
  access_lump_sum: 75,
};

/**
 * Calculate time adjustment based on sale date vs valuation date
 */
function calculateTimeAdjustment(
  saleDate: Date,
  valuationDate: Date,
  rate: number,
  pricePerAcre: number
): number {
  const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
  const yearsDiff = (valuationDate.getTime() - saleDate.getTime()) / msPerYear;
  // If sale is older, we adjust upward (market appreciation)
  const adjustment = pricePerAcre * (rate / 100) * yearsDiff;
  return Math.round(adjustment);
}

/**
 * Calculate size adjustment based on difference in cultivated acres
 */
function calculateSizeAdjustment(
  subjectCultivatedAcres: number,
  compCultivatedAcres: number,
  ratePerTenAcres: number
): number {
  const diff = compCultivatedAcres - subjectCultivatedAcres;
  const adjustment = (diff / 10) * ratePerTenAcres;
  return Math.round(adjustment);
}

/**
 * Calculate location adjustment based on distance
 */
function calculateLocationAdjustment(
  distanceKm: number,
  ratePerKm: number
): number {
  // More distant properties get negative adjustment
  const adjustment = distanceKm * ratePerKm;
  return Math.round(adjustment);
}

/**
 * Calculate soil quality adjustment
 * Assumes subject is baseline; better soil = positive, worse = negative
 */
function calculateSoilQualityAdjustment(
  subjectSoilClass: number,
  compSoilClass: number,
  ratePerStep: number
): number {
  // Lower class number = better soil
  const steps = subjectSoilClass - compSoilClass;
  return Math.round(steps * ratePerStep);
}

/**
 * Calculate access/services adjustment
 */
function calculateAccessAdjustment(
  subjectAccess: string,
  compAccess: string,
  lumpSum: number
): number {
  const accessRank: Record<string, number> = {
    excellent: 4,
    good: 3,
    fair: 2,
    poor: 1,
  };
  const subjectRank = accessRank[subjectAccess?.toLowerCase()] || 3;
  const compRank = accessRank[compAccess?.toLowerCase()] || 3;
  const diff = subjectRank - compRank;
  return Math.round(diff * lumpSum);
}

/**
 * Assign weights to comparables based on relevance
 * Factors: distance, same RM, recency of sale
 */
function assignComparableWeights(
  comparables: AdjustedComparable[],
  subject: SubjectProperty
): void {
  if (comparables.length === 0) return;

  // Calculate raw scores
  const scores = comparables.map((comp) => {
    let score = 100;
    // Penalize distance
    score -= Math.min(30, comp.distance_to_subject_km * 2);
    // Bonus for same RM
    if (comp.rm_area?.toLowerCase() === subject.rm_area?.toLowerCase()) {
      score += 15;
    }
    // Penalize older sales (more than 1 year)
    const monthsAgo =
      (subject.valuation_date.getTime() - new Date(comp.sale_date).getTime()) /
      (30 * 24 * 60 * 60 * 1000);
    if (monthsAgo > 12) {
      score -= Math.min(20, (monthsAgo - 12) * 0.5);
    }
    return Math.max(10, score);
  });

  // Normalize to percentages
  const total = scores.reduce((a, b) => a + b, 0);
  comparables.forEach((comp, i) => {
    comp.weight_percent = Math.round((scores[i] / total) * 100);
  });

  // Ensure weights sum to 100
  const sumWeights = comparables.reduce((a, c) => a + c.weight_percent, 0);
  if (sumWeights !== 100 && comparables.length > 0) {
    comparables[0].weight_percent += 100 - sumWeights;
  }
}

/**
 * Direct Comparison Approach - main calculation
 */
export function calculateDirectComparisonApproach(
  subject: SubjectProperty,
  comparables: FarmlandComparable[],
  adjustmentRates: AdjustmentRates = DEFAULT_ADJUSTMENT_RATES
): { adjustedComparables: AdjustedComparable[]; weightedAverageRate: number; directComparisonValue: number } {
  const adjustedComparables: AdjustedComparable[] = comparables.map((comp, idx) => {
    const unadjustedRate = comp.price_per_cultivated_acre;
    
    // Calculate adjustments
    const time_adj = calculateTimeAdjustment(
      new Date(comp.sale_date),
      subject.valuation_date,
      adjustmentRates.time_percent_per_year,
      unadjustedRate
    );
    
    const size_adj = calculateSizeAdjustment(
      subject.cultivated_acres,
      comp.cultivated_acres,
      adjustmentRates.size_per_10ac
    );
    
    const location_adj = calculateLocationAdjustment(
      comp.distance_to_subject_km,
      adjustmentRates.location_per_km
    );
    
    // Soil quality: assume subject is class 2, comp notes may indicate quality
    const subjectSoil = parseInt(subject.soil_class || "2") || 2;
    const compSoil = comp.notes?.toLowerCase().includes("excellent") ? 1 :
                     comp.notes?.toLowerCase().includes("poor") ? 4 :
                     comp.notes?.toLowerCase().includes("typical") ? 2 : 2;
    const soil_quality_adj = calculateSoilQualityAdjustment(
      subjectSoil,
      compSoil,
      adjustmentRates.soil_quality_per_step
    );
    
    // Access: derive from notes
    const subjectAccessStr = subject.access_quality || "good";
    const compAccessStr = comp.notes?.toLowerCase().includes("excellent access") ? "excellent" :
                          comp.notes?.toLowerCase().includes("good access") ? "good" :
                          comp.notes?.toLowerCase().includes("poor access") ? "poor" : "good";
    const access_adj = calculateAccessAdjustment(
      subjectAccessStr,
      compAccessStr,
      adjustmentRates.access_lump_sum
    );
    
    const other_adj = 0; // Can be extended for other factors
    
    const total_adj = time_adj + size_adj + location_adj + soil_quality_adj + access_adj + other_adj;
    const adjusted_rate = unadjustedRate + total_adj;
    
    return {
      ...comp,
      unadjusted_rate: unadjustedRate,
      time_adj,
      size_adj,
      location_adj,
      soil_quality_adj,
      access_adj,
      other_adj,
      total_adj,
      adjusted_rate,
      weight_percent: 0,
      weighted_rate: 0,
    };
  });

  // Assign weights based on relevance
  assignComparableWeights(adjustedComparables, subject);

  // Calculate weighted rates
  adjustedComparables.forEach((comp) => {
    comp.weighted_rate = Math.round(comp.adjusted_rate * (comp.weight_percent / 100));
  });

  // Calculate weighted average rate
  const weightedAverageRate = adjustedComparables.reduce((sum, c) => sum + c.weighted_rate, 0);

  // Calculate direct comparison value
  const directComparisonValue = Math.round(weightedAverageRate * subject.cultivated_acres);

  return {
    adjustedComparables,
    weightedAverageRate,
    directComparisonValue,
  };
}

/**
 * Income Capitalization Approach
 */
export function calculateIncomeCapitalization(
  input: IncomeCapitalizationInput
): IncomeCapitalizationResult {
  const vacancyLossPercent = input.vacancy_loss_percent ?? 2.0;
  const operatingExpenseRatio = input.operating_expense_ratio ?? 20.0;
  const capRate = input.cap_rate ?? 5.0;

  const potentialGrossIncome = input.cultivated_acres * input.market_rent_per_acre;
  const effectiveGrossIncome = potentialGrossIncome * (1 - vacancyLossPercent / 100);
  const netOperatingIncome = effectiveGrossIncome * (1 - operatingExpenseRatio / 100);
  const indicatedValue = netOperatingIncome / (capRate / 100);
  const indicatedValuePerAcre = indicatedValue / input.cultivated_acres;

  return {
    cultivated_acres: input.cultivated_acres,
    market_rent_per_acre: input.market_rent_per_acre,
    potential_gross_income: Math.round(potentialGrossIncome),
    vacancy_loss_percent: vacancyLossPercent,
    effective_gross_income: Math.round(effectiveGrossIncome),
    operating_expense_ratio: operatingExpenseRatio,
    net_operating_income: Math.round(netOperatingIncome),
    cap_rate: capRate,
    indicated_value: Math.round(indicatedValue),
    indicated_value_per_acre: Math.round(indicatedValuePerAcre),
  };
}

/**
 * Reconciliation of Direct Comparison and Income approaches
 */
export function calculateReconciliation(
  directComparisonValue: number,
  incomeValue: number,
  directWeight: number = 70,
  incomeWeight: number = 30
): ReconciliationResult {
  const directWeighted = Math.round(directComparisonValue * (directWeight / 100));
  const incomeWeighted = Math.round(incomeValue * (incomeWeight / 100));
  const finalValue = directWeighted + incomeWeighted;

  return {
    direct_comparison_value: directComparisonValue,
    direct_comparison_weight: directWeight,
    direct_comparison_weighted: directWeighted,
    income_value: incomeValue,
    income_weight: incomeWeight,
    income_weighted: incomeWeighted,
    final_reconciled_value: finalValue,
  };
}

/**
 * Format currency value
 */
function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: "CAD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

/**
 * Complete farmland valuation calculation
 */
export function calculateFarmlandValuation(
  subject: SubjectProperty,
  comparables: FarmlandComparable[],
  incomeInput?: IncomeCapitalizationInput,
  adjustmentRates?: AdjustmentRates,
  reconciliationWeights?: { direct: number; income: number; cost?: number }
): FarmlandValuationResult {
  const rates = adjustmentRates || DEFAULT_ADJUSTMENT_RATES;

  // 1. Direct Comparison Approach
  const { adjustedComparables, weightedAverageRate, directComparisonValue } =
    calculateDirectComparisonApproach(subject, comparables, rates);

  // 2. Income Capitalization Approach (if rental data provided)
  const incomeData = incomeInput || {
    cultivated_acres: subject.cultivated_acres,
    market_rent_per_acre: 80, // Default market rent
    vacancy_loss_percent: 2.0,
    operating_expense_ratio: 20.0,
    cap_rate: 5.0,
  };
  const incomeResult = calculateIncomeCapitalization(incomeData);

  // 3. Reconciliation
  const directWeight = reconciliationWeights?.direct ?? 70;
  const incomeWeight = reconciliationWeights?.income ?? 30;
  const reconciliation = calculateReconciliation(
    directComparisonValue,
    incomeResult.indicated_value,
    directWeight,
    incomeWeight
  );

  return {
    subject_name: subject.subject_name,
    valuation_date: subject.valuation_date,
    total_title_acres: subject.total_title_acres,
    cultivated_acres: subject.cultivated_acres,
    rm_area: subject.rm_area,
    notes: subject.notes,
    comparables: adjustedComparables,
    adjustment_rates: rates,
    weighted_average_rate: weightedAverageRate,
    direct_comparison_value: directComparisonValue,
    income_capitalization: incomeResult,
    reconciliation,
    fair_market_value: reconciliation.final_reconciled_value,
    fair_market_value_formatted: formatCurrency(reconciliation.final_reconciled_value),
  };
}

/**
 * Parse comparables from web search results
 */
export function parseComparablesFromSearch(
  searchResults: any[],
  subjectRmArea: string
): FarmlandComparable[] {
  return searchResults.map((result, idx) => {
    // Extract price
    const priceStr = result.listPrice || result.price || result.sale_price || "0";
    const salePrice = parseFloat(priceStr.replace(/[^0-9.]/g, "")) || 0;
    
    // Extract acres
    const acresStr = result.lotSize || result.acres || result.cultivated_acres || "160";
    const cultivatedAcres = parseFloat(acresStr.replace(/[^0-9.]/g, "")) || 160;
    
    // Calculate price per acre
    const pricePerAcre = cultivatedAcres > 0 ? salePrice / cultivatedAcres : 0;
    
    // Extract distance (default based on source)
    const distance = result.distance_km || result.distance || 
      (result.address?.toLowerCase().includes(subjectRmArea.toLowerCase()) ? 5 : 15);
    
    return {
      comp_id: `F-${idx + 1}`,
      sale_date: result.sale_date ? new Date(result.sale_date) : new Date(),
      rm_area: result.rm_area || result.municipality || subjectRmArea,
      distance_to_subject_km: typeof distance === "number" ? distance : parseFloat(distance) || 10,
      title_acres: cultivatedAcres,
      cultivated_acres: cultivatedAcres,
      sale_price: salePrice,
      price_per_cultivated_acre: Math.round(pricePerAcre),
      data_source: result.data_source || result.source || "MLS",
      notes: result.notes || result.snippet || "",
    };
  });
}

/**
 * AI-calculated Cost Approach for farmland
 * Estimates land value, improvements, and depreciation based on property characteristics
 */
export async function calculateCostApproachAI(
  subjectProperty: SubjectProperty,
  aiExtractedFeatures: any,
  farmlandDetails: any
): Promise<CostApproachResult> {
  const prompt = `You are a certified farmland appraiser calculating the Cost Approach valuation.

SUBJECT PROPERTY:
- Location: ${subjectProperty.rm_area}
- Total Title Acres: ${subjectProperty.total_title_acres}
- Cultivated Acres: ${subjectProperty.cultivated_acres}
- Soil Class: ${farmlandDetails?.soil_class || "Average"}
- Access Quality: ${farmlandDetails?.access_quality || "good"}
- Irrigation: ${farmlandDetails?.irrigation ? "Yes" : "No"}
- Distance to City: ${farmlandDetails?.distance_to_city_km || 20} km

AI OBSERVATIONS FROM IMAGES:
${aiExtractedFeatures ? JSON.stringify(aiExtractedFeatures, null, 2) : "No image analysis available"}

Calculate the Cost Approach valuation with realistic Canadian prairie farmland values (Saskatchewan/Alberta market 2024-2025).

IMPORTANT: Use realistic values based on:
- Land Value: Typically $800-$2,500 per cultivated acre for Saskatchewan farmland
- Improvements: Consider any buildings, fencing, drainage, irrigation systems visible/described
- Physical Depreciation: Age-related wear (typically 10-30% of replacement cost)
- Functional Obsolescence: Design/layout issues (typically 0-15%)
- External Obsolescence: Market/economic factors (typically 0-10%)

Return ONLY a JSON object with these exact fields (numbers only, no currency symbols):
{
  "land_value": <number - total land value>,
  "replacement_cost_new": <number - cost to replace all improvements>,
  "physical_depreciation": <number - physical wear depreciation>,
  "functional_obsolescence": <number - functional issues depreciation>,
  "external_obsolescence": <number - external factors depreciation>,
  "reasoning": "<brief explanation of your estimates>"
}`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 500,
    });

    const content = response.choices[0]?.message?.content || "";
    
    // Extract JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in AI response");
    }
    
    const parsed = JSON.parse(jsonMatch[0]);
    
    const landValue = Math.round(parsed.land_value || subjectProperty.cultivated_acres * 1500);
    const replacementCostNew = Math.round(parsed.replacement_cost_new || 0);
    const physicalDepreciation = Math.round(parsed.physical_depreciation || 0);
    const functionalObsolescence = Math.round(parsed.functional_obsolescence || 0);
    const externalObsolescence = Math.round(parsed.external_obsolescence || 0);
    
    const totalDepreciation = physicalDepreciation + functionalObsolescence + externalObsolescence;
    const depreciatedCostOfImprovements = Math.max(0, replacementCostNew - totalDepreciation);
    const indicatedValue = landValue + depreciatedCostOfImprovements;
    
    console.log(`Cost Approach AI reasoning: ${parsed.reasoning || "N/A"}`);
    
    return {
      land_value: landValue,
      replacement_cost_new: replacementCostNew,
      physical_depreciation: physicalDepreciation,
      functional_obsolescence: functionalObsolescence,
      external_obsolescence: externalObsolescence,
      total_depreciation: totalDepreciation,
      depreciated_cost_of_improvements: depreciatedCostOfImprovements,
      indicated_value: indicatedValue,
    };
  } catch (error) {
    console.error("Cost Approach AI error, using fallback calculation:", error);
    
    // Fallback: Simple land value calculation
    const landValuePerAcre = 1500; // Average Saskatchewan farmland
    const landValue = Math.round(subjectProperty.cultivated_acres * landValuePerAcre);
    const replacementCostNew = farmlandDetails?.irrigation ? 50000 : 0; // Basic improvements if irrigated
    const totalDepreciation = Math.round(replacementCostNew * 0.2); // 20% depreciation
    
    return {
      land_value: landValue,
      replacement_cost_new: replacementCostNew,
      physical_depreciation: Math.round(totalDepreciation * 0.6),
      functional_obsolescence: Math.round(totalDepreciation * 0.25),
      external_obsolescence: Math.round(totalDepreciation * 0.15),
      total_depreciation: totalDepreciation,
      depreciated_cost_of_improvements: replacementCostNew - totalDepreciation,
      indicated_value: landValue + (replacementCostNew - totalDepreciation),
    };
  }
}
