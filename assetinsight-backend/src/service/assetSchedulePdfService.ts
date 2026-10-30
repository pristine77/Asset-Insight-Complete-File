/**
 * Converts heterogeneous asset/lot shapes into a stable schedule row contract before
 * rendering HTML to PDF. Field aliases and conservative fallbacks are compatibility
 * rules for historical reports; cloning prevents presentation normalization from
 * mutating the persisted report object supplied by callers.
 */
import puppeteer from "puppeteer";
import {
  configurePuppeteerPageTimeouts,
  PUPPETEER_NAVIGATION_TIMEOUT_MS,
} from "../utils/puppeteerTimeout.js";
import handlebars from "handlebars";
import fs from "fs/promises";
import path from "path";
import { toTitleCaseWords } from "./docx/builders/utils.js";
import { extractHourMeterReading } from "../utils/hourMeterReading.js";
import { resolveCrLotDescription } from "../utils/crLotDescription.js";
import { resolveAssetValuationCodes, valuationRecordCode, type AssetValuationCode } from "../utils/assetValuationSelection.js";
import { assetScheduleAmountWidth } from "../utils/assetScheduleAmountWidth.js";
import { projectAssetAppraisalValues } from "./assetAppraisalValueProjectionService.js";
import {
  collectEffectiveAuctioneerManualSpecOverrides,
  collectAuctioneerSpecRecord,
  findAuctioneerManualSpecOverride,
  isAuctioneerSpecFieldDeleted,
  resolveAuctioneerSpecValue,
} from "../utils/auctioneerSpecRows.js";

export type AssetScheduleRow = {
  lot_number_display: string;
  asset_number: string;
  year: string;
  lot_heading: string;
  title: string;
  usage: string;
  serial_or_vin: string;
  description: string;
  condition: string;
  flv_value: string;
  olv_value: string;
  fmv_value: string;
  valuations: Array<{ code: AssetValuationCode; value: string }>;
  estimated_value: string;
  section_estimated_value: string;
  image_url?: string;
  image_urls?: string[];
};

const assetScheduleFooterTemplate = `
  <div style="width:100%;padding:0 6mm;font-family:'Times New Roman',Times,serif;font-size:8.5pt;color:#374151;display:flex;align-items:center;justify-content:space-between;">
    <span>© McDougall Auctioneers</span>
    <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
  </div>
`;

function cloneReportData(reportData: any): any {
  return JSON.parse(JSON.stringify(reportData || {}));
}

function normalizeTitle(value: any): string {
  const text = String(value || "").trim();
  return text ? toTitleCaseWords(text) : "Untitled Item";
}

function normalizeBodyText(value: any, fallback: string): string {
  const text = String(value || "").trim();
  return text ? toTitleCaseWords(text) : fallback;
}

function normalizeSerial(value: any): string {
  const text = String(value || "").trim();
  if (!text) return "Not Found";
  if (text.toLowerCase() === "not found") return "Not Found";
  return text;
}

function parseCurrencyAmount(rawValue: any): number | undefined {
  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    return rawValue;
  }

  const cleaned = String(rawValue || "")
    .replace(/,/g, "")
    .replace(/[^0-9.-]+/g, "")
    .trim();

  if (!cleaned) return undefined;

  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getCurrencyPrefix(currencyCode: string): string {
  const code = String(currencyCode || "CAD").toUpperCase();
  if (code === "CAD") return "CA$";
  if (code === "USD") return "US$";
  if (code === "AUD") return "A$";
  if (code === "NZD") return "NZ$";
  return `${code} `;
}

function formatCurrencyDisplay(rawValue: any, currencyCode: string): string {
  const parsed = parseCurrencyAmount(rawValue);
  if (parsed === undefined) {
    const text = String(rawValue || "").trim();
    return text || `${getCurrencyPrefix(currencyCode)}0`;
  }

  const prefix = getCurrencyPrefix(currencyCode);
  const formattedNumber = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(parsed);

  return `${prefix}${formattedNumber}`;
}

function formatScheduleCurrency(rawValue: any, currencyCode: string): string {
  const parsed = parseCurrencyAmount(rawValue);
  if (parsed === undefined) return "";

  // ISO codes distinguish CAD/USD and keep PDF width measurement safe for
  // currencies whose native symbols are absent from the standard PDF font.
  return new Intl.NumberFormat("en-CA", {
    style: "currency",
    currency: String(currencyCode || "CAD").trim().toUpperCase(),
    currencyDisplay: "code",
  }).format(parsed).replace(/\u00a0/g, " ");
}

function padLotNumber(rawValue: any, index: number): string {
  const rawText = String(rawValue ?? "")
    .trim()
    .replace(/^(lot\s*#?|#)\s*/i, "")
    .trim();
  if (rawText) return rawText;
  const numeric = Number.parseInt(rawText, 10);
  const safeNumber = Number.isFinite(numeric) ? numeric : index + 1;
  return String(safeNumber).padStart(3, "0");
}

function resolveImageUrl(reportData: any, lot: any, item?: any): string | undefined {
  return resolveImageUrls(reportData, lot, item)[0];
}

function uniqueStrings(values: Array<unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function resolveImageUrls(reportData: any, lot: any, item?: any): string[] {
  const reportImageUrls: string[] = Array.isArray(reportData?.imageUrls)
    ? reportData.imageUrls
    : [];

  const directCandidates = uniqueStrings([
    item?.image_url,
    lot?.image_url,
    ...(Array.isArray(item?.image_urls) ? item.image_urls : []),
    ...(Array.isArray(item?.extra_image_urls) ? item.extra_image_urls : []),
    ...(Array.isArray(lot?.image_urls) ? lot.image_urls : []),
    ...(Array.isArray(lot?.extra_image_urls) ? lot.extra_image_urls : []),
  ]);

  const indexedCandidates: string[] = [];
  const appendReportIndex = (indexValue: unknown) => {
    const index = Number(indexValue);
    if (Number.isFinite(index) && index >= 0 && index < reportImageUrls.length) {
      indexedCandidates.push(reportImageUrls[index]);
    }
  };

  appendReportIndex(item?.image_index);
  for (const index of Array.isArray(item?.image_indexes) ? item.image_indexes : []) appendReportIndex(index);
  for (const index of Array.isArray(item?.extra_image_indexes) ? item.extra_image_indexes : []) appendReportIndex(index);
  for (const index of Array.isArray(lot?.image_indexes) ? lot.image_indexes : []) appendReportIndex(index);
  for (const index of Array.isArray(lot?.extra_image_indexes) ? lot.extra_image_indexes : []) appendReportIndex(index);

  const itemLocalIndex = Number(item?.image_local_index);
  if (
    Number.isFinite(itemLocalIndex) &&
    Array.isArray(lot?.image_urls) &&
    itemLocalIndex >= 0 &&
    itemLocalIndex < lot.image_urls.length
  ) {
    indexedCandidates.push(lot.image_urls[itemLocalIndex]);
  }

  const resolved = uniqueStrings([...directCandidates, ...indexedCandidates]);
  return resolved.length > 0 ? resolved : reportImageUrls.slice(0, 1);
}

function buildDescription(lot: any, item?: any): string {
  // Reuse the same Title-first export contract as Excel and condition reports.
  // A child owns its summary; do not append its parent's narrative or specs.
  return resolveCrLotDescription(item ?? lot,
    item ? resolveCrLotDescription(lot, "Description Not Available") : "Description Not Available");
}

function collectSpecRecord(source: any): Record<string, any> {
  const specs = source?.condition_report_specs;
  if (!specs || typeof specs !== "object" || Array.isArray(specs)) return {};
  return specs;
}

function findSpecValue(source: any, aliases: string[]): string {
  const specs = collectSpecRecord(source);
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase().replace(/[^a-z0-9]+/g, ""));
  for (const [key, value] of Object.entries(specs)) {
    const normalizedKey = String(key).toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (normalizedAliases.includes(normalizedKey)) {
      const text = String(value || "").trim();
      if (text && !/^not\s+found$/i.test(text)) return text;
    }
  }
  return "";
}

function deriveYear(lot: any, item?: any): string {
  const direct = String(item?.year || lot?.year || lot?.model_year || "").trim();
  if (/^(19|20)\d{2}$/.test(direct)) return direct;
  const spec = findSpecValue(item, ["Year", "Model Year"]) || findSpecValue(lot, ["Year", "Model Year"]);
  if (/^(19|20)\d{2}$/.test(spec)) return spec;
  const text = [item?.title, item?.description, lot?.title, lot?.description, lot?.details].join(" ");
  return text.match(/\b(19[5-9]\d|20[0-4]\d)\b/)?.[1] || "";
}

function deriveUsage(lot: any, item?: any): string {
  const direct = String(item?.usage || lot?.usage || item?.mileage || lot?.mileage || "").trim();
  if (direct) return direct;
  const sources = item ? [item, lot] : [lot];
  let hours: { source: any; value: string; direct: boolean } | undefined;
  // Resolve one source at a time: a child's own direct reading must not be
  // replaced by its parent's table. Within that source, reviewed/manual hours
  // override stale legacy hours, including an intentional blank or deletion.
  for (const source of sources) {
    if (isAuctioneerSpecFieldDeleted(source, "Hours")) {
      hours = { source, value: "", direct: false };
      break;
    }
    const directHours = String(source?.hours ?? "").trim();
    const override = findAuctioneerManualSpecOverride(collectEffectiveAuctioneerManualSpecOverrides(source), "Hours");
    const saved = resolveAuctioneerSpecValue(collectAuctioneerSpecRecord(source), "Hours");
    if (override.found || saved || source?.condition_report_specs_reviewed === true) {
      hours = { source, value: (override.found ? override.value : saved).replace(/\s*(hours?|hrs?)\b.*$/i, ""), direct: Boolean(directHours) };
      break;
    }
    if (directHours) {
      hours = { source, value: directHours, direct: true };
      break;
    }
  }
  // Preserve existing direct-hours precedence over specification fallbacks.
  if (hours?.direct && hours.value) return hours.value;
  for (const source of sources) {
    const spec = findSpecValue(source, ["Usage", "Odometer (Showing Unverified)", "Odometer", "Mileage", "Mileage (Showing Unverified)"]);
    if (spec) return spec.replace(/\s*(km|kilometers?|mi|miles?|hours?|hrs?)\b.*$/i, "");
    if (hours && hours.source === source && hours.value) return hours.value;
  }
  const text = [item?.description, item?.details, lot?.description, lot?.details].join(" ");
  return (
    text.match(/\b(?:mileage|odometer|showing mileage)\s*[:\-]?\s*([\d,]+(?:\.\d+)?)/i)?.[1] ||
    text.match(/\b([\d,]+(?:\.\d+)?)\s*(?:km|kilometers?|mi|miles?)\b/i)?.[1] ||
    // Cleared hours suppress only the hours fallback, never unrelated mileage.
    (!hours && extractHourMeterReading(text)) ||
    ""
  );
}

function deriveScheduleValues(report: any, sourceValue: any, currencyCode: string, lot: any, item?: any) {
  const aliases: Record<AssetValuationCode, string[]> = {
    FMV: ["fmv", "fair_market_value"], OLV: ["olv", "orderly_liquidation_value"],
    FLV: ["flv", "forced_liquidation_value"], TKV: ["tkv", "trade_in_value", "trade_value"],
  };
  const records: any[] = Array.isArray(report?.valuation_data?.methods) ? report.valuation_data.methods : [];
  const baseValue = parseCurrencyAmount(sourceValue);
  return resolveAssetValuationCodes(report).map((code) => {
    // Never copy a parent lot's liquidation total into each child row. Zero is
    // an explicit amount, not a reason to substitute a calculated value.
    const source = item ?? lot;
    let amount = aliases[code].map((key) => parseCurrencyAmount(source?.[key]))
      .find((value) => value !== undefined);
    const detail = records.find((record) => valuationRecordCode(record) === code);
    const percentage = detail?.percentage == null || String(detail.percentage).trim() === ""
      ? (code === "FMV" ? 100 : undefined)
      : Number(String(detail.percentage).replace(/%$/, "").trim());
    if (amount === undefined && baseValue !== undefined && percentage !== undefined && Number.isFinite(percentage) && percentage >= 0) {
      amount = baseValue * percentage / 100;
    }
    // Missing saved method percentages stay blank instead of inventing 70/85%.
    return { code, value: formatScheduleCurrency(amount, currencyCode) };
  });
}

export function buildScheduleRows(reportData: any): AssetScheduleRow[] {
  reportData = projectAssetAppraisalValues(reportData);
  const lots: any[] = Array.isArray(reportData?.lots) ? reportData.lots : [];
  const currencyCode = String(reportData?.currency || "CAD").toUpperCase();
  const rows: AssetScheduleRow[] = [];

  lots.forEach((lot, lotIndex) => {
    const lotNumberDisplay = padLotNumber(lot?.lot_number, lotIndex);
    const lotTitle = normalizeTitle(lot?.title);
    const lotCondition = normalizeBodyText(lot?.condition || lot?.item_condition, "Condition Not Available");
    const lotEstimatedValue = formatCurrencyDisplay(lot?.estimated_value, currencyCode);
    const lotScheduleValues = deriveScheduleValues(reportData, lot?.estimated_value, currencyCode, lot);
    const catalogueItems: any[] = Array.isArray(lot?.items) ? lot.items : [];

    if (catalogueItems.length > 0) {
      catalogueItems.forEach((item, itemIndex) => {
        const itemSourceValue = item?.estimated_value ?? lot?.estimated_value;
        const itemScheduleValues = deriveScheduleValues(reportData, itemSourceValue, currencyCode, lot, item);
        rows.push({
          lot_number_display: lotNumberDisplay,
          asset_number: lotNumberDisplay,
          year: deriveYear(lot, item),
          lot_heading: normalizeTitle(item?.title || `${lotTitle} ${itemIndex + 1}`),
          title: normalizeTitle(item?.title || lot?.title),
          usage: deriveUsage(lot, item),
          serial_or_vin: normalizeSerial(item?.sn_vin || item?.serial_number || lot?.serial_no_or_label || lot?.serial_number),
          description: buildDescription(lot, item),
          condition: normalizeBodyText(item?.condition || item?.item_condition || lot?.condition || lot?.item_condition, lotCondition),
          estimated_value: formatCurrencyDisplay(itemSourceValue, currencyCode),
          section_estimated_value: formatCurrencyDisplay(itemSourceValue, currencyCode),
          valuations: itemScheduleValues,
          flv_value: itemScheduleValues.find((value) => value.code === "FLV")?.value || "",
          olv_value: itemScheduleValues.find((value) => value.code === "OLV")?.value || "",
          fmv_value: itemScheduleValues.find((value) => value.code === "FMV")?.value || "",
          image_url: resolveImageUrl(reportData, lot, item),
          image_urls: resolveImageUrls(reportData, lot, item),
        });
      });
      return;
    }

    rows.push({
      lot_number_display: lotNumberDisplay,
      asset_number: lotNumberDisplay,
      year: deriveYear(lot),
      lot_heading: lotTitle,
      title: lotTitle,
      usage: deriveUsage(lot),
      serial_or_vin: normalizeSerial(lot?.serial_no_or_label || lot?.serial_number),
      description: buildDescription(lot),
      condition: lotCondition,
      estimated_value: lotEstimatedValue,
      section_estimated_value: lotEstimatedValue,
      valuations: lotScheduleValues,
      flv_value: lotScheduleValues.find((value) => value.code === "FLV")?.value || "",
      olv_value: lotScheduleValues.find((value) => value.code === "OLV")?.value || "",
      fmv_value: lotScheduleValues.find((value) => value.code === "FMV")?.value || "",
      image_url: resolveImageUrl(reportData, lot),
      image_urls: resolveImageUrls(reportData, lot),
    });
  });

  if (rows.length > 0) return rows;

  return [
    {
      lot_number_display: "001",
      asset_number: "001",
      year: "",
      lot_heading: normalizeTitle(reportData?.client_name || reportData?.contract_no || "Asset Report"),
      title: normalizeTitle(reportData?.client_name || "Asset Report"),
      usage: "",
      serial_or_vin: "Not Found",
      description: "Description Not Available",
      condition: "Condition Not Available",
      estimated_value: formatCurrencyDisplay(reportData?.total_value || reportData?.total_appraised_value, currencyCode),
      section_estimated_value: formatCurrencyDisplay(reportData?.total_value || reportData?.total_appraised_value, currencyCode),
      valuations: deriveScheduleValues(reportData, reportData?.total_value ?? reportData?.total_appraised_value, currencyCode, reportData),
      flv_value: "",
      olv_value: "",
      fmv_value: "",
      image_url: resolveImageUrl(reportData, {}),
      image_urls: resolveImageUrls(reportData, {}),
    },
  ];
}

export async function generateAssetSchedulePdfFromReport(reportData: any): Promise<Buffer> {
  try {
    const templatePath = path.resolve(process.cwd(), "src/templates/asset_schedule.html");
    const htmlTemplate = await fs.readFile(templatePath, "utf-8");
    const template = handlebars.compile(htmlTemplate);

    const logoPath = path.resolve(process.cwd(), "public/logo.jpg");
    const logoImage = await fs.readFile(logoPath);
    const logoUrl = `data:image/jpeg;base64,${logoImage.toString("base64")}`;

    const sanitizedData = cloneReportData(reportData);
    const currencyCode = String(sanitizedData?.currency || "CAD").toUpperCase();
    const scheduleRows = buildScheduleRows(sanitizedData);

    const valuationCount = resolveAssetValuationCodes(sanitizedData).length;
    // Letter paper minus the existing 6 mm side margins, in points.
    const tableWidthPt = 612 - 12 * 72 / 25.4;
    const amountTexts = scheduleRows.flatMap((row) => row.valuations.map(({ value }) => value));
    const amountWidth = (size: number) => amountTexts.reduce((widest, value) => Math.max(widest, assetScheduleAmountWidth(value, size)), 0) + 9.5;
    const maximumValuePercent = valuationCount > 0 ? 68 / valuationCount : 68;
    let valuationFontSize = 10;
    while (valuationFontSize > 8 && amountWidth(valuationFontSize) / tableWidthPt * 100 > maximumValuePercent) valuationFontSize -= 0.5;
    const valuationWidth = Math.min(maximumValuePercent, Math.max(10,
      Math.ceil(amountWidth(valuationFontSize) / tableWidthPt * 1000) / 10));
    let serialWidth = 16;
    let imageWidth = 15;
    let descriptionWidth = 100 - serialWidth - imageWidth - valuationCount * valuationWidth;
    if (descriptionWidth < 20) imageWidth = Math.max(8, imageWidth - (20 - descriptionWidth));
    descriptionWidth = 100 - serialWidth - imageWidth - valuationCount * valuationWidth;
    if (descriptionWidth < 20) serialWidth = Math.max(12, serialWidth - (20 - descriptionWidth));
    descriptionWidth = 100 - serialWidth - imageWidth - valuationCount * valuationWidth;

    const finalHtml = template({
      logo_url: logoUrl,
      currency_code: currencyCode,
      report_title: "",
      description_width: descriptionWidth,
      serial_width: serialWidth,
      image_width: imageWidth,
      valuation_width: valuationWidth,
      valuation_font_size: valuationFontSize,
      schedule_rows: scheduleRows,
    });

    const browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      timeout: 120000,
    });

    try {
      const page = await browser.newPage();
      configurePuppeteerPageTimeouts(page);
      await page.setContent(finalHtml, {
        waitUntil: "networkidle0",
        timeout: PUPPETEER_NAVIGATION_TIMEOUT_MS,
      });

      const pdfBuffer = await page.pdf({
        timeout: PUPPETEER_NAVIGATION_TIMEOUT_MS,
        format: "Letter",
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: '<div></div>',
        footerTemplate: assetScheduleFooterTemplate,
        margin: { top: "6mm", right: "6mm", bottom: "10mm", left: "6mm" },
        preferCSSPageSize: true,
      });

      return Buffer.from(pdfBuffer);
    } finally {
      await browser.close();
    }
  } catch (error) {
    console.error("Error generating asset schedule PDF:", error);
    throw new Error("Failed to generate asset schedule PDF report.");
  }
}
