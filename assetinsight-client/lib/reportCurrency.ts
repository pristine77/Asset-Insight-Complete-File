/** ISO fiat currencies supported by report formatting. Keep legacy saved codes selectable. */
export const REPORT_CURRENCY_CODES = (
  "CAD USD EUR GBP AUD NZD INR AED AFN ALL AMD ANG AOA ARS AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB FJD FKP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HTG HUF IDR ILS IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX UYU UZS VES VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG"
).split(" ");

const CURRENCY_NAMES: Record<string, string> = {
  CAD: "Canadian dollar", USD: "US dollar", EUR: "Euro", GBP: "British pound",
  AUD: "Australian dollar", NZD: "New Zealand dollar", INR: "Indian rupee",
  AED: "UAE dirham", CHF: "Swiss franc", CNY: "Chinese yuan", JPY: "Japanese yen",
  LKR: "Sri Lankan rupee", MXN: "Mexican peso", SGD: "Singapore dollar",
  HKD: "Hong Kong dollar", ZAR: "South African rand", BRL: "Brazilian real",
};

export function normalizeReportCurrency(value: unknown): string {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{3}$/.test(code) ? code : "";
}

export function reportCurrencyLabel(code: string): string {
  return CURRENCY_NAMES[code] ? `${code} — ${CURRENCY_NAMES[code]}` : code;
}

export function reportCurrencyOptions(current: unknown): string[] {
  const code = normalizeReportCurrency(current);
  return code && !REPORT_CURRENCY_CODES.includes(code) ? [...REPORT_CURRENCY_CODES, code] : REPORT_CURRENCY_CODES;
}

/*
 * Canada or the United States, read from the address itself (owner, 2026-10-31:
 * reports were not telling CAD and USD customers apart reliably). Typed
 * addresses rarely name the country, so after an explicit country this reads,
 * strongest first: a Canadian postal code or a US state code with its ZIP, then
 * a province/state name or a ", SK" / ", ND" style code. A tier that points both
 * ways ("Ontario, California", "Delaware, Ontario") chooses nothing, so the
 * user picks. Keep in step with assetinsight-app/src/utils/reportCurrency.ts.
 */
const US_STATE_CODES = "AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY";
const CANADIAN_REGION_CODES = "AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT";
const CANADIAN_POSTAL_CODE = /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d\b/i;
// Upper case only: "IN", "OR" and "ON" are also words.
const US_STATE_WITH_ZIP = new RegExp(`\\b(?:${US_STATE_CODES})\\.?\\s+\\d{5}(?:-\\d{4})?\\b`);
const CANADIAN_REGION_CODE = new RegExp(`,\\s*(?:${CANADIAN_REGION_CODES})\\.?(?:\\s*,|\\s*$|\\s+[A-Z]\\d[A-Z]\\b)`);
const US_STATE_CODE = new RegExp(`,\\s*(?:${US_STATE_CODES})\\.?(?:\\s*,|\\s*$|\\s+\\d{5}\\b)`);
const CANADIAN_REGION_NAMES = /\b(?:alberta|british columbia|manitoba|new brunswick|newfoundland|labrador|nova scotia|ontario|prince edward island|quebec|québec|saskatchewan|northwest territories|nunavut|yukon)\b/;
// Georgia is left out: it is also a country.
const US_STATE_NAMES = /\b(?:alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|district of columbia|florida|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\b/;

/** "CAD" or "USD" when one side is clear; undefined when neither is, or both are. */
export function northAmericanCurrency(value: string): "CAD" | "USD" | undefined {
  const text = value.trim().replace(/\s+/g, " ");
  const lower = text.toLowerCase();
  const tiers: Array<[boolean, boolean]> = [
    [CANADIAN_POSTAL_CODE.test(text), US_STATE_WITH_ZIP.test(text)],
    [
      CANADIAN_REGION_NAMES.test(lower) || CANADIAN_REGION_CODE.test(text),
      US_STATE_NAMES.test(lower) || US_STATE_CODE.test(text),
    ],
  ];
  for (const [canadian, american] of tiers) {
    if (canadian && american) return undefined;
    if (canadian) return "CAD";
    if (american) return "USD";
  }
  return undefined;
}

// Prefer the country returned by reverse geocoding. This conservative fallback
// handles explicitly named countries in imported/manually entered locations,
// then Canadian and US addresses (northAmericanCurrency); ambiguous city names
// (for example London or Paris) do not choose a currency.
export function currencyForReportLocation(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const location = value.trim().toLowerCase().replace(/\s+/g, " ");
  const regions: Array<[RegExp, string]> = [
    [/\bcanada\b/, "CAD"],
    [/\b(?:united states(?: of america)?|usa|u\.s\.a\.?)\b/, "USD"],
    [/\b(?:united kingdom|great britain|england|scotland|wales|northern ireland|uk|u\.k\.?)\b/, "GBP"],
    [/\bnew zealand\b/, "NZD"], [/\baustralia\b/, "AUD"],
    [/\bindia\b/, "INR"], [/\bsri lanka\b/, "LKR"],
    [/\b(?:germany|france|spain|italy|netherlands|belgium|portugal|austria|finland|greece|luxembourg)\b|(?<!northern )\bireland\b/, "EUR"],
    [/\bjapan\b/, "JPY"], [/\bchina\b/, "CNY"], [/\bsingapore\b/, "SGD"],
    [/\b(?:united arab emirates|uae)\b/, "AED"], [/\bswitzerland\b/, "CHF"],
    [/\bsouth africa\b/, "ZAR"], [/(?<!new )\bmexico\b/, "MXN"], [/\bbrazil\b/, "BRL"],
  ];
  const explicit = new Set(regions.filter(([pattern]) => pattern.test(location)).map(([, code]) => code));
  if (explicit.size === 1) return [...explicit][0];
  if (explicit.size > 1) return undefined;
  return northAmericanCurrency(value);
}
