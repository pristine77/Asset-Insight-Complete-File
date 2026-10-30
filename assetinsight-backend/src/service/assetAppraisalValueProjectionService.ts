import { calculateAssetAdminScheduleSheet } from "./assetAdminScheduleSheetService.js";
import { getCanonicalProposalValuationSheet } from "./proposalValuationService.js";
import { resolveAssetValuationCodes, valuationRecordCode, type AssetValuationCode } from "../utils/assetValuationSelection.js";

type ExactAmount = { n: bigint; d: bigint };
const rowAliases: Record<AssetValuationCode, string[]> = {
  FMV: ["fmv", "fair_market_value"],
  FLV: ["flv", "forced_liquidation_value"],
  OLV: ["olv", "orderly_liquidation_value"],
  TKV: ["tkv", "trade_in_value", "trade_value"],
};
const totalAliases: Record<AssetValuationCode, string[]> = {
  ...rowAliases,
  FLV: [...rowAliases.FLV, "total_forced_liquidation_value"],
  OLV: [...rowAliases.OLV, "total_orderly_liquidation_value"],
  TKV: [...rowAliases.TKV, "total_trade_in_value"],
};

function numeric(value: unknown, currency: string): number | undefined {
  if (value == null || String(value).trim() === "") return undefined;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw new Error("A saved appraisal amount is invalid. Correct it before updating report files.");
  }
  const raw = String(value).trim();
  if (!/\d/.test(raw)) return undefined;
  const symbol = new Intl.NumberFormat("en-CA", { style: "currency", currency }).formatToParts(1)
    .find((part) => part.type === "currency")?.value;
  let cleaned = raw.replace(/\s/g, "");
  let sign = cleaned.startsWith("-") ? "-" : "";
  if (sign) cleaned = cleaned.slice(1);
  for (const prefix of [currency, symbol, ...(currency === "CAD" ? ["CA$", "C$"] : currency === "USD" ? ["US$"] : []), "$"]
    .filter(Boolean) as string[]) {
    if (cleaned.startsWith(prefix)) cleaned = cleaned.slice(prefix.length);
    if (cleaned.endsWith(prefix)) cleaned = cleaned.slice(0, -prefix.length);
  }
  if (!sign && cleaned.startsWith("-")) { sign = "-"; cleaned = cleaned.slice(1); }
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(cleaned)) {
    throw new Error("A saved appraisal amount is not a single valid number. Correct it before updating report files.");
  }
  const number = Number(sign + cleaned.replace(/,/g, ""));
  if (!Number.isFinite(number)) throw new Error("A saved appraisal amount is invalid. Correct it before updating report files.");
  const original = exactDecimal(sign + cleaned.replace(/,/g, ""));
  const parsed = exact(number);
  if (original.n * parsed.d !== parsed.n * original.d) {
    throw new Error("A saved appraisal amount has too much precision to include safely. Correct it before updating report files.");
  }
  return number;
}

function exact(value: number): ExactAmount {
  return exactDecimal(value.toString());
}

function exactDecimal(value: string): ExactAmount {
  const [coefficient, exponentText = "0"] = value.toLowerCase().split("e");
  const negative = coefficient.startsWith("-");
  const [whole, fraction = ""] = coefficient.replace(/^-/, "").split(".");
  const exponent = Number(exponentText) - fraction.length;
  const integer = BigInt(whole + fraction) * (negative ? -1n : 1n);
  return exponent >= 0
    ? { n: integer * 10n ** BigInt(exponent), d: 1n }
    : { n: integer, d: 10n ** BigInt(-exponent) };
}

function add(left: ExactAmount, right: ExactAmount): ExactAmount {
  const n = left.n * right.d + right.n * left.d;
  const d = left.d * right.d;
  let x = n < 0n ? -n : n, y = d;
  while (y) { const remainder = x % y; x = y; y = remainder; }
  return { n: n / x, d: d / x };
}

function roundedUnits(value: ExactAmount, scale: bigint): bigint {
  const negative = value.n < 0n;
  const numerator = (negative ? -value.n : value.n) * scale;
  const units = (numerator * 2n + value.d) / (2n * value.d);
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("An appraisal amount is too large to include safely. Correct the evaluator value before updating report files.");
  }
  return negative ? -units : units;
}

function amountText(units: bigint, currency: string, digits: number): string {
  const negative = units < 0n;
  const text = (negative ? -units : units).toString().padStart(digits + 1, "0");
  return `${currency} ${negative ? "-" : ""}${digits ? `${text.slice(0, -digits)}.${text.slice(-digits)}` : text}`;
}

function percentage(record: any): number | undefined {
  const raw = record?.percentage;
  if (raw == null || String(raw).trim() === "") return undefined;
  const value = Number(String(raw).trim().replace(/%$/, ""));
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Appraisal files use entered evaluator averages; the Proposal Valuation sheet
 * and stored AI estimates remain their independent sources. This is deliberately
 * a render-only copy, never a persistence or currency-conversion operation.
 */
export function projectAssetAppraisalValues(reportData: any): any {
  const storedSheet = reportData?.admin_schedule_sheet ?? reportData?.preview_data?.admin_schedule_sheet;
  const lots: any[] = Array.isArray(reportData?.lots) ? reportData.lots : reportData?.preview_data?.lots;
  if (!storedSheet || !Array.isArray(lots) || lots.length === 0) return reportData;

  // Supplying only the current render lots avoids an old nested preview choosing
  // different membership. The normalized sheet is private: never replace the
  // saved sheet, whose Asset Insight column must retain the original AI values.
  const ownerId = reportData?.user && typeof reportData.user === "object"
    ? reportData.user._id : reportData?.user;
  const sheet = ownerId
    ? getCanonicalProposalValuationSheet({ ...reportData, lots,
      preview_data: { ...reportData?.preview_data, lots, admin_schedule_sheet: storedSheet } })
    : calculateAssetAdminScheduleSheet(storedSheet, { lots } as any);
  const currency = String(reportData?.currency || reportData?.preview_data?.currency || "CAD").toUpperCase();
  const rawRowsByLotId = new Map<string, any[]>();
  for (const row of Array.isArray(storedSheet.rows) ? storedSheet.rows : []) {
    const id = String(row?.lot_id ?? "").trim();
    const matches = rawRowsByLotId.get(id) || [];
    matches.push(row);
    rawRowsByLotId.set(id, matches);
  }
  const averages = sheet.rows.map((row) => {
    // Validate original inputs before the compatibility sheet normalizer can
    // collapse a range or locale-ambiguous string into a different number.
    const rawRow = rawRowsByLotId.get(row.lot_id)?.shift();
    const entered = sheet.evaluator_columns.map((column) => numeric(rawRow?.evaluator_values?.[column.id], currency))
      .filter((value): value is number => value !== undefined);
    if (!entered.length) return undefined;
    const sum = entered.map(exact).reduce(add, { n: 0n, d: 1n });
    return { n: sum.n, d: sum.d * BigInt(entered.length) };
  });
  if (!averages.some((value) => value !== undefined)) return reportData;

  const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const scale = 10n ** BigInt(digits);
  // Match the certificate's legacy selection when the field is absent, so an
  // evaluator override cannot reach its historical unsaved 70/85% fallbacks.
  const selected = resolveAssetValuationCodes(reportData, ["FLV", "OLV"]);
  const records: any[] = Array.isArray(reportData?.valuation_data?.methods) ? reportData.valuation_data.methods : [];
  const rates = new Map<AssetValuationCode, number>();
  for (const code of selected) {
    const rate = code === "FMV" ? 100 : percentage(records.find((record) => valuationRecordCode(record) === code));
    if (rate === undefined) {
      throw new Error(`The saved ${code} percentage is missing or invalid. Set its percentage before updating report files with evaluator values.`);
    }
    rates.set(code, rate);
  }

  const methodUnits = (base: bigint, code: AssetValuationCode) => {
    const rate = exact(rates.get(code)!);
    return roundedUnits({ n: base * rate.n, d: scale * rate.d * 100n }, scale);
  };
  const sourceUnits = (value: unknown): bigint | undefined => {
    const number = numeric(value, currency);
    return number === undefined ? undefined : roundedUnits(exact(number), scale);
  };
  const projectMethodAliases = (source: any, base: bigint) => {
    const next = { ...source };
    // Explicit legacy aliases outrank estimated_value in some exporters.
    // Only evaluator-overridden rows replace their legacy method aliases.
    for (const code of selected) {
      const amount = Number(methodUnits(base, code)) / Number(scale);
      for (const key of rowAliases[code]) next[key] = amount;
    }
    return next;
  };
  const projectedLots = lots.map((lot, index) => {
    const average = averages[index];
    const items = Array.isArray(lot?.items) ? lot.items : [];
    if (average === undefined) return lot;
    if (items.length > 1) {
      throw new Error(`Lot ${lot?.lot_number || index + 1} has an evaluator value for a group of items. Individual item appraisal values are required before updating report files; the group value cannot be copied to every item.`);
    }
    const base = roundedUnits(average, scale);
    const projectSource = (source: any) => ({ ...projectMethodAliases(source, base), estimated_value: amountText(base, currency, digits) });
    const next = projectSource(lot);
    if (items.length === 1) next.items = [projectSource(items[0])];
    return next;
  });

  const units = sourceUnits;
  const lotBase = (lot: any) => {
    const items = Array.isArray(lot?.items) ? lot.items : [];
    // Schedule A emits item rows instead of their parent. Preserve the same
    // nullish fallback without adding a second parent amount to the certificate.
    return items.length
      ? items.reduce((sum: bigint, item: any) => sum + (units(item?.estimated_value ?? lot?.estimated_value) ?? 0n), 0n)
      : units(lot?.estimated_value) ?? 0n;
  };
  const baseTotal = projectedLots.reduce((sum, lot) => sum + lotBase(lot), 0n);
  const totals = new Map<AssetValuationCode, bigint>();
  for (const code of selected) {
    const valueFor = (source: any, fallbackBase?: unknown) => {
      const explicit = rowAliases[code].map((key) => units(source?.[key])).find((value) => value !== undefined);
      if (explicit !== undefined) return explicit;
      const base = numeric(source?.estimated_value ?? fallbackBase, currency);
      if (base === undefined) return undefined;
      // Blank evaluator rows retain Schedule A's existing source-number
      // calculation, without rounding their base before applying its rate.
      const amount = base * rates.get(code)! / 100;
      if (!Number.isFinite(amount)) throw new Error("The appraisal amount is too large to include safely.");
      return roundedUnits(exact(amount), scale);
    };
    totals.set(code, projectedLots.reduce((sum, lot) => {
      const items = Array.isArray(lot?.items) ? lot.items : [];
      return sum + (items.length
        ? items.reduce((subtotal: bigint, item: any) => subtotal + (valueFor(item, lot?.estimated_value) ?? 0n), 0n)
        : valueFor(lot) ?? 0n);
    }, 0n));
  }
  const baseAmount = Number(baseTotal) / Number(scale);
  if (!Number.isSafeInteger(Number(baseTotal))) throw new Error("The appraisal total is too large to include safely.");
  const projectTotals = (source: any) => {
    // A blank evaluator row may retain an independent explicit method amount.
    // The selected FMV certificate total must match those actual Schedule A rows.
    const reportAmount = Number(totals.get("FMV") ?? baseTotal) / Number(scale);
    const next = { ...source, total_value: reportAmount, total_appraised_value: reportAmount };
    for (const key of totalAliases.FMV) next[key] = baseAmount;
    for (const [code, total] of totals) {
      if (!Number.isSafeInteger(Number(total))) throw new Error("The appraisal total is too large to include safely.");
      for (const key of totalAliases[code]) next[key] = Number(total) / Number(scale);
    }
    return next;
  };
  const projected = projectTotals(reportData);
  projected.lots = projectedLots;
  projected.valuation_data = { ...reportData?.valuation_data, baseFMV: baseAmount,
    ...(reportData?.valuation_data?.base_fmv !== undefined ? { base_fmv: baseAmount } : {}),
    methods: records.map((record) => {
      const code = valuationRecordCode(record);
      const total = code ? totals.get(code) : undefined;
      if (total === undefined) return record;
      const amount = Number(total) / Number(scale);
      return { ...record, value: amount,
        ...(record.amount !== undefined ? { amount } : {}),
        ...(record.estimated_value !== undefined ? { estimated_value: amount } : {}) };
    }),
  };
  // Older certificate templates consult these containers ahead of calculated
  // method records. Keep every amount in the rendering copy consistent.
  for (const key of ["analysis", "valuation", "preview_data"]) {
    if (reportData?.[key] && typeof reportData[key] === "object") projected[key] = projectTotals(reportData[key]);
  }
  return projected;
}
