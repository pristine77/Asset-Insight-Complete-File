export type CrAuctionBidValue = 5 | 25 | 100 | 1000;
export type CrClosingTimePeriod = "AM" | "PM";

export type CrDisclaimerSettings = {
  smallsOnsite: boolean;
  smallsOffsite: boolean;
  rollingStockOnsite: boolean;
  rollingStockOffsite: boolean;
  customText: string;
  unreserved: boolean;
  closingDate: string | null;
  closingTime: string | null;
  closingTimePeriod: CrClosingTimePeriod | null;
  bidIncrement: CrAuctionBidValue | null;
  openingBid: CrAuctionBidValue | null;
};

export type CrPredefinedDisclaimerKey =
  | "smallsOnsite"
  | "smallsOffsite"
  | "rollingStockOnsite"
  | "rollingStockOffsite";

export const DEFAULT_CR_DISCLAIMERS: CrDisclaimerSettings = {
  smallsOnsite: false,
  smallsOffsite: false,
  rollingStockOnsite: false,
  rollingStockOffsite: false,
  customText: "",
  unreserved: false,
  closingDate: null,
  closingTime: null,
  closingTimePeriod: null,
  bidIncrement: null,
  openingBid: null,
};

export const CR_DISCLAIMER_OPTIONS: Array<{
  key: CrPredefinedDisclaimerKey;
  label: string;
  html: string;
}> = [
  {
    key: "smallsOnsite",
    label: "Smalls - Notice on Every Lot - Onsite",
    html: `<p>McDougall Auctioneers Ltd. strives to represent the item(s) as visible to the naked eye. We strongly recommend manual inspection at the item(s) location. All payments must be made in full before the item(s) can be released to the purchaser. Please note that all sales are final on this auction sale. Please be advised the purchaser is held accountable for the item(s) within their purchased lot(s). The purchased lot(s) must be completely removed from its location when picked up by the purchaser. Failure to comply to the above requirements results in a mandatory disposal fee.</p>`,
  },
  {
    key: "smallsOffsite",
    label: "Smalls - Notice on Every Lot - Offsite",
    html: `<p>McDougall Auctioneers Ltd. strives to represent the item(s) as visible to the naked eye. We strongly recommend manual inspection at the item(s) location. All payments must be made in full before the item(s) can be released to the purchaser. Please note that all sales are final on this auction sale. Removal of purchased lot(s) is strictly the responsibility of the purchaser. Any damage to the premise/lot(s) during removal, will be the responsibility of the purchaser. Please be advised the purchaser is held accountable for the item(s) within their purchased lot(s). The purchased lot(s) must be completely removed from its location when picked up by the purchaser. Failure to comply to the above requirements results in a mandatory disposal fee.</p>`,
  },
  {
    key: "rollingStockOnsite",
    label: "Rolling Stock - Damage Disclaimer - Onsite",
    html: `<hr><p>All payments must be made in full before the item(s) can be released to the purchaser. Please note that all sales are final on this auction sale. Please be advised the purchaser is held accountable for the item(s) within their purchased lot(s). The purchased lot(s) must be completely removed from its location when picked up by the purchaser. Failure to comply to the above requirements results in a mandatory disposal fee.</p><p>From the time this unit arrived at McDougall Auction's sale location, McDougall Auction verified its specific running condition. Please note there may be minor wear and tear, such as dents, scratches, etc., that are not disclosed in this listing.</p><p>There is no guarantee, representation, or warranty that the vehicle will start, run at idle, or regarding its current registration status at the time of pick-up from McDougall Auction's facility.</p><p>It is the purchaser's sole responsibility to ascertain, confirm, research, inspect, and/or investigate the unit prior to bidding. Once the unit has been removed from McDougall Auction's sale location, the purchaser accepts the unit "as is."</p>`,
  },
  {
    key: "rollingStockOffsite",
    label: "Rolling Stock - Damage Disclaimer - Offsite",
    html: `<hr><p>All payments must be made in full before the item(s) can be released to the purchaser. Please note that all sales are final on this auction sale. Removal of purchased lot(s) is strictly the responsibility of the purchaser. Any damage to the premise/lot(s) during removal, will be the responsibility of the purchaser. Please be advised the purchaser is held accountable for the item(s) within their purchased lot(s). The purchased lot(s) must be completely removed from its location when picked up by the purchaser. Failure to comply to the above requirements results in a mandatory disposal fee.</p><p>From the time this unit arrived at McDougall Auction's sale location, McDougall Auction verified its specific running condition. Please note there may be minor wear and tear, such as dents, scratches, etc., that are not disclosed in this listing.</p><p>There is no guarantee, representation, or warranty that the vehicle will start, run at idle, or regarding its current registration status at the time of pick-up from McDougall Auction's facility.</p>`,
  },
];

const CUSTOM_NOTE_MAX_LENGTH = 8000;
const ALLOWED_CUSTOM_NOTE_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "br",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "strike",
  "ul",
  "ol",
  "li",
  "hr",
]);

const TEXT_ALIGN_TAGS = new Set(["p", "h1", "h2", "h3", "li"]);

function sanitizeCustomNoteAttributes(tag: string, rawAttributes: string): string {
  if (!TEXT_ALIGN_TAGS.has(tag)) return "";
  const styleMatch = rawAttributes.match(/style\s*=\s*["'][^"']*text-align\s*:\s*(left|center|right|justify)\b[^"']*["']/i);
  const alignMatch = rawAttributes.match(/\balign\s*=\s*["']?(left|center|right|justify)\b/i);
  const textAlign = (styleMatch?.[1] || alignMatch?.[1] || "").toLowerCase();
  return textAlign ? ` style="text-align: ${textAlign}"` : "";
}

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripHtmlToText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function hasHtmlTag(value: string): boolean {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}

function stripUnsafeHtml(value: string): string {
  let html = value
    .slice(0, CUSTOM_NOTE_MAX_LENGTH)
    .replace(/\0/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\s*(script|style|iframe|object|embed|svg|math)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(script|style|iframe|object|embed|svg|math)\b[^>]*\/?\s*>/gi, "");

  html = html.replace(/<\s*(\/?)\s*([a-z0-9]+)\b([^>]*)>/gi, (_match, slash, rawTag, rawAttributes) => {
    const tag = String(rawTag || "").toLowerCase();
    if (!ALLOWED_CUSTOM_NOTE_TAGS.has(tag)) return "";
    if (tag === "br" || tag === "hr") return `<${tag}>`;
    if (slash) return `</${tag}>`;
    return `<${tag}${sanitizeCustomNoteAttributes(tag, String(rawAttributes || ""))}>`;
  });

  html = html
    .replace(/<p>\s*(?:<br>)?\s*<\/p>/gi, "")
    .replace(/<li>\s*(?:<p>\s*)?/gi, "<li>")
    .replace(/\s*<\/p>\s*<\/li>/gi, "</li>")
    .replace(/(?:\s*<br>\s*){3,}/gi, "<br><br>")
    .trim();

  return stripHtmlToText(html) ? html : "";
}

function buildPlainCustomNoteHtml(value: string): string {
  return value
    .split(/\r?\n+/)
    .map((line) => cleanText(line))
    .filter(Boolean)
    .map((line) => {
      const registrationHistory = line.match(/^registration\s+history\s*:?\s*(.*)$/i);
      if (registrationHistory) {
        const rest = cleanText(registrationHistory[1]);
        return `<p><b>Registration History:</b>${rest ? ` ${escapeHtml(rest)}` : ""}</p>`;
      }
      return `<p>${escapeHtml(line)}</p>`;
    })
    .join("");
}

export function normalizeCrCustomNoteHtml(value: unknown): string {
  const raw = cleanText(value);
  if (!raw) return "";
  return hasHtmlTag(raw)
    ? stripUnsafeHtml(raw)
    : buildPlainCustomNoteHtml(raw.slice(0, CUSTOM_NOTE_MAX_LENGTH));
}

function hasCustomNoteContent(value: unknown): boolean {
  return !!stripHtmlToText(normalizeCrCustomNoteHtml(value));
}

const CR_AUCTION_BID_VALUES: CrAuctionBidValue[] = [5, 25, 100, 1000];

function normalizeCrAuctionBidValue(value: unknown): CrAuctionBidValue | null {
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value).replace(/[$,\s]/g, "");
  const numeric = Number(normalized);
  return CR_AUCTION_BID_VALUES.includes(numeric as CrAuctionBidValue)
    ? (numeric as CrAuctionBidValue)
    : null;
}

function normalizeCrClosingDate(value: unknown): string | null {
  const text = cleanText(value);
  if (!text) return null;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeCrClosingTimeParts(
  rawTime: unknown,
  rawPeriod: unknown
): { closingTime: string | null; closingTimePeriod: CrClosingTimePeriod | null } {
  const text = cleanText(rawTime);
  const explicitPeriod = cleanText(rawPeriod).toUpperCase();
  const embeddedPeriod = text.match(/\b(AM|PM)\b/i)?.[1]?.toUpperCase();
  let period: CrClosingTimePeriod | null =
    explicitPeriod === "AM" || explicitPeriod === "PM"
      ? explicitPeriod
      : embeddedPeriod === "AM" || embeddedPeriod === "PM"
        ? embeddedPeriod
        : null;

  const timeText = text.replace(/\b(AM|PM)\b/gi, "").trim();
  if (!timeText) return { closingTime: null, closingTimePeriod: null };

  const match = timeText.match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (!match) return { closingTime: null, closingTimePeriod: null };

  const originalHour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  if (!Number.isInteger(originalHour) || !Number.isInteger(minute) || originalHour < 0 || originalHour > 23 || minute < 0 || minute > 59) {
    return { closingTime: null, closingTimePeriod: null };
  }

  let hour = originalHour;
  if (hour === 0) {
    hour = 12;
    period = period || "AM";
  } else if (hour > 12) {
    hour -= 12;
    period = "PM";
  }

  return {
    closingTime: `${hour}:${String(minute).padStart(2, "0")}`,
    closingTimePeriod: period,
  };
}

export function normalizeCrDisclaimers(value: any): CrDisclaimerSettings {
  const closingTimeParts = normalizeCrClosingTimeParts(value?.closingTime, value?.closingTimePeriod);
  return {
    smallsOnsite: value?.smallsOnsite === true,
    smallsOffsite: value?.smallsOffsite === true,
    rollingStockOnsite: value?.rollingStockOnsite === true,
    rollingStockOffsite: value?.rollingStockOffsite === true,
    customText: normalizeCrCustomNoteHtml(value?.customText),
    unreserved: value?.unreserved === true,
    closingDate: normalizeCrClosingDate(value?.closingDate),
    closingTime: closingTimeParts.closingTime,
    closingTimePeriod: closingTimeParts.closingTimePeriod,
    bidIncrement: normalizeCrAuctionBidValue(value?.bidIncrement),
    openingBid: normalizeCrAuctionBidValue(value?.openingBid),
  };
}

export function getCrDisclaimersFromReportData(reportData: any): CrDisclaimerSettings {
  return normalizeCrDisclaimers(
    reportData?.cr_disclaimers ||
      reportData?.preview_data?.cr_disclaimers ||
      reportData?.details?.cr_disclaimers
  );
}

function normalizeLotKeyPart(value: unknown): string {
  return String(value ?? "").trim();
}

export function getCrDisclaimerLotKey(lot: any, index: number): string {
  const lotId = normalizeLotKeyPart(lot?.lot_id);
  if (lotId) return lotId;
  const lotNumber = normalizeLotKeyPart(lot?.lot_number).replace(/^(lot\s*#?|#)\s*/i, "").trim();
  if (lotNumber) return lotNumber.toLowerCase();
  return `index:${index}`;
}

function getCrDisclaimersByLot(reportData: any): Record<string, any> {
  const byLot =
    reportData?.cr_disclaimers_by_lot ||
    reportData?.preview_data?.cr_disclaimers_by_lot ||
    reportData?.details?.cr_disclaimers_by_lot;
  return byLot && typeof byLot === "object" && !Array.isArray(byLot) ? byLot : {};
}

export function getCrDisclaimersForLot(reportData: any, lot: any, index: number): CrDisclaimerSettings {
  const byLot = getCrDisclaimersByLot(reportData);
  const lotKey = getCrDisclaimerLotKey(lot, index);
  if (Object.prototype.hasOwnProperty.call(byLot, lotKey)) {
    return normalizeCrDisclaimers(byLot[lotKey]);
  }
  return getCrDisclaimersFromReportData(reportData);
}

export function countActiveCrDisclaimers(value: any): number {
  const settings = normalizeCrDisclaimers(value);
  return (
    CR_DISCLAIMER_OPTIONS.reduce((count, option) => count + (settings[option.key] ? 1 : 0), 0) +
    (hasCustomNoteContent(settings.customText) ? 1 : 0) +
    (settings.unreserved ? 1 : 0) +
    (settings.closingDate || settings.closingTime ? 1 : 0) +
    (settings.bidIncrement ? 1 : 0) +
    (settings.openingBid ? 1 : 0)
  );
}

export function countLotsWithCrDisclaimers(reportData: any): number {
  const lots = Array.isArray(reportData?.lots) ? reportData.lots : [];
  if (lots.length > 0) {
    return lots.reduce((count: number, lot: any, index: number) => {
      return count + (countActiveCrDisclaimers(getCrDisclaimersForLot(reportData, lot, index)) > 0 ? 1 : 0);
    }, 0);
  }
  return countActiveCrDisclaimers(getCrDisclaimersFromReportData(reportData)) > 0 ? 1 : 0;
}

export function buildCrCustomNoteHtml(value: unknown): string {
  return normalizeCrCustomNoteHtml(value);
}

export function buildCrPredefinedDisclaimersHtml(value: any): string {
  const settings = normalizeCrDisclaimers(value);
  return CR_DISCLAIMER_OPTIONS
    .filter((option) => settings[option.key])
    .map((option) => option.html)
    .join("");
}

export function buildCrDisclaimersHtml(value: any): string {
  const settings = normalizeCrDisclaimers(value);
  return `${buildCrCustomNoteHtml(settings.customText)}${buildCrPredefinedDisclaimersHtml(settings)}`;
}

export function buildCrDisclaimersHtmlForLot(reportData: any, lot: any, index: number): string {
  return buildCrDisclaimersHtml(getCrDisclaimersForLot(reportData, lot, index));
}
