import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import openai from "../utils/openaiClient.js";
import { calculateAssetAdminScheduleSheet } from "./assetAdminScheduleSheetService.js";
import { calculateAssetLotsTotalValue } from "../utils/assetTotalValue.js";

export type CurrencyReportKind = "asset" | "lotListing";
export type CurrencyQuote = {
  fromCurrency: string; toCurrency: string; rate: number; asOf: string;
  sourceUrl: string; sourceTitle: string; quotedAt: string;
};
type Ratio = { n: string; d: string };
type ConversionProof = {
  version: 1; reportId: string; kind: CurrencyReportKind;
  baseCurrency: string; toCurrency: string; sourceHash: string;
  updatedAt: string; pvRevision: number; cumulativeRate: Ratio;
  quote: CurrencyQuote; basisHash: string;
};
export class ReportCurrencyConversionError extends Error {
  constructor(message: string, public statusCode = 400, public code = "CURRENCY_CONVERSION_INVALID") { super(message); }
}
const MAX_SOURCE_AGE_MS = 7 * 24 * 60 * 60_000;
const OFFICIAL_RATE_HOSTS = ["bankofcanada.ca", "ecb.europa.eu", "bankofengland.co.uk", "federalreserve.gov", "rba.gov.au", "rbnz.govt.nz", "snb.ch", "rbi.org.in", "boj.or.jp", "rbn.gov.np", "wise.com", "xe.com"];
const currencies = new Set((Intl as any).supportedValuesOf("currency") as string[]);
const moneyFields = ["opening_bid", "bid_increment", "fmv", "flv", "olv", "tkv", "forced_liquidation_value", "orderly_liquidation_value"];
const has = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const stable = (value: any): any => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
const digest = (value: any) => createHash("sha256").update(JSON.stringify(stable(clone(value || {})))).digest("hex");
const dateText = (value: unknown) => value ? new Date(value as any).toISOString() : "";
export function withoutCurrencyBaseRevision(preview: any) {
  const next = clone(preview || {}); delete next._currency_base_revision; return next;
}
export function currencyBaseRevision(report: any): string {
  return digest({ reportId: String(report._id), updatedAt: dateText(report.updatedAt), revision: Number(report.proposal_valuation_revision || 0), currency: report.currency || "CAD", preview: withoutCurrencyBaseRevision(report.preview_data || {}) });
}
export function withCurrencyBaseRevision(report: any, previewData = report.preview_data): any {
  return { ...(previewData || {}), currency: String(previewData?.currency || report.currency || "CAD").trim().toUpperCase(), _currency_base_revision: currencyBaseRevision(report) };
}
export function supportedReportCurrency(value: unknown): string {
  const code = String(value || "").trim().toUpperCase();
  if (!currencies.has(code)) throw new ReportCurrencyConversionError("Choose a supported currency.");
  return code;
}
function secret() {
  if (!process.env.JWT_SECRET) throw new ReportCurrencyConversionError("Currency conversion is temporarily unavailable.", 503, "CURRENCY_CONVERSION_UNAVAILABLE");
  return process.env.JWT_SECRET;
}
function sign(proof: ConversionProof) {
  const data = Buffer.from(JSON.stringify(proof)).toString("base64url");
  return `${data}.${createHmac("sha256", secret()).update("report-currency-v1:" + data).digest("base64url")}`;
}
function readProof(token: unknown): ConversionProof {
  try {
    if (typeof token !== "string" || token.length > 16_384) throw Error();
    const [data, signature, extra] = token.split(".");
    if (!data || !signature || extra) throw Error();
    const expected = createHmac("sha256", secret()).update("report-currency-v1:" + data).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error();
    const proof = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (proof.version !== 1) throw Error();
    return proof;
  } catch {
    throw new ReportCurrencyConversionError("The currency conversion receipt is invalid. Convert the currency again before saving.", 409, "CURRENCY_QUOTE_EXPIRED");
  }
}
function fraction(value: number): Ratio {
  const s = value.toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
  const [whole, digits = ""] = s.split(".");
  return { n: (BigInt(whole) * 10n ** BigInt(digits.length) + BigInt(digits || "0")).toString(), d: (10n ** BigInt(digits.length)).toString() };
}
function multiply(a: Ratio, b: Ratio): Ratio {
  let n = BigInt(a.n) * BigInt(b.n), d = BigInt(a.d) * BigInt(b.d);
  let x = n, y = d; while (y) { const t = x % y; x = y; y = t; }
  n /= x; d /= x;
  return { n: n.toString(), d: d.toString() };
}
function divide(a: Ratio, b: Ratio) { return multiply(a, { n: b.d, d: b.n }); }
type MonetaryBasis = Record<string, { value: unknown; currency: string; atRate: Ratio }>;
type MoneyConverter = (key: string, value: unknown, text?: boolean) => any;
function sameMoney(a: unknown, b: unknown, currency: string) {
  const left = numericText(a, currency), right = numericText(b, currency);
  if (left === null || right === null) return left === right;
  const ratio = (s: string) => { const negative = s.startsWith("-"); const [w, f = ""] = s.replace(/^-/, "").split("."); return { n: (negative ? -1n : 1n) * (BigInt(w) * 10n ** BigInt(f.length) + BigInt(f || "0")), d: 10n ** BigInt(f.length) }; };
  const x = ratio(left), y = ratio(right); return x.n * y.d === y.n * x.d;
}
function sameMoneyAtPrecision(a: unknown, b: unknown, currency: string) {
  if (numericText(a, currency) === null || numericText(b, currency) === null) return false;
  return convertReportMoney(a, currency, currency, { n: "1", d: "1" }) === convertReportMoney(b, currency, currency, { n: "1", d: "1" });
}
function basisConverter(from: string, to: string, step: Ratio, cumulative: Ratio, priorRate: Ratio, old: MonetaryBasis, next: MonetaryBasis): MoneyConverter {
  return (key, value, text = false) => {
    if (numericText(value, from) === null) return value;
    const original = old[key];
    if (original && sameMoney(value, convertReportMoney(original.value, original.currency, from, divide(priorRate, original.atRate), text), from)) {
      next[key] = original;
      return convertReportMoney(original.value, original.currency, to, divide(cumulative, original.atRate), text);
    }
    next[key] = { value, currency: from, atRate: priorRate };
    return convertReportMoney(value, from, to, step, text);
  };
}
function entryKeys(rows: any[]) {
  const identities = rows.map((row, i) => String(row?.lot_id || row?.id || row?.lot_number || row?.item_id || row?.item_number || `index-${i}`));
  const counts = new Map<string, number>(); for (const id of identities) counts.set(id, (counts.get(id) || 0) + 1);
  return identities.map((id, i) => counts.get(id) === 1 ? encodeURIComponent(id) : `${encodeURIComponent(id)}-index-${i}`);
}
function digits(currency: string) { return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2; }
function numericText(value: unknown, currency: string): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ReportCurrencyConversionError("A saved monetary amount is invalid. Correct it before converting.");
    return value.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  }
  const text = String(value).trim();
  if (!/\d/.test(text)) return null; // Preserve blank/unknown/categorical values, never turn them into zero.
  const symbol = new Intl.NumberFormat("en-CA", { style: "currency", currency }).formatToParts(1).find(p => p.type === "currency")?.value;
  let cleaned = text.replace(/\s/g, "");
  const negativePrefix = cleaned.startsWith("-");
  if (negativePrefix) cleaned = cleaned.slice(1);
  for (const prefix of [currency, symbol, ...(currency === "CAD" ? ["CA$", "C$"] : currency === "USD" ? ["US$"] : []), "$"].filter(Boolean) as string[]) {
    if (cleaned.startsWith(prefix)) cleaned = cleaned.slice(prefix.length);
    if (cleaned.endsWith(prefix)) cleaned = cleaned.slice(0, -prefix.length);
  }
  if (negativePrefix) cleaned = "-" + cleaned;
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,8})?$/.test(cleaned)) throw new ReportCurrencyConversionError("A saved monetary amount cannot be converted safely. Correct its number before converting.");
  return cleaned.replace(/,/g, "");
}
export function convertReportMoney(value: unknown, from: string, to: string, ratio: Ratio, text = false): any {
  const raw = numericText(value, from);
  if (raw === null) return value;
  const negative = raw.startsWith("-");
  const [whole, dec = ""] = raw.replace(/^-/, "").split(".");
  const input = BigInt(whole) * 10n ** BigInt(dec.length) + BigInt(dec || "0");
  const denominator = BigInt(ratio.d) * 10n ** BigInt(dec.length);
  const scale = 10n ** BigInt(digits(to));
  const numerator = input * BigInt(ratio.n) * scale;
  const rounded = (numerator * 2n + denominator) / (2n * denominator);
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new ReportCurrencyConversionError("A converted amount is too large to save safely.");
  const result = (negative ? -Number(rounded) : Number(rounded)) / Number(scale);
  return text ? new Intl.NumberFormat("en-CA", { style: "currency", currency: to, currencyDisplay: "code", minimumFractionDigits: digits(to), maximumFractionDigits: digits(to) }).format(result) : result;
}
function convertLot(lot: any, from: string, to: string, rate: Ratio, key: string, convert: MoneyConverter): any {
  const next = clone(lot);
  if (has(next, "estimated_value")) next.estimated_value = convert(key + ":estimated_value", next.estimated_value, true);
  for (const field of moneyFields) if (has(next, field)) next[field] = convert(key + ":" + field, next[field]);
  if (Array.isArray(next.items)) { const keys = entryKeys(next.items); next.items = next.items.map((item: any, i: number) => convertLot(item, from, to, rate, key + "/item/" + keys[i], convert)); }
  return next;
}
function sumLots(lots: any[], kind: CurrencyReportKind, currency: string) {
  const precision = digits(currency), scale = 10 ** precision;
  // Sum individually rounded lot/group values instead of converting an old total.
  const values = lots.map(lot => kind === "asset" ? calculateAssetLotsTotalValue([lot]) : Number(String(lot?.estimated_value ?? "").replace(/[^0-9.-]/g, "")) || 0);
  let sum = 0n;
  for (const value of values) { const minor = Math.round(value * scale); if (!Number.isSafeInteger(minor)) throw new ReportCurrencyConversionError("The converted total is too large to save safely."); sum += BigInt(minor); }
  if (sum > BigInt(Number.MAX_SAFE_INTEGER) || sum < BigInt(-Number.MAX_SAFE_INTEGER)) throw new ReportCurrencyConversionError("The converted total is too large to save safely.");
  return Number(sum) / scale;
}
function convertSheet(sheet: any, from: string, to: string, rate: Ratio) {
  const next = clone(sheet);
  for (const row of next.rows || []) {
    row.asset_insight = convertReportMoney(row.asset_insight, from, to, rate, true);
    for (const key of Object.keys(row.evaluator_values || {})) row.evaluator_values[key] = convertReportMoney(row.evaluator_values[key], from, to, rate);
    for (const key of ["lien_search", "video_cost"]) if (has(row, key)) row[key] = convertReportMoney(row[key], from, to, rate);
  }
  if (next.file_summary && has(next.file_summary, "total_risk_weighted_value")) next.file_summary.total_risk_weighted_value = convertReportMoney(next.file_summary.total_risk_weighted_value, from, to, rate);
  // The existing 15%, 2,000 cap, cost rules and risk percentages stay canonical.
  return calculateAssetAdminScheduleSheet(next);
}
export function convertPreviewMoney(preview: any, from: string, to: string, rate: Ratio, kind: CurrencyReportKind, converter?: MoneyConverter): any {
  const next = clone(preview);
  const convert: MoneyConverter = converter || ((_key, value, text) => convertReportMoney(value, from, to, rate, text));
  next.currency = to;
  if (Array.isArray(next.lots)) { const keys = entryKeys(next.lots); next.lots = next.lots.map((lot: any, i: number) => convertLot(lot, from, to, rate, "lot/" + keys[i], convert)); }
  const total = Array.isArray(next.lots) ? sumLots(next.lots, kind, to) : undefined;
  const sourceTotal = Array.isArray(preview.lots) ? sumLots(preview.lots, kind, from) : undefined;
  for (const field of ["total_value", "total_appraised_value"]) if (has(next, field)) next[field] = total !== undefined && sourceTotal !== undefined && sameMoneyAtPrecision(next[field], sourceTotal, from) ? total : convert("root/" + field, next[field]);
  if (next.valuation_data && typeof next.valuation_data === "object") {
    const valuation = next.valuation_data;
    const previousBase = valuation.baseFMV;
    if (has(valuation, "baseFMV")) valuation.baseFMV = total !== undefined && sourceTotal !== undefined && sameMoneyAtPrecision(previousBase, sourceTotal, from) ? total : convert("valuation/baseFMV", valuation.baseFMV);
    if (Array.isArray(valuation.methods)) valuation.methods = valuation.methods.map((method: any, i: number) => {
      const hasPercentage = Number.isFinite(Number(method.percentage)) && method.percentage != null && method.percentage !== "";
      const hasExplicitValue = has(method, "value") && method.value != null && method.value !== "";
      const followsBase = hasPercentage && typeof previousBase === "number" && sameMoneyAtPrecision(method.value, previousBase * Number(method.percentage) / 100, from);
      if (hasExplicitValue && !followsBase) return { ...method, value: convert("valuation/method/" + String(method.method || method.type || i), method.value) };
      if (hasPercentage && typeof valuation.baseFMV === "number") return { ...method, value: convertReportMoney(valuation.baseFMV * Number(method.percentage) / 100, to, to, { n: "1", d: "1" }) };
      if (hasExplicitValue) return { ...method, value: convert("valuation/method/" + String(method.method || method.type || i), method.value) };
      return method;
    });
  }
  return next;
}
function validSource(value: unknown): string {
  if (typeof value !== "string") return "";
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.port && OFFICIAL_RATE_HOSTS.some(host => url.hostname === host || url.hostname.endsWith("." + host)) ? url.href.replace(/#.*$/, "").replace(/\/$/, "") : ""; } catch { return ""; }
}
export async function lookupCurrentCurrencyQuote(from: string, to: string): Promise<CurrencyQuote> {
  try {
    const now = new Date();
    const boundedSearch = { max_tool_calls: 2 };
    const response = await openai.responses.create({
      ...boundedSearch, stream: false,
      model: process.env.OPENAI_PRIMARY_MODEL || "gpt-5.6-terra",
      store: false, tools: [{ type: "web_search", search_context_size: "medium" }], tool_choice: "required",
      include: ["web_search_call.action.sources"], max_output_tokens: 1200,
      input: `Find the latest published market exchange rate: 1 ${from} in ${to}. Today is ${now.toISOString().slice(0, 10)} UTC. Search the web. Prefer a central bank; otherwise use Wise or XE. Return only a direct rate in that direction, never guess or use remembered rates. The publication date must be within the last seven days. Report the actual observation date, including weekends, not today's date unless published today. The source URL must be the actual consulted page that supports that number. If no current attributable rate exists, refuse. This is only a currency-pair lookup; there is no report or image analysis.`,
      text: { format: { type: "json_schema", name: "current_currency_exchange", strict: true, schema: {
        type: "object", additionalProperties: false,
        properties: { fromCurrency: { type: "string" }, toCurrency: { type: "string" }, rate: { type: "number" }, asOf: { type: "string" }, sourceUrl: { type: "string" }, sourceTitle: { type: "string" } },
        required: ["fromCurrency", "toCurrency", "rate", "asOf", "sourceUrl", "sourceTitle"],
      } } },
    }, { timeout: 30_000, maxRetries: 0 });
    if (response.status !== "completed") throw Error();
    const parsed = JSON.parse(response.output_text || "");
    const source = validSource(parsed.sourceUrl), consulted = new Set<string>();
    let searched = false;
    for (const output of response.output || []) {
      if (output.type === "web_search_call") {
        searched = true;
        for (const item of (output as any).action?.sources || []) { const url = validSource(item.url); if (url) consulted.add(url); }
      }
      if (output.type === "message") for (const part of output.content) if (part.type === "output_text") for (const annotation of part.annotations || []) if (annotation.type === "url_citation") { const url = validSource(annotation.url); if (url) consulted.add(url); }
    }
    const day = /^\d{4}-\d{2}-\d{2}$/.test(parsed.asOf) ? Date.parse(parsed.asOf + "T00:00:00.000Z") : NaN;
    if (!searched || !source || !consulted.has(source) || parsed.fromCurrency !== from || parsed.toCurrency !== to || typeof parsed.rate !== "number" || !Number.isFinite(parsed.rate) || parsed.rate < 1e-9 || parsed.rate > 1e9 || !Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== parsed.asOf || day > now.getTime() || now.getTime() - day > MAX_SOURCE_AGE_MS || typeof parsed.sourceTitle !== "string" || !parsed.sourceTitle.trim()) throw Error();
    return { fromCurrency: from, toCurrency: to, rate: parsed.rate, asOf: parsed.asOf, sourceUrl: source, sourceTitle: parsed.sourceTitle.trim().slice(0, 200), quotedAt: now.toISOString() };
  } catch {
    throw new ReportCurrencyConversionError("A current exchange rate could not be verified. Your report is unchanged; try again later.", 503, "CURRENCY_RATE_UNAVAILABLE");
  }
}
function assertBound(proof: ConversionProof, report: any, previous: any, kind: CurrencyReportKind) {
  if (proof.reportId !== String(report._id) || proof.kind !== kind || proof.sourceHash !== digest(previous) || proof.updatedAt !== dateText(report.updatedAt) || proof.pvRevision !== Number(report.proposal_valuation_revision || 0)) throw new ReportCurrencyConversionError("The report changed after the currency quote. Refresh and convert again.", 409, "CURRENCY_REPORT_CHANGED");
}
/** Returns a proof only for a new conversion intent; saved provenance never reconverts. */
export function currencyConversionForSave(report: any, previous: any, next: any, kind: CurrencyReportKind): ConversionProof | null {
  delete next._currency_base_revision;
  const metadata = next?.currency_conversion;
  const previousToken = previous?.currency_conversion?.token;
  const current = String(previous?.currency || report.currency || "CAD").toUpperCase();
  const target = String(next?.currency || current).toUpperCase();
  if (metadata?.token && metadata.token !== previousToken) {
    const proof = readProof(metadata.token); assertBound(proof, report, previous, kind);
    if (proof.toCurrency !== target) throw new ReportCurrencyConversionError("Convert the selected currency before saving.");
    if (digest(metadata.quote) !== digest(proof.quote)) throw new ReportCurrencyConversionError("The currency quote was changed. Convert again before saving.");
    if (digest(metadata.basis) !== proof.basisHash) throw new ReportCurrencyConversionError("The currency conversion basis was changed. Convert again before saving.");
    next.currency_conversion = { version: 1, token: metadata.token, quote: proof.quote, basis: metadata.basis };
    return proof;
  }
  if (target !== current) throw new ReportCurrencyConversionError("Use Convert currency before saving a different currency.");
  if (previous?.currency_conversion) next.currency_conversion = previous.currency_conversion;
  else delete next.currency_conversion;
  return null;
}
export function convertedAuthoritativeAssetPreview(previous: any, proof: ConversionProof | null): any {
  return proof && previous.admin_schedule_sheet
    ? { ...previous, admin_schedule_sheet: convertSheet(previous.admin_schedule_sheet, proof.baseCurrency, proof.toCurrency, proof.cumulativeRate) }
    : previous;
}
export async function convertReportPreviewCurrency(input: { report: any; kind: CurrencyReportKind; previewData: any; targetCurrency: unknown }) {
  const { report, kind } = input;
  if (!input.previewData || typeof input.previewData !== "object" || Array.isArray(input.previewData)) throw new ReportCurrencyConversionError("A full report preview is required.");
  const previous = withoutCurrencyBaseRevision(report.preview_data || {}), preview = withoutCurrencyBaseRevision(input.previewData);
  // Some legacy previews lack monetary mirrors that still live on the report.
  // Include those inputs so a currency change never leaves a root amount in the
  // former denomination; explicit current preview values remain authoritative.
  for (const key of ["total_value", "total_appraised_value", "valuation_data"]) if (!has(preview, key) && report[key] !== undefined) preview[key] = clone(report[key]);
  const original = supportedReportCurrency(previous.currency || report.currency || "CAD");
  const from = supportedReportCurrency(preview.currency || original), to = supportedReportCurrency(input.targetCurrency);
  if (from === to) throw new ReportCurrencyConversionError("Choose a different currency to convert.");
  let prior: ConversionProof | null = null;
  if (preview.currency_conversion?.token && preview.currency_conversion.token !== previous.currency_conversion?.token) {
    prior = readProof(preview.currency_conversion.token); assertBound(prior, report, previous, kind);
    if (prior.toCurrency !== from) throw new ReportCurrencyConversionError("The current preview currency does not match its quote.");
    if (digest(preview.currency_conversion.basis) !== prior.basisHash) throw new ReportCurrencyConversionError("The currency conversion basis was changed. Refresh and convert again.");
  } else if (from !== original) throw new ReportCurrencyConversionError("Refresh the preview before converting its currency.", 409, "CURRENCY_REPORT_CHANGED");
  // Invalid monetary text must fail before a paid lookup, not after it.
  convertPreviewMoney(preview, from, to, { n: "1", d: "1" }, kind);
  const quote = await lookupCurrentCurrencyQuote(from, to);
  const rate = fraction(quote.rate), cumulativeRate = prior ? multiply(prior.cumulativeRate, rate) : rate;
  const proof: ConversionProof = { version: 1, reportId: String(report._id), kind, baseCurrency: original, toCurrency: to, sourceHash: digest(previous), updatedAt: dateText(report.updatedAt), pvRevision: Number(report.proposal_valuation_revision || 0), cumulativeRate, quote, basisHash: "" };
  const basis: MonetaryBasis = {};
  const converter = basisConverter(from, to, rate, cumulativeRate, prior?.cumulativeRate || { n: "1", d: "1" }, prior ? preview.currency_conversion.basis : {}, basis);
  const next = convertPreviewMoney(preview, from, to, rate, kind, converter);
  // Ignore client-supplied PV values; the authoritative sheet converts once from
  // its saved base, even after multiple dropdown conversions before Save.
  if (kind === "asset") {
    delete next.admin_schedule_sheet;
    if (previous.admin_schedule_sheet) next.admin_schedule_sheet = convertedAuthoritativeAssetPreview(previous, proof).admin_schedule_sheet;
  }
  proof.basisHash = digest(basis);
  next.currency_conversion = { version: 1, quote, token: sign(proof), basis };
  next._currency_base_revision = currencyBaseRevision(report);
  return { preview_data: next, quote };
}
