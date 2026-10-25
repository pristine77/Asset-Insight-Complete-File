/**
 * Builds the Auctioneer condition-report PDF from the same normalized data contract as
 * the DOCX path. Rendering owns browser lifecycle and print-specific pagination here,
 * ensuring API and worker callers see a buffer-or-error interface instead of Puppeteer
 * details.
 */
import fs from "fs/promises";
import path from "path";
import puppeteer from "puppeteer";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import {
  configurePuppeteerPageTimeouts,
  PUPPETEER_NAVIGATION_TIMEOUT_MS,
} from "../utils/puppeteerTimeout.js";
import { extractVinFromText } from "./vehicleApiService.js";
import {
  allowedCategories,
  assetCategorySpecs,
  type AssetCategorySpec,
} from "../utils/assetCategorySpecs.js";
import {
  buildAuctioneerSpecRows,
  deriveAuctioneerSerial,
  stripRedundantSerialLabel,
  shouldDisplayAuctioneerSpecRow,
} from "../utils/auctioneerSpecRows.js";
import {
  isLotDamageAnalysisEligible,
  resolveDamageAnalysisEnabled,
} from "../utils/lotDamagePolicy.js";
import { stripLeadingDescriptionMarker } from "../utils/previewLotNormalization.js";
import {
  DAMAGE_ANALYSIS_LABEL,
  formatDamageAnalysisLines,
} from "../utils/assetDamageAnalysis.js";
import { selectCrSummaryImages } from "../utils/crLotImageOrder.js";
import { buildCrDisclaimersHtmlForLot } from "../utils/crDisclaimers.js";
import { resolveCrLotDescription } from "../utils/crLotDescription.js";
import {
  buildPdfImageDataUrlMap,
  PdfImagePayloadBudgetError,
} from "../utils/pdfImageDataUrls.js";
import { getPositiveIntEnv } from "../utils/concurrency.js";

type SpecRecord = Record<string, string>;

const categorySpecByKey = new Map(
  assetCategorySpecs.map((spec) => [normalizeKey(spec.childCategory), spec])
);
const categoryNameByKey = new Map(
  allowedCategories.map((category) => [normalizeKey(category), category])
);

const BANK_PHOTOS_PER_PAGE = 4;
const DEFAULT_CHUNK_IMAGE_OCCURRENCES = 32;
const HARD_MAX_CHUNK_IMAGE_OCCURRENCES = 48;
const DEFAULT_CHUNK_RENDER_UNITS = 8;
const HARD_MAX_CHUNK_RENDER_UNITS = 12;
const FALLBACK_CHUNK_MAX_EDGE_PX = 900;
const FALLBACK_CHUNK_JPEG_QUALITY = 74;

type CrPdfRenderUnit = {
  imageUrls: string[];
  buildHtml: (imageDataUrls: ReadonlyMap<string, string>, logoUrl: string) => string;
};

async function runPdfRenderStage<T>(
  stage: string,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error: any) {
    const message = error?.message || String(error);
    const wrapped = new Error(`CR PDF ${stage} failed: ${message}`);
    (wrapped as any).cause = error;
    throw wrapped;
  }
}

function normalizeKey(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function cleanText(value: unknown): string {
  return String(value ?? "").trim();
}

function isUsefulValue(value: unknown): boolean {
  const text = cleanText(value);
  return (
    !!text &&
    !/^(n\/a|na|none|null|unknown|not visible|not found|tbd)$/i.test(text) &&
    !isBoilerplateAuctionText(text)
  );
}

function isBoilerplateAuctionText(value: unknown): boolean {
  const text = cleanText(value);
  return (
    /title clearance clarification fee/i.test(text) ||
    /applied to your invoice/i.test(text) ||
    /over and above the purchase price/i.test(text) ||
    /applicable taxes/i.test(text) ||
    /following the close of the sale/i.test(text)
  );
}

function cleanDisplayText(value: unknown): string {
  const text = stripLeadingDescriptionMarker(value);
  if (!text) return "";
  if (isBoilerplateAuctionText(text)) return "";
  return text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part && !isBoilerplateAuctionText(part))
    .join(" ");
}

function escapeHtml(value: unknown): string {
  return cleanText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function asDate(value: unknown): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return cleanText(value);
  return date.toLocaleDateString("en-US", {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
  });
}

function structuredSpecsToRecord(value: unknown): SpecRecord {
  const out: SpecRecord = {};
  if (Array.isArray(value)) {
    for (const entry of value) {
      const field = cleanText((entry as any)?.field);
      const text = cleanText((entry as any)?.value);
      if (field && isUsefulValue(text)) out[field] = text;
    }
    return out;
  }
  if (value && typeof value === "object") {
    for (const [field, raw] of Object.entries(value as Record<string, unknown>)) {
      const text = cleanText(raw);
      if (field && isUsefulValue(text)) out[field] = text;
    }
  }
  return out;
}

function getSpecValue(record: SpecRecord, field: string): string {
  if (isUsefulValue(record[field])) return record[field];
  const key = normalizeKey(field);
  const match = Object.keys(record).find((candidate) => normalizeKey(candidate) === key);
  return match && isUsefulValue(record[match]) ? record[match] : "";
}

function canonicalCategory(value: unknown): string {
  const raw = cleanText(value);
  return categoryNameByKey.get(normalizeKey(raw)) || raw;
}

function inferCategory(lot: any): string {
  const direct = canonicalCategory(
    lot?.categories || lot?.category || lot?.child_category || lot?.asset_category
  );
  if (direct) return direct;

  const searchable = normalizeKey(
    [lot?.title, lot?.description, lot?.details]
      .filter(Boolean)
      .join(" ")
  );
  return (
    [...allowedCategories]
      .sort((left, right) => right.length - left.length)
      .find((category) => {
        const key = normalizeKey(category);
        return key.length > 5 && searchable.includes(key);
      }) || ""
  );
}

function resolveCategorySpec(lot: any): AssetCategorySpec | null {
  const category = canonicalCategory(inferCategory(lot));
  return category ? categorySpecByKey.get(normalizeKey(category)) || null : null;
}

function stripListMarker(value: string): string {
  return stripLeadingDescriptionMarker(value);
}

function titleFromLot(lot: any, fallback: string): string {
  const explicit = cleanText(lot?.title || lot?.asset_title || lot?.name);
  if (explicit) return explicit;
  const firstDescription = stripListMarker(cleanText(lot?.description)).split(",")[0]?.trim();
  return firstDescription || fallback;
}

function parseFieldFromText(text: string, field: string): string {
  if (!text) return "";
  const parts = text
    .split(/[;\n]+|,(?=\s*[A-Z])/)
    .map((part) => part.trim())
    .filter(Boolean);
  const fieldLabel = field.replace(/\s*\([^)]*\)/g, "").trim();
  const variants = Array.from(new Set([field, fieldLabel].filter(Boolean)));

  for (const variant of variants) {
    const re = new RegExp(`^${escapeRegExp(variant)}\\s*[:\\-]?\\s*(.+)$`, "i");
    const match = parts.map((part) => part.match(re)?.[1]?.trim() || "").find(Boolean);
    if (match && isUsefulValue(match)) return match;
  }

  const key = normalizeKey(field);
  if (key.includes("mileage") || key.includes("odometer")) {
    const match =
      text.match(/\bshowing\s+mileage\s*[:\-]?\s*([\d,]+(?:\.\d+)?)\s*(km|kilometers?|mi|miles?)\b/i) ||
      text.match(/\bmileage\s*[:\-]?\s*([\d,]+(?:\.\d+)?)\s*(km|kilometers?|mi|miles?)\b/i) ||
      text.match(/\bodometer\s*[:\-]?\s*([\d,]+(?:\.\d+)?)\s*(km|kilometers?|mi|miles?)\b/i) ||
      text.match(/\b([\d,]+(?:\.\d+)?)\s*(km|kilometers?|mi|miles?)\s*(?:showing|on\s+odometer)\b/i);
    return match ? `${match[1]} ${match[2]}` : "";
  }
  if (key.includes("hours")) {
    const match =
      text.match(/\bhours?\s*(?:showing|showing\s+unverified)?\s*[:\-]?\s*([\d,]+(?:\.\d+)?)\b/i) ||
      text.match(/\b([\d,]+(?:\.\d+)?)\s*hours?\b/i);
    return match?.[1] || "";
  }
  if (key.includes("transmission")) {
    if (/\bautomatic\b/i.test(text)) return "Automatic";
    if (/\bmanual\b/i.test(text)) return "Manual";
    if (/\bcvt\b/i.test(text)) return "CVT";
  }
  if (key.includes("drivetype") || key === "drive") {
    const match = text.match(/\b(4x4|4wd|awd|fwd|rwd|4-wheel drive|all wheel drive|front wheel drive|rear wheel drive)\b/i);
    return match ? match[1].toUpperCase() : "";
  }
  if (key.includes("fueltype") || key === "fuel") {
    const match = text.match(/\b(diesel|gasoline|gas|petrol|electric|hybrid|propane|natural gas)\b/i);
    if (!match) return "";
    return /^gas$/i.test(match[1]) ? "Gasoline" : match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
  }
  if (key.includes("colour") || key.includes("color")) {
    const match =
      text.match(/\bcolou?r\s*[:\-]?\s*([A-Za-z][A-Za-z /-]{2,24})\b/i) ||
      text.match(/\b(black|white|silver|grey|gray|red|blue|green|yellow|orange|brown|beige|tan|gold|purple|maroon)\b/i);
    return match?.[1] ? match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase() : "";
  }
  if (key.includes("doorcount") || key === "doors") {
    return text.match(/\bdoor\s+count\s*[:\-]?\s*(\d+)\b/i)?.[1] || text.match(/\b(\d+)\s*[- ]?\s*door\b/i)?.[1] || "";
  }
  if (key.includes("enginedisplacement")) {
    return text.match(/\b(\d+(?:\.\d+)?\s*l)\b/i)?.[1]?.toUpperCase() || "";
  }
  if (key === "engine" || key.includes("enginemodel")) {
    return text.match(/\b(\d+(?:\.\d+)?\s*l(?:\s+turbo)?[^,;\n]*)\b/i)?.[1]?.trim() || "";
  }
  return "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deriveSerial(lot: any, specs: SpecRecord): string {
  const direct = [
    lot?.serial_number,
    lot?.serial_no_or_label,
    lot?.sn_vin,
    lot?.vin,
    getSpecValue(specs, "Serial Number"),
    getSpecValue(specs, "VIN"),
    getSpecValue(specs, "SN"),
  ].find(isUsefulValue);
  if (direct) return cleanText(direct);

  const text = [lot?.title, lot?.description, lot?.details].filter(Boolean).join(" ");
  const vin = extractVinFromText(text);
  if (vin) return `VIN: ${vin}`;
  const serial = text.match(/\b(?:serial(?:\s*(?:number|no\.?|#))?|s\/n|sn)(?:\s*[:#-]\s*|\s+)([A-Z0-9*.-]{4,32})\b/i)?.[1];
  return serial ? `SN: ${serial}` : "";
}

function selectionValue(lot: any, key: "condition" | "completeness" | "legal"): string {
  const value = cleanText(lot?.condition_report_selections?.[key]);
  return /^n\/?a$/i.test(value) ? "" : value;
}

function isDamageField(field: string): boolean {
  const key = normalizeKey(field);
  return key === "damage" || key === "damages" || key === "damageanalysis";
}

function isStandaloneValue(field: string, value: string): boolean {
  const normalizedValue = normalizeKey(value);
  return (
    normalizedValue === "yes" ||
    normalizedValue === "true" ||
    normalizedValue === "present" ||
    normalizedValue === "included" ||
    normalizedValue === normalizeKey(field)
  );
}

function buildFieldRows(lot: any): Array<{ field: string; value: string; checked: boolean }> {
  return buildAuctioneerSpecRows(lot, {
    conditionText: [lot?.description, lot?.details].filter(Boolean).join(", "),
    category: lot?.categories,
    includeMissing: false,
  }).filter((row) => !!cleanText(row.value) && shouldDisplayAuctioneerSpecRow(row));
}

function resolveLotNumber(lot: any, index: number): string {
  return cleanText(lot?.lot_number || lot?.lot_id || lot?.lot || lot?.id) || String(index + 1);
}

function resolveMainImage(reportData: any, lot: any): string {
  const direct = Array.isArray(lot?.image_urls) ? lot.image_urls[0] : lot?.image_url;
  if (direct) return cleanText(direct);
  const imageUrls = Array.isArray(reportData?.imageUrls) ? reportData.imageUrls : [];
  const index = Array.isArray(lot?.image_indexes) ? Number(lot.image_indexes[0]) : NaN;
  return Number.isFinite(index) && imageUrls[index] ? imageUrls[index] : "";
}

function resolveLotImages(reportData: any, lot: any): string[] {
  const imageUrls = Array.isArray(reportData?.imageUrls) ? reportData.imageUrls : [];
  const indexes = [
    ...(Array.isArray(lot?.image_indexes) ? lot.image_indexes : []),
    ...(Array.isArray(lot?.extra_image_indexes) ? lot.extra_image_indexes : []),
  ];
  const fromIndexes = indexes
    .map((index) => {
      const numeric = Number(index);
      return Number.isInteger(numeric) && numeric >= 0 ? imageUrls[numeric] : "";
    })
    .filter(Boolean);
  const direct = [
    lot?.image_url,
    ...(Array.isArray(lot?.image_urls) ? lot.image_urls : []),
    ...(Array.isArray(lot?.extra_image_urls) ? lot.extra_image_urls : []),
  ].filter(Boolean);
  return Array.from(new Set([...direct, ...fromIndexes].map(cleanText).filter(Boolean)));
}

function hasBankPhotoPages(reportData: any, lot: any): boolean {
  return reportData?.bank_photos_enabled === true || lot?.bank_photos_enabled === true;
}

function resolveAllLotImages(reportData: any, lot: any): string[] {
  return Array.from(
    new Set([resolveMainImage(reportData, lot), ...resolveLotImages(reportData, lot)].filter(Boolean))
  );
}

function splitColumns<T>(items: T[]): [T[], T[]] {
  const midpoint = Math.ceil(items.length / 2);
  return [items.slice(0, midpoint), items.slice(midpoint)];
}

async function loadLogoDataUrl(): Promise<string> {
  const candidates = [
    path.resolve(process.cwd(), "public/logoNobg.png"),
    path.resolve(process.cwd(), "public/logo.jpg"),
  ];
  for (const candidate of candidates) {
    try {
      const bytes = await fs.readFile(candidate);
      const mime = candidate.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
      return `data:${mime};base64,${bytes.toString("base64")}`;
    } catch {}
  }
  return "";
}

function buildLotSummaryPageHtml(
  reportData: any,
  lot: any,
  index: number,
  sourceImages: string[],
  logoUrl: string,
  imageDataUrls: ReadonlyMap<string, string>
): string {
  const lotNumber = resolveLotNumber(lot, index);
  const category = canonicalCategory(inferCategory(lot));
  const title = titleFromLot(lot, `Lot ${lotNumber}`);
  // The shared resolver also represents explicit blanks/deletions. Falling
  // back to old prose here would revive a deliberately cleared serial.
  const serial = stripRedundantSerialLabel("Serial Number", deriveAuctioneerSerial(lot));
  const rows = buildFieldRows(lot);
  const [leftRows, rightRows] = splitColumns(rows);
  const contractNo = cleanText(reportData?.contract_no || reportData?.contract_number);
  const customer = cleanText(reportData?.prepared_for || reportData?.client_name || reportData?.owner_name);
  const contractDate = asDate(reportData?.sales_date || reportData?.effective_date || reportData?.inspection_date);
  const salesperson = cleanText(lot?.lotted_by || reportData?.inspector_name || reportData?.appraiser);
  const description = resolveCrLotDescription(lot, title);
  const damageLines =
    !resolveDamageAnalysisEnabled(reportData?.include_damage_analysis, true) ||
    !isLotDamageAnalysisEligible(lotNumber)
      ? []
      : formatDamageAnalysisLines(lot?.damage_analysis).filter((line) => !isBoilerplateAuctionText(line));
  const crNotesHtml = buildCrDisclaimersHtmlForLot(reportData, lot, index);
  const allImages = sourceImages
    .map((url) => imageDataUrls.get(url) || "")
    .filter(Boolean);

  const renderSpecTable = (items: typeof rows) => `
    <table class="spec-table">
      <tbody>
        ${items
          .map((row) => `
            <tr>
              <th>${escapeHtml(row.field)}</th>
              <td>${escapeHtml(row.value || "")}</td>
            </tr>
          `)
          .join("")}
      </tbody>
    </table>
  `;

  const renderGallery = () => {
    if (allImages.length === 0) {
      return `<div class="photo-panel empty">No lot images available</div>`;
    }
    return `
      <div class="photo-panel">
        <figure class="hero-photo">
          <img src="${escapeHtml(allImages[0])}" alt="Lot ${escapeHtml(lotNumber)} primary image" />
        </figure>
        ${
          allImages.length > 1
            ? `<div class="thumb-grid">
                ${allImages
                  .slice(1, 5)
                  .map((url, imageIndex) => `
                    <figure>
                      <img src="${escapeHtml(url)}" alt="Lot ${escapeHtml(lotNumber)} image ${imageIndex + 2}" />
                    </figure>
                  `)
                  .join("")}
              </div>`
            : ""
        }
      </div>
    `;
  };

  return `
    <section class="lot-page">
      <header class="top">
        <div class="brand">
          ${logoUrl ? `<img src="${logoUrl}" alt="McDougall Auctioneers" />` : `<div class="logo-text">McDougall Auctioneers</div>`}
          <div class="lot-title">Lot # ${escapeHtml(lotNumber)}</div>
        </div>
        <div class="contact">
          <div>1-800-263-4193</div>
          <div>Remarketing@mcdauction.com</div>
          <div>www.McDougallAuction.com</div>
          ${salesperson ? `<strong>${escapeHtml(salesperson)}</strong>` : ""}
        </div>
      </header>

      <div class="overview">
        <table class="summary-table">
          <tbody>
            <tr><th>Contract</th><td>${escapeHtml(contractNo)}</td></tr>
            <tr><th>Contract Date</th><td>${escapeHtml(contractDate)}</td></tr>
            <tr><th>Customer</th><td>${escapeHtml(customer)}</td></tr>
            <tr><th>Category</th><td>${escapeHtml(category)}</td></tr>
            <tr><th>Serial Number</th><td>${escapeHtml(serial)}</td></tr>
            <tr class="description-row"><th>Description</th><td>${escapeHtml(description)}</td></tr>
          </tbody>
        </table>
        ${renderGallery()}
      </div>

      <div class="details">
        <div class="section-title">
          <h2>Category Details</h2>
          <span>${escapeHtml(category || "Auctioneer Import")}</span>
        </div>
        <div class="columns">
          ${renderSpecTable(leftRows)}
          ${renderSpecTable(rightRows)}
        </div>
      </div>

      ${
        damageLines.length > 0
          ? `<div class="damage"><b>${escapeHtml(DAMAGE_ANALYSIS_LABEL)}</b>${damageLines
              .map((line) => `<p>${escapeHtml(line)}</p>`)
              .join("")}</div>`
          : ""
      }
      ${
        crNotesHtml
          ? `<div class="cr-notes"><b>CR NOTES</b>${crNotesHtml}</div>`
          : ""
      }
    </section>
  `;
}

function buildBankPhotoPageHtml(
  lot: any,
  lotIndex: number,
  sourceImages: string[],
  firstPhotoIndex: number,
  totalPhotos: number,
  imageDataUrls: ReadonlyMap<string, string>
): string {
  const lotNumber = resolveLotNumber(lot, lotIndex);
  const title = titleFromLot(lot, `Lot ${lotNumber}`);
  const preparedImages = sourceImages.map((url, index) => ({
    url: imageDataUrls.get(url) || "",
    photoNumber: firstPhotoIndex + index + 1,
  }));
  const rangeStart = Math.min(totalPhotos, firstPhotoIndex + 1);
  const rangeEnd = Math.min(totalPhotos, firstPhotoIndex + sourceImages.length);

  return `
    <section class="bank-photo-page">
      <header class="bank-photo-header">
        <div>
          <h2>Lot # ${escapeHtml(lotNumber)} Photos</h2>
          <p>${escapeHtml(title)}</p>
        </div>
        <span>Photos ${rangeStart}-${rangeEnd} of ${totalPhotos}</span>
      </header>
      <div class="bank-photo-grid">
        ${preparedImages
          .map(
            (image) => `
              <figure class="bank-photo-card">
                ${
                  image.url
                    ? `<img src="${escapeHtml(image.url)}" alt="Lot ${escapeHtml(lotNumber)} bank photo ${image.photoNumber}" />`
                    : `<div class="bank-photo-unavailable">Photo unavailable</div>`
                }
                <figcaption>Photo ${image.photoNumber}</figcaption>
              </figure>
            `
          )
          .join("")}
      </div>
    </section>
  `;
}

function buildCrPdfRenderUnits(reportData: any, lots: any[]): CrPdfRenderUnit[] {
  const renderLots = lots.length > 0 ? lots : [{}];
  const units: CrPdfRenderUnit[] = [];

  renderLots.forEach((lot, lotIndex) => {
    // Keep the complete capture order for bank pages. Only the compact summary
    // grid promotes the final image (normally the serial/ID photo).
    const allImages = resolveAllLotImages(reportData, lot);
    const summaryImages = selectCrSummaryImages(allImages);
    units.push({
      imageUrls: summaryImages,
      buildHtml: (imageDataUrls, logoUrl) =>
        buildLotSummaryPageHtml(
          reportData,
          lot,
          lotIndex,
          summaryImages,
          logoUrl,
          imageDataUrls
        ),
    });

    if (!hasBankPhotoPages(reportData, lot)) return;
    for (let start = 0; start < allImages.length; start += BANK_PHOTOS_PER_PAGE) {
      const pageImages = allImages.slice(start, start + BANK_PHOTOS_PER_PAGE);
      units.push({
        imageUrls: pageImages,
        buildHtml: (imageDataUrls) =>
          buildBankPhotoPageHtml(
            lot,
            lotIndex,
            pageImages,
            start,
            allImages.length,
            imageDataUrls
          ),
      });
    }
  });

  return units;
}

function partitionCrPdfRenderUnits(units: CrPdfRenderUnit[]): CrPdfRenderUnit[][] {
  const maxImageOccurrences = Math.min(
    HARD_MAX_CHUNK_IMAGE_OCCURRENCES,
    getPositiveIntEnv(
      "REPORT_PDF_CHUNK_IMAGE_OCCURRENCES",
      DEFAULT_CHUNK_IMAGE_OCCURRENCES
    )
  );
  const maxUnits = Math.min(
    HARD_MAX_CHUNK_RENDER_UNITS,
    getPositiveIntEnv("REPORT_PDF_CHUNK_RENDER_UNITS", DEFAULT_CHUNK_RENDER_UNITS)
  );
  const chunks: CrPdfRenderUnit[][] = [];
  let current: CrPdfRenderUnit[] = [];
  let currentImages = 0;

  for (const unit of units) {
    const wouldOverflow =
      current.length > 0 &&
      (current.length >= maxUnits || currentImages + unit.imageUrls.length > maxImageOccurrences);
    if (wouldOverflow) {
      chunks.push(current);
      current = [];
      currentImages = 0;
    }
    current.push(unit);
    currentImages += unit.imageUrls.length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function countImageOccurrences(imageUrls: string[]): Map<string, number> {
  const occurrences = new Map<string, number>();
  for (const url of imageUrls) {
    occurrences.set(url, (occurrences.get(url) || 0) + 1);
  }
  return occurrences;
}

async function prepareChunkImages(
  units: CrPdfRenderUnit[],
  degraded = false
): Promise<Map<string, string>> {
  const imageUrls = units.flatMap((unit) => unit.imageUrls);
  return buildPdfImageDataUrlMap(imageUrls, {
    renderedImageCount: imageUrls.length,
    renderedOccurrencesByUrl: countImageOccurrences(imageUrls),
    ...(degraded
      ? {
          maxEdgePx: FALLBACK_CHUNK_MAX_EDGE_PX,
          jpegQuality: FALLBACK_CHUNK_JPEG_QUALITY,
        }
      : {}),
  });
}

function isRecoverableChunkError(error: unknown): boolean {
  if (error instanceof PdfImagePayloadBudgetError) return true;
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /target closed|session closed|protocol error|page crashed|browser.*disconnect|renderer.*crash/i.test(
    message
  );
}

async function addGlobalPdfFooters(document: PDFDocument): Promise<void> {
  const pages = document.getPages();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const fontSize = 8;
  const color = rgb(75 / 255, 85 / 255, 99 / 255);
  const leftText = "McDougall Auctioneers CR";

  pages.forEach((page, index) => {
    const rightText = `Page ${index + 1} of ${pages.length}`;
    page.drawText(leftText, {
      x: 28,
      y: 15,
      size: fontSize,
      font,
      color,
    });
    page.drawText(rightText, {
      x: page.getWidth() - 28 - font.widthOfTextAtSize(rightText, fontSize),
      y: 15,
      size: fontSize,
      font,
      color,
    });
  });
}

export async function generateAuctioneerSpecSheetPdfFromReport(reportData: any): Promise<Buffer> {
  const lots = Array.isArray(reportData?.lots) ? reportData.lots : [];
  const units = buildCrPdfRenderUnits(reportData, lots);
  const chunks = partitionCrPdfRenderUnits(units);
  const logoUrl = await loadLogoDataUrl();
  const mergedPdf = await PDFDocument.create();

  const buildHtml = (unitHtml: string) => `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          @page { size: Letter; margin: 9mm; }
          * { box-sizing: border-box; }
          body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: #172033; background: #fff; }
          .lot-page { min-height: 252mm; page-break-after: always; padding: 2mm 0 0; }
          .lot-page:last-child { page-break-after: auto; }
          .top { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; border-bottom: 3px solid #172033; padding-bottom: 10px; }
          .brand img { width: 250px; max-height: 78px; object-fit: contain; object-position: left center; display: block; }
          .logo-text { font-size: 28px; font-weight: 900; text-transform: uppercase; letter-spacing: .02em; }
          .lot-title { margin-top: 2px; font-size: 26px; font-weight: 900; color: #0f172a; }
          .contact { min-width: 220px; border: 1px solid #9ca3af; border-radius: 6px; overflow: hidden; font-size: 10.5px; line-height: 1.45; background: #fff; }
          .contact div, .contact strong { display: block; padding: 5px 9px; border-bottom: 1px solid #d1d5db; }
          .contact strong { border-bottom: 0; font-size: 16px; text-align: center; color: #0f172a; }
          .overview { margin-top: 12px; display: grid; grid-template-columns: minmax(0, 1fr) 220px; gap: 14px; align-items: stretch; }
          .summary-table, .spec-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
          .summary-table { border: 1px solid #d7dde8; border-radius: 8px; overflow: hidden; font-size: 11px; }
          .summary-table th { width: 112px; text-align: left; vertical-align: top; padding: 7px 9px; background: #f3f6fb; border-bottom: 1px solid #d7dde8; color: #25314a; font-weight: 800; }
          .summary-table td { padding: 7px 9px; border-bottom: 1px solid #e5e9f1; vertical-align: top; line-height: 1.28; }
          .summary-table tr:last-child th, .summary-table tr:last-child td { border-bottom: 0; }
          .summary-table .description-row td { min-height: 54px; white-space: pre-wrap; }
          .photo-panel { border: 1px solid #d7dde8; border-radius: 8px; padding: 7px; background: #f8fafc; display: flex; flex-direction: column; gap: 7px; min-height: 190px; }
          .photo-panel.empty { align-items: center; justify-content: center; color: #64748b; font-size: 11px; }
          figure { margin: 0; }
          .hero-photo { height: 146px; background: #fff; border: 1px solid #e5e7eb; border-radius: 6px; display: flex; align-items: center; justify-content: center; overflow: hidden; }
          .hero-photo img { width: 100%; height: 100%; object-fit: contain; display: block; }
          .thumb-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; }
          .thumb-grid figure { height: 50px; background: #fff; border: 1px solid #e5e7eb; border-radius: 5px; overflow: hidden; display: flex; align-items: center; justify-content: center; }
          .thumb-grid img { width: 100%; height: 100%; object-fit: cover; display: block; }
          .details { margin-top: 12px; border: 1px solid #d7dde8; border-radius: 8px; overflow: hidden; break-inside: avoid; }
          .section-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 10px; background: #172033; color: #fff; }
          .section-title h2 { margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
          .section-title span { font-size: 10px; opacity: .9; }
          .columns { display: grid; grid-template-columns: 1fr 1fr; gap: 0; align-items: start; }
          .spec-table { font-size: 9.6px; border-right: 1px solid #e5e9f1; }
          .spec-table:last-child { border-right: 0; }
          .spec-table tr { break-inside: avoid; }
          .spec-table th, .spec-table td { padding: 4px 6px; border-bottom: 1px solid #e7ebf2; vertical-align: top; line-height: 1.18; }
          .spec-table th { width: 48%; color: #1f2937; text-align: left; font-weight: 800; background: #fbfcfe; }
          .spec-table td { color: #111827; overflow-wrap: anywhere; }
          .box { width: 8px; height: 8px; border: 1px solid #172033; display: inline-block; margin-right: 4px; transform: translateY(1px); }
          .box.checked { background: #172033; box-shadow: inset 0 0 0 1.5px #fff; }
          .damage { margin-top: 10px; border: 1px solid #fecaca; border-radius: 8px; background: #fff7f7; padding: 8px 10px; font-size: 10.5px; break-inside: avoid; }
          .damage b { color: #991b1b; text-transform: uppercase; letter-spacing: .04em; }
          .damage p { margin: 5px 0 0; line-height: 1.35; color: #1f2937; }
          .cr-notes { margin-top: 10px; border: 1px solid #d7dde8; border-radius: 8px; background: #fff; padding: 8px 10px; font-size: 10.5px; break-inside: avoid; }
          .cr-notes > b { color: #172033; text-transform: uppercase; letter-spacing: .04em; }
          .cr-notes p { margin: 5px 0 0; line-height: 1.35; color: #1f2937; }
          .cr-notes ul, .cr-notes ol { margin: 5px 0 0 18px; padding: 0; }
          .cr-notes li { margin: 3px 0; line-height: 1.35; }
          .cr-notes hr { border: 0; border-top: 1px solid #cbd5e1; margin: 8px 0; }
          .bank-photo-page { min-height: 252mm; page-break-after: always; padding: 2mm 0 0; }
          .bank-photo-page:last-child { page-break-after: auto; }
          .bank-photo-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; border-bottom: 3px solid #172033; padding-bottom: 10px; margin-bottom: 12px; }
          .bank-photo-header h2 { margin: 0; font-size: 24px; color: #0f172a; }
          .bank-photo-header p { margin: 4px 0 0; font-size: 12px; color: #475569; }
          .bank-photo-header span { border: 1px solid #cbd5e1; border-radius: 999px; padding: 6px 10px; font-size: 11px; font-weight: 800; color: #334155; background: #f8fafc; white-space: nowrap; }
          .bank-photo-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
          .bank-photo-card { border: 1px solid #d7dde8; border-radius: 8px; padding: 8px; background: #f8fafc; break-inside: avoid; page-break-inside: avoid; }
          .bank-photo-card img { width: 100%; height: 225px; object-fit: contain; display: block; background: #fff; border: 1px solid #e5e7eb; border-radius: 6px; }
          .bank-photo-unavailable { width: 100%; height: 225px; display: flex; align-items: center; justify-content: center; border: 1px dashed #cbd5e1; border-radius: 6px; background: #fff; color: #64748b; font-size: 12px; }
          .bank-photo-card figcaption { margin-top: 6px; font-size: 10px; font-weight: 800; color: #475569; text-align: center; }
          @media print {
            .lot-page { page-break-after: always; }
            .lot-page:last-child { page-break-after: auto; }
          }
          @media screen and (max-width: 760px) {
            body { padding: 12px; }
            .lot-page { min-height: auto; }
            .top, .overview, .columns { grid-template-columns: 1fr; display: grid; }
            .contact { min-width: 0; width: 100%; }
            .brand img { width: 210px; }
            .photo-panel { min-height: 0; }
            .spec-table { border-right: 0; }
          }
        </style>
      </head>
      <body>${unitHtml}</body>
    </html>
  `;

  console.info(
    `[CR PDF] Rendering ${lots.length || 1} lot(s) as ${units.length} bounded page unit(s) ` +
      `across ${chunks.length} Chromium chunk(s)`
  );

  const renderChunkOnce = async (
    chunk: CrPdfRenderUnit[],
    chunkLabel: string,
    degraded: boolean
  ): Promise<Uint8Array> => {
    const imageDataUrls = await prepareChunkImages(chunk, degraded);
    const unitHtml = chunk.map((unit) => unit.buildHtml(imageDataUrls, logoUrl)).join("");
    const html = buildHtml(unitHtml);
    console.info(
      `[CR PDF] Rendering ${chunkLabel}${degraded ? " (degraded retry)" : ""}: ` +
        `${chunk.length} unit(s), ${imageDataUrls.size} image(s), HTML ` +
        `${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} MiB`
    );

    const browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      timeout: 120000,
    });
    let renderCompleted = false;
    browser.once("disconnected", () => {
      if (!renderCompleted) {
        console.error(`[CR PDF] Chromium disconnected while rendering ${chunkLabel}`);
      }
    });
    try {
      const page = await browser.newPage();
      page.on("error", (error) => {
        console.error(`[CR PDF] Page crashed while rendering ${chunkLabel}:`, error);
      });
      configurePuppeteerPageTimeouts(page);
      await page.setViewport({ width: 1100, height: 1400, deviceScaleFactor: 1 });
      await runPdfRenderStage(`${chunkLabel} loading HTML`, () =>
        page.setContent(html, {
          waitUntil: "domcontentloaded",
          timeout: PUPPETEER_NAVIGATION_TIMEOUT_MS,
        })
      );
      await runPdfRenderStage(`${chunkLabel} decoding images`, () =>
        page.evaluate(async () => {
          if (document.fonts?.ready) await document.fonts.ready;
          await Promise.all(
            Array.from(document.images).map(
              (image) =>
                image.complete ||
                new Promise<void>((resolve) => {
                  image.addEventListener("load", () => resolve(), { once: true });
                  image.addEventListener("error", () => resolve(), { once: true });
                })
            )
          );
        })
      );
      const chunkPdfBytes = await runPdfRenderStage(`${chunkLabel} printing PDF`, () =>
        page.pdf({
          timeout: PUPPETEER_NAVIGATION_TIMEOUT_MS,
          format: "Letter",
          printBackground: true,
          displayHeaderFooter: false,
          margin: { top: "8mm", right: "8mm", bottom: "14mm", left: "8mm" },
          preferCSSPageSize: true,
        })
      );
      renderCompleted = true;
      return chunkPdfBytes;
    } finally {
      await browser.close().catch((error) => {
        console.warn(`[CR PDF] Browser cleanup failed after ${chunkLabel}:`, error);
      });
    }
  };

  const renderChunkWithRecovery = async (
    chunk: CrPdfRenderUnit[],
    chunkLabel: string,
    degraded = false
  ): Promise<Uint8Array[]> => {
    try {
      return [await renderChunkOnce(chunk, chunkLabel, degraded)];
    } catch (error) {
      if (!isRecoverableChunkError(error)) throw error;
      if (chunk.length > 1) {
        const midpoint = Math.ceil(chunk.length / 2);
        console.warn(
          `[CR PDF] ${chunkLabel} exceeded its renderer budget; splitting ` +
            `${chunk.length} units into ${midpoint} and ${chunk.length - midpoint}`
        );
        return [
          ...(await renderChunkWithRecovery(chunk.slice(0, midpoint), `${chunkLabel}.1`)),
          ...(await renderChunkWithRecovery(chunk.slice(midpoint), `${chunkLabel}.2`)),
        ];
      }
      if (!degraded) {
        console.warn(
          `[CR PDF] ${chunkLabel} failed in Chromium; retrying its single unit at ` +
            `${FALLBACK_CHUNK_MAX_EDGE_PX}px / quality ${FALLBACK_CHUNK_JPEG_QUALITY}`
        );
        return [await renderChunkOnce(chunk, `${chunkLabel}.retry`, true)];
      }
      throw error;
    }
  };

  let renderedChunkCount = 0;
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    const chunkLabel = `chunk ${chunkIndex + 1}/${chunks.length}`;
    const renderedChunks = await renderChunkWithRecovery(chunk, chunkLabel);
    for (const chunkPdfBytes of renderedChunks) {
      const chunkPdf = await PDFDocument.load(chunkPdfBytes);
      const copiedPages = await mergedPdf.copyPages(chunkPdf, chunkPdf.getPageIndices());
      copiedPages.forEach((page) => mergedPdf.addPage(page));
      renderedChunkCount += 1;
    }
  }

  await addGlobalPdfFooters(mergedPdf);
  const mergedBytes = await mergedPdf.save({ useObjectStreams: true });
  console.info(
    `[CR PDF] Merged ${renderedChunkCount} rendered chunk(s) into ` +
      `${mergedPdf.getPageCount()} page(s); ` +
      `${(mergedBytes.length / 1024 / 1024).toFixed(1)} MiB`
  );
  return Buffer.from(
    mergedBytes.buffer,
    mergedBytes.byteOffset,
    mergedBytes.byteLength,
  );
}
