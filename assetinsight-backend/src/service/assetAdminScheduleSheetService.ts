/**
 * Owns the editable admin schedule projection and its derived valuation arithmetic.
 * Normalization accepts saved sheets from older clients, while recalculation treats
 * source lots as the row-membership authority when they are available. Stored
 * Proposal Valuation rows still own editable values for matching lot ids, while
 * newly added source lots are appended and deleted source lots are removed.
 */
import type { IAssetReport } from "../models/asset.model.js";
import { resolveAuctioneerSerialOverride } from "../utils/auctioneerSpecRows.js";

export type MarketCheckValue =
  | ""
  | "High"
  | "Moderate"
  | "Low"
  | "Fast"
  | "Normal"
  | "Slow"
  | "Strong"
  | "Average"
  | "Weak";

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

export type AssetScheduleRiskBucket = "Low" | "Medium" | "High";

export type AssetScheduleDerivedSummary = {
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

export type AssetScheduleCalculation = {
  key: string;
  label: string;
  value: number | string | null;
  formula: string;
  inputs: Record<string, number | string | null>;
};

export const ASSET_SCHEDULE_CALCULATION_VERSION = "asset-pv-v2-average-premium";

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

function safeString(value: unknown) {
  return String(value ?? "").trim();
}

function hasOwn(source: unknown, key: string) {
  return Boolean(
    source &&
      typeof source === "object" &&
      Object.prototype.hasOwnProperty.call(source, key)
  );
}

// A present blank value is an explicit admin override. Only absent properties
// fall back to generated lot data when older saved sheets are normalized.
function editableString(source: any, key: string, fallback: unknown) {
  return hasOwn(source, key) ? safeString(source[key]) : safeString(fallback);
}

function joinText(values: unknown[]) {
  return Array.from(
    new Set(
      values
        .map((value) => safeString(value))
        .filter(Boolean)
    )
  ).join(" ");
}

function toNumberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const normalized = String(value).replace(/,/g, "").replace(/[^0-9.-]+/g, "").trim();
  if (!normalized) return null;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeInteger(value: unknown, fallback: number) {
  const asNumber = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(asNumber) ? asNumber : fallback;
}

function makeEvaluatorId(index: number) {
  return `eval_${index + 1}`;
}

export function getDefaultEvaluatorColumns(): AssetAdminScheduleEvaluatorColumn[] {
  return [];
}

function getDefaultMarketCheck(): AssetAdminScheduleMarketCheck {
  return {
    comparable_count: "",
    avg_retail_asking_price: "",
    market_saturation: "",
    market_velocity: "",
    regional_demand: "",
    notes: "",
  };
}

function getDefaultFileSummary(): AssetAdminScheduleFileSummary {
  return {
    buyers_premium_basis: "uncapped",
    total_risk_weighted_value: null,
    file_risk_multiplier: null,
    commission_percent_no_guarantee: null,
    offer2_nmg_percent: 0.785,
    capped_threshold_percent: 0.1,
  };
}

function countPictures(lot: any) {
  const pictureUrls = getPictureUrls(lot);
  if (pictureUrls.length > 0) return pictureUrls.length;
  if (Array.isArray(lot?.image_indexes) && lot.image_indexes.length > 0) return lot.image_indexes.length;
  if (Array.isArray(lot?.extra_image_indexes) && lot.extra_image_indexes.length > 0) return lot.extra_image_indexes.length;
  if (lot?.image_url) return 1;
  return 0;
}

function getPictureUrls(lot: any) {
  const urls = [
    ...(Array.isArray(lot?.image_urls) ? lot.image_urls : []),
    ...(typeof lot?.image_url === "string" ? [lot.image_url] : []),
    ...(Array.isArray(lot?.extra_image_urls) ? lot.extra_image_urls : []),
  ];

  return Array.from(
    new Set(
      urls
        .map((value) => safeString(value))
        .filter(Boolean)
    )
  );
}

function getAssetCategory(lot: any) {
  if (typeof lot?.categories === "string" && lot.categories.trim()) return lot.categories.trim();
  if (Array.isArray(lot?.tags) && lot.tags.length > 0) return lot.tags.map((tag: any) => safeString(tag)).filter(Boolean).join(", ");
  return "";
}

function extractSerialNumberFromCrDetails(crDetails: string) {
  const patterns = [
    /\b(?:serial(?:\s+number)?|s\/n|sn|vin)(?:\s*[:#-]\s*|\s+)([A-Z0-9-]{5,})\b/i,
    /\b([A-HJ-NPR-Z0-9]{17})\b/i,
  ];

  for (const pattern of patterns) {
    const match = crDetails.match(pattern);
    if (match?.[1]) return safeString(match[1]);
  }

  return "";
}

function extractVehicleDetailsFromCrDetails(crDetails: string) {
  const cleaned = crDetails.replace(/^\s*\d+\.\s*/, "").trim();

  const modelMatch = cleaned.match(/\bModel\s*:\s*([^,]+)\b/i);
  const yearMakeMatch = cleaned.match(/\b(Unknown Year|\d{4})\s+([A-Za-z]+)\s+([^,]+?)(?=,\s*(?:Model|Display|Transmission|Color|Tires|Damages|Other Details)\s*:|,|$)/i);

  const year = yearMakeMatch?.[1] ? safeString(yearMakeMatch[1]) : "";
  const make = yearMakeMatch?.[2] ? safeString(yearMakeMatch[2]) : "";
  const modelFromLead = yearMakeMatch?.[3] ? safeString(yearMakeMatch[3]) : "";
  const model = safeString(modelMatch?.[1]) || modelFromLead;
  const serialNumber = extractSerialNumberFromCrDetails(cleaned);

  return {
    year,
    make,
    model,
    serialNumber,
  };
}

function buildDefaultRow(lot: any, index: number, evaluatorColumns: AssetAdminScheduleEvaluatorColumn[]): AssetAdminScheduleRow {
  const assetIdRaw = safeString(lot?.lot_number);
  const assetId = assetIdRaw || String(index + 1);
  const evaluator_values = Object.fromEntries(
    evaluatorColumns.map((column) => [column.id, null])
  ) as Record<string, number | null>;
  const crDetails = joinText([lot?.description, lot?.details]);
  const parsedVehicleDetails = extractVehicleDetailsFromCrDetails(crDetails);
  const serialOverride = resolveAuctioneerSerialOverride(lot);

  return {
    lot_id: safeString(lot?.lot_id) || `lot_${index + 1}`,
    asset_id: assetId,
    asset_category: getAssetCategory(lot),
    year: parsedVehicleDetails.year,
    make: parsedVehicleDetails.make,
    model: parsedVehicleDetails.model,
    serial_number:
      serialOverride.found
        ? serialOverride.value
        : safeString(lot?.serial_no_or_label || lot?.serial_number) || parsedVehicleDetails.serialNumber,
    cr_details: crDetails,
    condition_score: "",
    location: "",
    pictures: countPictures(lot),
    picture_urls: getPictureUrls(lot),
    market_check: getDefaultMarketCheck(),
    asset_insight: safeString(lot?.estimated_value),
    evaluator_values,
    low_est_sale_value: null,
    high_est_sale_value: null,
    buyer_premium_percent: 15,
    buyer_premium_amount: null,
    total_expected_gross: null,
    allocated_value: null,
    notes: "",
    cleaning: null,
    lien_search: null,
    video_cost: null,
    lotting_fee: null,
    advertising: null,
  };
}

export function buildDefaultAssetAdminScheduleSheet(report: Pick<IAssetReport, "lots" | "preview_data"> & Record<string, any>): AssetAdminScheduleSheet {
  const previewLots = Array.isArray(report?.preview_data?.lots) ? report.preview_data.lots : undefined;
  const lots = previewLots ?? (Array.isArray(report?.lots) ? report.lots : []);
  const evaluator_columns = getDefaultEvaluatorColumns();
  return {
    evaluator_columns,
    rows: lots.map((lot: any, index: number) => buildDefaultRow(lot, index, evaluator_columns)),
    file_summary: getDefaultFileSummary(),
  };
}

function normalizeMarketCheck(input: any): AssetAdminScheduleMarketCheck {
  const source = input && typeof input === "object" ? input : {};
  return {
    comparable_count: safeString(source.comparable_count) as AssetAdminScheduleMarketCheck["comparable_count"],
    avg_retail_asking_price: safeString(source.avg_retail_asking_price) as AssetAdminScheduleMarketCheck["avg_retail_asking_price"],
    market_saturation: safeString(source.market_saturation) as AssetAdminScheduleMarketCheck["market_saturation"],
    market_velocity: safeString(source.market_velocity) as AssetAdminScheduleMarketCheck["market_velocity"],
    regional_demand: safeString(source.regional_demand) as AssetAdminScheduleMarketCheck["regional_demand"],
    notes: safeString(source.notes),
  };
}

function normalizeBuyersPremiumBasis(value: unknown): AssetAdminScheduleBuyersPremiumBasis {
  return safeString(value).toLowerCase() === "capped" ? "capped" : "uncapped";
}

function normalizeRatio(value: unknown, fallback: number) {
  const parsed = toNumberOrNull(value);
  if (parsed === null) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function normalizeFileSummary(input: any): AssetAdminScheduleFileSummary {
  const source = input && typeof input === "object" ? input : {};
  return {
    buyers_premium_basis: normalizeBuyersPremiumBasis(source.buyers_premium_basis),
    total_risk_weighted_value: toNumberOrNull(source.total_risk_weighted_value),
    file_risk_multiplier: toNumberOrNull(source.file_risk_multiplier),
    commission_percent_no_guarantee: toNumberOrNull(source.commission_percent_no_guarantee),
    offer2_nmg_percent: normalizeRatio(source.offer2_nmg_percent, 0.785),
    capped_threshold_percent: normalizeRatio(source.capped_threshold_percent, 0.1),
  };
}

export function calculateAssetAdminScheduleSheet(input: any, fallbackReport?: Pick<IAssetReport, "lots" | "preview_data"> & Record<string, any>): AssetAdminScheduleSheet {
  const defaultSheet = fallbackReport
    ? buildDefaultAssetAdminScheduleSheet(fallbackReport)
    : {
        evaluator_columns: getDefaultEvaluatorColumns(),
        rows: [],
        file_summary: getDefaultFileSummary(),
      };
  const sourceColumns = Array.isArray(input?.evaluator_columns)
    ? input.evaluator_columns
    : defaultSheet.evaluator_columns;

  const evaluator_columns: AssetAdminScheduleEvaluatorColumn[] = sourceColumns.map((column: any, index: number) => ({
    id: safeString(column?.id) || makeEvaluatorId(index),
    name: safeString(column?.name) || `Evaluator ${index + 1}`,
    ...(safeString(column?.user_id) ? { user_id: safeString(column.user_id) } : {}),
    ...(safeString(column?.email) ? { email: safeString(column.email) } : {}),
    ...(safeString(column?.avatar_url) ? { avatar_url: safeString(column.avatar_url) } : {}),
  }));

  const defaultRowMap = new Map(defaultSheet.rows.map((row) => [row.lot_id, row]));
  const submittedRows = Array.isArray(input?.rows) ? input.rows : null;
  const submittedRowsByLotId = new Map<string, any[]>();
  for (const row of submittedRows || []) {
    const lotId = safeString(row?.lot_id);
    if (!lotId) continue;
    const matchingRows = submittedRowsByLotId.get(lotId) || [];
    matchingRows.push(row);
    submittedRowsByLotId.set(lotId, matchingRows);
  }
  const hasCurrentPreviewLots = Array.isArray(fallbackReport?.preview_data?.lots);
  const hasCurrentRootLots =
    Array.isArray(fallbackReport?.lots) && fallbackReport.lots.length > 0;
  const sourceLotsOwnRows = Boolean(
    fallbackReport &&
      (hasCurrentPreviewLots || hasCurrentRootLots) &&
      submittedRows
  );
  const sourceRows = sourceLotsOwnRows
    ? defaultSheet.rows.map(
        (defaultRow) =>
          submittedRowsByLotId.get(defaultRow.lot_id)?.shift() || defaultRow
      )
    : submittedRows || defaultSheet.rows;

  const rows: AssetAdminScheduleRow[] = sourceRows.map((row: any, index: number) => {
    const fallbackRow = sourceLotsOwnRows
      ? defaultSheet.rows[index]
      : defaultRowMap.get(safeString(row?.lot_id)) || defaultSheet.rows[index];
    const normalizedEvaluatorValues = Object.fromEntries(
      evaluator_columns.map((column) => [
        column.id,
        toNumberOrNull(row?.evaluator_values?.[column.id]),
      ])
    ) as Record<string, number | null>;

    const filledValues = Object.values(normalizedEvaluatorValues).filter(
      (value): value is number => typeof value === "number" && Number.isFinite(value)
    );
    const low_est_sale_value = filledValues.length ? Math.min(...filledValues) : null;
    const high_est_sale_value = filledValues.length ? Math.max(...filledValues) : null;
    const appraiserAverage = filledValues.length
      ? filledValues.reduce((sum, value) => sum + value, 0) / filledValues.length
      : null;
    const buyer_premium_percent = 15;
    const buyer_premium_amount = appraiserAverage === null ? null : Math.min(appraiserAverage * 0.15, 2000);
    const total_expected_gross =
      appraiserAverage === null || buyer_premium_amount === null ? null : appraiserAverage + buyer_premium_amount;
    const allocated_value = total_expected_gross;
    const cleaning = high_est_sale_value === null ? null : high_est_sale_value * 0.01;
    const lotting_fee = high_est_sale_value === null ? null : high_est_sale_value * 0.01;
    const advertising = high_est_sale_value === null ? null : high_est_sale_value * 0.01;

    return {
      lot_id:
        (sourceLotsOwnRows ? fallbackRow?.lot_id : safeString(row?.lot_id)) ||
        fallbackRow?.lot_id ||
        `lot_${index + 1}`,
      asset_id:
        (sourceLotsOwnRows ? fallbackRow?.asset_id : safeString(row?.asset_id)) ||
        fallbackRow?.asset_id ||
        String(index + 1),
      asset_category: editableString(row, "asset_category", fallbackRow?.asset_category),
      year: editableString(row, "year", fallbackRow?.year),
      make: editableString(row, "make", fallbackRow?.make),
      model: editableString(row, "model", fallbackRow?.model),
      serial_number: editableString(row, "serial_number", fallbackRow?.serial_number),
      cr_details: editableString(row, "cr_details", fallbackRow?.cr_details),
      condition_score: editableString(row, "condition_score", fallbackRow?.condition_score),
      location: editableString(row, "location", fallbackRow?.location),
      pictures: sourceLotsOwnRows
        ? fallbackRow?.pictures || 0
        : normalizeInteger(row?.pictures, fallbackRow?.pictures || 0),
      picture_urls: sourceLotsOwnRows
        ? fallbackRow?.picture_urls || []
        : Array.isArray(row?.picture_urls)
          ? Array.from(
              new Set(
                row.picture_urls
                  .map((value: unknown) => safeString(value))
                  .filter(Boolean)
              )
            )
          : fallbackRow?.picture_urls || [],
      market_check: normalizeMarketCheck(row?.market_check),
      asset_insight: sourceLotsOwnRows
        ? fallbackRow?.asset_insight || ""
        : safeString(row?.asset_insight) || fallbackRow?.asset_insight || "",
      evaluator_values: normalizedEvaluatorValues,
      low_est_sale_value,
      high_est_sale_value,
      buyer_premium_percent,
      buyer_premium_amount,
      total_expected_gross,
      allocated_value,
      notes: editableString(row, "notes", fallbackRow?.notes),
      cleaning,
      lien_search: toNumberOrNull(row?.lien_search),
      video_cost: toNumberOrNull(row?.video_cost),
      lotting_fee,
      advertising,
    };
  });

  return {
    evaluator_columns,
    rows,
    file_summary: normalizeFileSummary(input?.file_summary ?? defaultSheet.file_summary),
  };
}

const PREVIEW_DERIVED_EDITABLE_ROW_FIELDS = [
  "asset_category",
  "year",
  "make",
  "model",
  "serial_number",
  "cr_details",
] as const satisfies ReadonlyArray<keyof AssetAdminScheduleRow>;

function reportForPreviewSource(previewData: Record<string, any>) {
  return {
    preview_data: previewData,
    lots: Array.isArray(previewData?.lots) ? previewData.lots : [],
  } as Pick<IAssetReport, "lots" | "preview_data"> & Record<string, any>;
}

function queueRowsByLotId(rows: AssetAdminScheduleRow[]) {
  const queues = new Map<string, AssetAdminScheduleRow[]>();
  for (const row of rows) {
    const queue = queues.get(row.lot_id) || [];
    queue.push(row);
    queues.set(row.lot_id, queue);
  }
  return queues;
}

export type AssetAdminSchedulePreviewMerge = {
  hadStoredSheet: boolean;
  previousSheet: AssetAdminScheduleSheet;
  nextSheet: AssetAdminScheduleSheet;
};

/**
 * Carries review edits into Proposal Valuation without clobbering unrelated PV
 * work. An explicit change to a review-owned source field wins over an older PV
 * value for that same field; otherwise an intentional PV override is retained.
 * Evaluator values and PV-only market, notes, cost, condition and file-summary
 * fields remain owned by the Proposal Valuation workspace.
 *
 * Row queues preserve occurrence order for legacy duplicate lot ids; current
 * preview membership and order remain authoritative through the normal sheet
 * calculation.
 */
export function mergeAssetAdminScheduleSheetAfterPreviewEdit(input: {
  previousPreviewData: Record<string, any>;
  nextPreviewData: Record<string, any>;
}): AssetAdminSchedulePreviewMerge {
  const storedSheet = input.previousPreviewData?.admin_schedule_sheet;
  const hadStoredSheet = Boolean(
    storedSheet && typeof storedSheet === "object" && !Array.isArray(storedSheet)
  );
  const previousReport = reportForPreviewSource(input.previousPreviewData);
  const nextReport = reportForPreviewSource(input.nextPreviewData);
  const previousSourceSheet = buildDefaultAssetAdminScheduleSheet(previousReport);
  const nextSourceSheet = buildDefaultAssetAdminScheduleSheet(nextReport);
  const previousSheet = calculateAssetAdminScheduleSheet(
    hadStoredSheet ? storedSheet : previousSourceSheet,
    previousReport
  );
  const nextSheet = calculateAssetAdminScheduleSheet(previousSheet, nextReport);
  const previousSourceRows = queueRowsByLotId(previousSourceSheet.rows);

  for (let index = 0; index < nextSheet.rows.length; index += 1) {
    const row = nextSheet.rows[index];
    const nextSourceRow = nextSourceSheet.rows[index];
    if (!row || !nextSourceRow) continue;
    const previousSourceRow = previousSourceRows.get(nextSourceRow.lot_id)?.shift();
    if (!previousSourceRow) continue;

    for (const field of PREVIEW_DERIVED_EDITABLE_ROW_FIELDS) {
      const reviewChanged =
        nextSourceRow[field] !== previousSourceRow[field];
      const pvStillFollowsPreviousReview =
        row[field] === previousSourceRow[field];
      if (reviewChanged || pvStillFollowsPreviousReview) {
        (row as any)[field] = nextSourceRow[field];
      }
    }
  }

  return {
    hadStoredSheet,
    previousSheet,
    nextSheet: calculateAssetAdminScheduleSheet(nextSheet),
  };
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

export function getAssetScheduleRowAppraiserAverage(
  row: AssetAdminScheduleRow,
  evaluatorColumns: AssetAdminScheduleEvaluatorColumn[]
) {
  const values = evaluatorColumns
    .map((column) => toNumberOrNull(row.evaluator_values?.[column.id]))
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function getAssetScheduleRowRiskScore(
  marketCheck: AssetAdminScheduleMarketCheck
) {
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

/**
 * Canonical Proposal Valuation summary. This intentionally mirrors the admin
 * workbook arithmetic so the admin and appraiser applications never maintain
 * independent financial formulas.
 */
export function deriveAssetScheduleSummary(
  sheet: AssetAdminScheduleSheet
): AssetScheduleDerivedSummary {
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
    const rowAverage = getAssetScheduleRowAppraiserAverage(
      row,
      sheet.evaluator_columns
    );
    rowAverages[row.lot_id] = rowAverage;
    totalAssetValue += rowAverage;
    totalLowEstValue += toFiniteNumber(row.low_est_sale_value);
    totalHighEstValue += toFiniteNumber(row.high_est_sale_value);
    totalCappedBp += toFiniteNumber(row.buyer_premium_amount);
    totalProjectedCosts +=
      toFiniteNumber(row.cleaning) +
      toFiniteNumber(row.lien_search) +
      toFiniteNumber(row.video_cost) +
      toFiniteNumber(row.lotting_fee) +
      toFiniteNumber(row.advertising);

    const score = getAssetScheduleRowRiskScore(row.market_check);
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
          : 1 -
            (cappedTotalCost + cappedNmg - totalCappedBp) / cappedAvg,
    },
  };
}

export function buildAssetScheduleCalculations(
  sheet: AssetAdminScheduleSheet,
  summary = deriveAssetScheduleSummary(sheet)
): AssetScheduleCalculation[] {
  const basis = sheet.file_summary.buyers_premium_basis;
  const calculation = (
    key: string,
    label: string,
    value: number | string | null,
    formula: string,
    inputs: Record<string, number | string | null>
  ): AssetScheduleCalculation => ({ key, label, value, formula, inputs });
  const base = {
    total_asset_value: summary.total_asset_value,
    total_low_est_value: summary.total_low_est_value,
    total_high_est_value: summary.total_high_est_value,
    total_capped_bp: summary.total_capped_bp,
    total_projected_costs: summary.total_projected_costs,
  };
  const u = summary.uncapped;
  const c = summary.capped;
  return [
    calculation("total_asset_value", "Total Asset Value", summary.total_asset_value, "Sum of each asset's average entered evaluator value", { asset_count: sheet.rows.length }),
    calculation("estimated_range", "Estimated Range", `${summary.total_low_est_value}-${summary.total_high_est_value}`, "Sum of row minimum evaluator values to sum of row maximum evaluator values", { low: summary.total_low_est_value, high: summary.total_high_est_value }),
    calculation("total_low_est_value", "Total Low Estimated Value", summary.total_low_est_value, "Sum of each asset's lowest entered evaluator value", { asset_count: sheet.rows.length }),
    calculation("total_high_est_value", "Total High Estimated Value", summary.total_high_est_value, "Sum of each asset's highest entered evaluator value", { asset_count: sheet.rows.length }),
    calculation("total_capped_bp", "Total Capped Buyer Premium", summary.total_capped_bp, "Sum of 15% of each asset's entered evaluator average, capped at 2000 per asset", { asset_count: sheet.rows.length }),
    calculation("total_projected_costs", "Total Projected Costs", summary.total_projected_costs, "Cleaning + lien search + video + lotting + advertising for all assets", { asset_count: sheet.rows.length }),
    calculation("low_risk_percent", "% Low Risk Value", summary.low_risk_percent, "Low-risk asset value / total asset value", { low_risk_value: summary.low_risk_value, total_asset_value: summary.total_asset_value }),
    calculation("medium_risk_percent", "% Medium Risk Value", summary.medium_risk_percent, "Medium-risk asset value / total asset value", { medium_risk_value: summary.medium_risk_value, total_asset_value: summary.total_asset_value }),
    calculation("high_risk_percent", "% High Risk Value", summary.high_risk_percent, "High-risk asset value / total asset value", { high_risk_value: summary.high_risk_value, total_asset_value: summary.total_asset_value }),
    calculation("weighted_average_risk_score", "Weighted Average Risk Score", summary.weighted_average_risk_score, "Sum(asset average x row risk score) / total asset value", { total_asset_value: summary.total_asset_value }),
    calculation("overall_file_risk_rating", "Overall File Risk Rating", summary.overall_file_risk_rating, "Risk bucket for the asset-value-weighted average market-check score", { weighted_average_risk_score: summary.weighted_average_risk_score }),
    calculation("selected_nmg", "Selected NMG", summary.selected_nmg, basis === "capped" ? "Average asset value - capped costs - capped threshold" : "Uncapped GET x Offer #2 NMG percent", { basis, capped_nmg: c.nmg, uncapped_offer2_nmg: u.offer2_nmg, offer2_nmg_percent: sheet.file_summary.offer2_nmg_percent }),
    calculation("selected_cash_purchase_price", "Selected Cash Purchase Price", summary.selected_cash_purchase_price, basis === "capped" ? "Average asset value" : "Uncapped GET x 90%", { basis, capped_average: c.avg, uncapped_get: u.get }),
    calculation("selected_commission_basis_value", "Selected Commission Basis Value", summary.selected_commission_basis_value, basis === "capped" ? "Sum of capped buyer premiums" : "Uncapped GET - adjusted GET after costs", { basis, capped_buyer_premium: summary.total_capped_bp, uncapped_get: u.get, adjusted_get: u.adjusted_get }),
    calculation("uncapped.get", "Get", u.get, "Total asset value + capped buyer premium", base),
    calculation("uncapped.costs", "Costs", u.costs, "Sum of all projected per-asset costs", { total_projected_costs: summary.total_projected_costs }),
    calculation("uncapped.get_after_costs", "Get After Costs", u.get_after_costs, "Get - costs", { get: u.get, costs: u.costs }),
    calculation("uncapped.adjusted_get", "Adjusted Get", u.adjusted_get, "Get after costs / 1.15", { get_after_costs: u.get_after_costs }),
    calculation("uncapped.bp_15", "15% B.P.", u.bp_15, "Get - adjusted get", { get: u.get, adjusted_get: u.adjusted_get }),
    calculation("uncapped.potential_get", "Potential Get", u.potential_get, "Total high estimate + capped buyer premium", base),
    calculation("uncapped.adjusted_potential_get", "Adjusted Potential Get", u.adjusted_potential_get, "Potential get / 1.15", { potential_get: u.potential_get }),
    calculation("uncapped.potential_bp_15", "Potential 15% B.P.", u.potential_bp_15, "Potential get - adjusted potential get", { potential_get: u.potential_get, adjusted_potential_get: u.adjusted_potential_get }),
    calculation("uncapped.offer1_cash_offer", "Offer #1 Cash Offer", u.offer1_cash_offer, "Get x 90%", { get: u.get }),
    calculation("uncapped.offer1_total_costs", "Offer #1 Total Costs", u.offer1_total_costs, "Offer #1 cash offer + costs", { offer1_cash_offer: u.offer1_cash_offer, costs: u.costs }),
    calculation("uncapped.offer1_mcd_take", "Offer #1 McD Take", u.offer1_mcd_take, "Get - Offer #1 total costs", { get: u.get, offer1_total_costs: u.offer1_total_costs }),
    calculation("uncapped.offer1_roi", "Offer #1 ROI", u.offer1_roi, "Offer #1 McD take / Offer #1 total costs", { offer1_mcd_take: u.offer1_mcd_take, offer1_total_costs: u.offer1_total_costs }),
    calculation("uncapped.offer1_risk", "Offer #1 Risk", u.offer1_risk, "Low estimate + capped buyer premium - Offer #1 total costs", { total_low_est_value: summary.total_low_est_value, total_capped_bp: summary.total_capped_bp, offer1_total_costs: u.offer1_total_costs }),
    calculation("uncapped.offer2_nmg", "Offer #2 NMG", u.offer2_nmg, "Get x Offer #2 NMG percentage", { get: u.get, offer2_nmg_percent: sheet.file_summary.offer2_nmg_percent }),
    calculation("uncapped.offer2_threshold", "Offer #2 Threshold", u.offer2_threshold, "Offer #2 NMG x 15%", { offer2_nmg: u.offer2_nmg }),
    calculation("uncapped.offer2_upper_value", "Offer #2 Upper Value", u.offer2_upper_value, "Offer #2 NMG + threshold", { offer2_nmg: u.offer2_nmg, offer2_threshold: u.offer2_threshold }),
    calculation("uncapped.offer2_total_costs", "Offer #2 Total Costs", u.offer2_total_costs, "Offer #2 NMG + costs", { offer2_nmg: u.offer2_nmg, costs: u.costs }),
    calculation("uncapped.offer2_aquajets_take", "Offer #2 Aquajet's Take", u.offer2_aquajets_take, "Offer #2 NMG", { offer2_nmg: u.offer2_nmg }),
    calculation("uncapped.offer2_overage", "Offer #2 Overage", u.offer2_overage, "Adjusted get - Offer #2 NMG", { adjusted_get: u.adjusted_get, offer2_nmg: u.offer2_nmg }),
    calculation("uncapped.offer2_mcd_take", "Offer #2 McD Take", u.offer2_mcd_take, "15% buyer premium - costs", { bp_15: u.bp_15, costs: u.costs }),
    calculation("uncapped.offer2_roi", "Offer #2 ROI", u.offer2_roi, "Offer #2 McD take / Offer #2 total costs", { offer2_mcd_take: u.offer2_mcd_take, offer2_total_costs: u.offer2_total_costs }),
    calculation("uncapped.offer2_risk", "Offer #2 Risk", u.offer2_risk, "Low estimate + capped buyer premium - Offer #2 total costs", { total_low_est_value: summary.total_low_est_value, total_capped_bp: summary.total_capped_bp, offer2_total_costs: u.offer2_total_costs }),
    calculation("uncapped.aquajets_potential_take", "Aquajet's Potential Take", u.aquajets_potential_take, "NMG + 98% of adjusted potential value above the upper value", { offer2_nmg: u.offer2_nmg, adjusted_potential_get: u.adjusted_potential_get, offer2_upper_value: u.offer2_upper_value }),
    calculation("uncapped.mcd_potential_take", "McD Potential Take", u.mcd_potential_take, "Potential buyer premium - costs + threshold + 2% of potential overage", { potential_bp_15: u.potential_bp_15, costs: u.costs, offer2_threshold: u.offer2_threshold, adjusted_potential_get: u.adjusted_potential_get, offer2_upper_value: u.offer2_upper_value }),
    calculation("uncapped.potential_roi", "Potential ROI", u.potential_roi, "McD potential take / Offer #2 total costs", { mcd_potential_take: u.mcd_potential_take, offer2_total_costs: u.offer2_total_costs }),
    calculation("uncapped.offer3_mcd_take", "Offer #3 Commission", u.offer3_mcd_take, "Uncapped 15% buyer premium", { bp_15: u.bp_15 }),
    calculation("capped.avg", "AVG", c.avg, "Total asset value", { total_asset_value: summary.total_asset_value }),
    calculation("capped.high", "HIGH", c.high, "Sum of high estimated sale values", { total_high_est_value: summary.total_high_est_value }),
    calculation("capped.low", "LOW", c.low, "Sum of low estimated sale values", { total_low_est_value: summary.total_low_est_value }),
    calculation("capped.bp", "BP", c.bp, "Sum of capped per-asset buyer premiums", { total_capped_bp: summary.total_capped_bp }),
    calculation("capped.sale_total_inc_bp", "Sale Total Including B.P.", c.sale_total_inc_bp, "AVG + BP", { avg: c.avg, bp: c.bp }),
    calculation("capped.ads", "Ads", c.ads, "AVG x 1%", { avg: c.avg }),
    calculation("capped.svr", "SVR", c.svr, "AVG x 1%", { avg: c.avg }),
    calculation("capped.refurb", "Refurb", c.refurb, "AVG x 1%", { avg: c.avg }),
    calculation("capped.total_cost", "Total Cost", c.total_cost, "Ads + SVR + refurb", { ads: c.ads, svr: c.svr, refurb: c.refurb }),
    calculation("capped.nmg", "NMG", c.nmg, "AVG - total cost - threshold", { avg: c.avg, total_cost: c.total_cost, threshold: c.threshold }),
    calculation("capped.threshold", "Threshold", c.threshold, "AVG x capped threshold percentage", { avg: c.avg, capped_threshold_percent: sheet.file_summary.capped_threshold_percent }),
    calculation("capped.risk", "Risk", c.risk, "1 - ((total cost + NMG - BP) / AVG)", { total_cost: c.total_cost, nmg: c.nmg, bp: c.bp, avg: c.avg }),
  ];
}
