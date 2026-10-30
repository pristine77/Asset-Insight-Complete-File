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

// Prefer the country returned by reverse geocoding. This conservative fallback
// handles explicitly named countries in imported/manually entered locations;
// ambiguous city names (for example London or Paris) do not choose a currency.
export function currencyForReportLocation(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const location = value.trim().toLowerCase().replace(/\s+/g, " ");
  const regions: Array<[RegExp, string]> = [
    [/\bcanada\b/, "CAD"],
    [/\b(?:united states(?: of america)?|usa|u\.s\.a\.?)\b/, "USD"],
    [/\b(?:united kingdom|england|scotland|wales|northern ireland|uk|u\.k\.?)\b/, "GBP"],
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
  if (/\b(?:saskatchewan|alberta|ontario|british columbia|manitoba|quebec|québec|nova scotia|new brunswick|newfoundland|nunavut|yukon)\b/.test(location)) return "CAD";
  if (/\b(?:texas|california|florida|new york|new mexico|north dakota|south dakota)\b/.test(location)) return "USD";
  return undefined;
}
