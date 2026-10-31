import api from '../services/api';

export const REPORT_CURRENCIES = ['CAD', 'USD', 'GBP', 'EUR', 'AUD', 'NZD', 'CHF', 'JPY', 'CNY', 'INR', 'MXN', 'BRL', 'SEK', 'NOK', 'DKK', 'SGD', 'HKD', 'ZAR', 'AED', 'SAR', 'KRW'] as const;

export function normalizeReportCurrency(value: unknown): string | null {
  const code = String(value || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return null;
  try { new Intl.NumberFormat('en', { style: 'currency', currency: code }); return code; } catch { return null; }
}

/*
 * Canada or the United States, read from the address itself (owner, 2026-10-31:
 * reports were not telling CAD and USD customers apart reliably). Strongest
 * first: a Canadian postal code or a US state code with its ZIP, then a
 * province/state name or a ", SK" / ", ND" style code. A tier that points both
 * ways ("Ontario, California", "Delaware, Ontario") chooses nothing. Kept in
 * step with assetinsight-client/lib/reportCurrency.ts (no lookbehind here, for
 * the phone's JavaScript engine).
 */
const US_STATE_CODES = 'AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY';
const CANADIAN_REGION_CODES = 'AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT';
const CANADIAN_POSTAL_CODE = /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b/i;
// Upper case only: "IN", "OR" and "ON" are also words.
const US_STATE_WITH_ZIP = new RegExp(`\\b(?:${US_STATE_CODES})\\.?\\s+\\d{5}(?:-\\d{4})?\\b`);
const CANADIAN_REGION_CODE = new RegExp(`,\\s*(?:${CANADIAN_REGION_CODES})\\.?(?:\\s*,|\\s*$|\\s+[A-Z]\\d[A-Z]\\b)`);
const US_STATE_CODE = new RegExp(`,\\s*(?:${US_STATE_CODES})\\.?(?:\\s*,|\\s*$|\\s+\\d{5}\\b)`);
const CANADIAN_REGION_NAMES = /\b(?:alberta|british columbia|manitoba|new brunswick|newfoundland|labrador|nova scotia|ontario|prince edward island|quebec|québec|saskatchewan|northwest territories|nunavut|yukon)\b/;
// Georgia is left out: it is also a country.
const US_STATE_NAMES = /\b(?:alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|district of columbia|florida|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b/;

/** 'CAD' or 'USD' when one side is clear; null when neither is, or both are. */
export function northAmericanCurrency(value: string): 'CAD' | 'USD' | null {
  const text = value.trim().replace(/\s+/g, ' ');
  const lower = text.toLowerCase();
  const tiers: Array<[boolean, boolean]> = [
    [CANADIAN_POSTAL_CODE.test(text), US_STATE_WITH_ZIP.test(text)],
    [
      CANADIAN_REGION_NAMES.test(lower) || CANADIAN_REGION_CODE.test(text),
      US_STATE_NAMES.test(lower) || US_STATE_CODE.test(text),
    ],
  ];
  for (const [canadian, american] of tiers) {
    if (canadian && american) return null;
    if (canadian) return 'CAD';
    if (american) return 'USD';
  }
  return null;
}

/**
 * Only explicit countries, then Canadian/US addresses — never the phone's
 * locale or an ambiguous city. A named country decides first, so
 * "Ontario, California, United States" is USD; two named countries decide
 * nothing.
 */
export function currencyForReportLocation(location: unknown): string | null {
  const text = String(location || '');
  // "New Mexico" is a state, not the country; "Northern Ireland" is the UK.
  const countries = text.replace(/\bNew Mexico\b/gi, ' ');
  const withoutNorthernIreland = countries.replace(/\bNorthern Ireland\b/gi, ' ');
  const named: Array<[RegExp, string]> = [
    [/\b(Canada|Canadian)\b/i, 'CAD'],
    [/\b(United States|USA|U\.S\.A\.?)\b/i, 'USD'],
    [/\b(United Kingdom|UK|Great Britain|England|Scotland|Wales|Northern Ireland)\b/i, 'GBP'],
    [/\b(Australia)\b/i, 'AUD'],
    [/\b(New Zealand)\b/i, 'NZD'],
    [/\b(France|Germany|Spain|Italy|Ireland|Portugal|Netherlands|Belgium|Austria|Finland|Greece)\b/i, 'EUR'],
    [/\b(Switzerland)\b/i, 'CHF'],
    [/\b(Japan)\b/i, 'JPY'],
    [/\b(India)\b/i, 'INR'],
    [/\b(Mexico)\b/i, 'MXN'],
  ];
  const explicit = new Set(named
    .filter(([pattern, code]) => pattern.test(code === 'EUR' ? withoutNorthernIreland : countries))
    .map(([, code]) => code));
  if (explicit.size === 1) return [...explicit][0];
  if (explicit.size > 1) return null;
  return northAmericanCurrency(text);
}

export async function detectReportCurrency(location: unknown, latitude?: number, longitude?: number): Promise<string | null> {
  const namedCurrency = currencyForReportLocation(location);
  if (namedCurrency) return namedCurrency;
  if (latitude == null || longitude == null || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  try {
    const response = await api.post('/location/reverse-geocode', { latitude, longitude }, { timeout: 8_000 });
    return normalizeReportCurrency(response.data?.data?.currency ?? response.data?.currency);
  } catch { return null; }
}
