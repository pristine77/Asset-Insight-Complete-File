import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import {
  AlignmentType,
  BorderStyle,
  HorizontalPositionRelativeFrom,
  ImageRun,
  LineRuleType,
  Paragraph,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  TextWrappingType,
  VerticalPositionRelativeFrom,
  WidthType,
  convertInchesToTwip,
} from "docx";
import { calculateAssetLotsTotalValue } from "../../../utils/assetTotalValue.js";
import { buildSignatureImageParagraph } from "./signature.js";
import { resolveAssetValuationCodes, resolveAssetValuationCode as resolveValuationCode, type AssetValuationCode } from "../../../utils/assetValuationSelection.js";
import { projectAssetAppraisalValues } from "../../assetAppraisalValueProjectionService.js";

/**
 * Resolves certificate data from current and legacy report shapes, then overlays
 * it on fixed branded artwork. Resolver precedence, valuation-method ordering,
 * line wrapping, and absolute spacing are part of the certificate contract and
 * must remain synchronized with the transmittal and appraisal overview.
 */
const CERTIFICATE_FONT = "Times New Roman";
const CERTIFICATE_COMPANY = "McDougall Auctioneers Ltd.";
const CERTIFICATE_BACKGROUND_FILENAME =
  "certificate-of-value-background.png";
const CERTIFICATE_TABLE_WIDTH = convertInchesToTwip(6);
export type CertificateSignatory = {
  name: string;
  role: string;
  company: string;
};

export type { AssetValuationCode } from "../../../utils/assetValuationSelection.js";

export type ResolvedAssetValuationMethod = {
  code: AssetValuationCode;
  label: string;
  definition: string;
  value?: number;
  formattedValue: string;
};

export type AssetCertificateData = {
  recipientName: string;
  recipientAddressLines: [string, string, string];
  forcedLiquidationValue?: number;
  orderlyLiquidationValue?: number;
  formattedForcedLiquidationValue: string;
  formattedOrderlyLiquidationValue: string;
  valuationMethods: ResolvedAssetValuationMethod[];
  primarySignatory: CertificateSignatory;
  secondarySignatory?: CertificateSignatory;
};

let certificateBackgroundPromise: Promise<Buffer> | null = null;

function parseNumericValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  const cleaned = String(value ?? "")
    .replace(/,/g, "")
    .replace(/[^0-9.-]+/g, "")
    .trim();
  if (!cleaned) return undefined;

  const parsed = Number.parseFloat(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstNumericValue(values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = parseNumericValue(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function resolveValuationMethodRecordValue(
  reportData: any,
  methodCode: AssetValuationCode
): number | undefined {
  const methods = Array.isArray(reportData?.valuation_data?.methods)
    ? reportData.valuation_data.methods
    : [];

  for (const method of methods) {
    const code = resolveValuationCode(
      method?.method || method?.code || method?.name || method?.fullName
    );
    if (code !== methodCode) continue;
    const parsed = firstNumericValue([
      method?.value,
      method?.amount,
      method?.estimated_value,
    ]);
    if (parsed !== undefined) return parsed;
  }

  return undefined;
}

function resolveValuationMethodValue(
  reportData: any,
  methodCode: "FLV" | "OLV"
): number | undefined {
  return resolveValuationMethodRecordValue(reportData, methodCode);
}

function resolveLotLiquidationValue(
  lot: any,
  methodCode: "FLV" | "OLV"
): number | undefined {
  // Explicit method values outrank derived ratios. For grouped lots, use the
  // greater of a lot-level total and summed item values to avoid double counting
  // while retaining the most complete reviewed valuation source.
  const ratio = methodCode === "FLV" ? 0.7 : 0.85;
  const explicitAliases =
    methodCode === "FLV"
      ? ["flv", "forced_liquidation_value"]
      : ["olv", "orderly_liquidation_value"];
  const explicitValue = (source: any) =>
    firstNumericValue(explicitAliases.map((key) => source?.[key]));
  const items = Array.isArray(lot?.items) ? lot.items : [];
  const lotExplicit = explicitValue(lot);
  let itemTotal = 0;
  let hasItemValue = false;

  for (const item of items) {
    const itemExplicit = explicitValue(item);
    const itemEstimate = parseNumericValue(item?.estimated_value);
    const itemValue =
      itemExplicit ?? (itemEstimate === undefined ? undefined : itemEstimate * ratio);
    if (itemValue === undefined) continue;
    itemTotal += itemValue;
    hasItemValue = true;
  }

  if (lotExplicit !== undefined || hasItemValue) {
    return Math.max(lotExplicit ?? 0, hasItemValue ? itemTotal : 0);
  }

  const hasEstimatedValue =
    parseNumericValue(lot?.estimated_value) !== undefined ||
    items.some(
      (item: any) => parseNumericValue(item?.estimated_value) !== undefined
    );
  if (!hasEstimatedValue) return undefined;

  return calculateAssetLotsTotalValue([lot]) * ratio;
}

function deriveLiquidationValue(
  reportData: any,
  methodCode: "FLV" | "OLV"
): number | undefined {
  // Aggregate in source lot order and only fall back to a report-level FMV when
  // no lot can contribute a value. Mixing both levels would inflate totals.
  const lots = Array.isArray(reportData?.lots) ? reportData.lots : [];
  let total = 0;
  let found = false;

  for (const lot of lots) {
    const value = resolveLotLiquidationValue(lot, methodCode);
    if (value === undefined) continue;
    total += value;
    found = true;
  }
  if (found) return total;

  const reportTotal = firstNumericValue([
    reportData?.total_value,
    reportData?.total_appraised_value,
    reportData?.valuation_data?.baseFMV,
    reportData?.valuation_data?.base_fmv,
  ]);
  if (reportTotal === undefined) return undefined;
  return reportTotal * (methodCode === "FLV" ? 0.7 : 0.85);
}

function resolveForcedLiquidationValue(reportData: any): number | undefined {
  return (
    firstNumericValue([
      reportData?.total_forced_liquidation_value,
      reportData?.forced_liquidation_value,
      reportData?.flv,
      reportData?.analysis?.total_forced_liquidation_value,
      reportData?.analysis?.forced_liquidation_value,
      reportData?.valuation?.forced_liquidation_value,
      reportData?.preview_data?.total_forced_liquidation_value,
      reportData?.preview_data?.forced_liquidation_value,
    ]) ??
    resolveValuationMethodValue(reportData, "FLV") ??
    deriveLiquidationValue(reportData, "FLV")
  );
}

function resolveOrderlyLiquidationValue(reportData: any): number | undefined {
  return (
    firstNumericValue([
      reportData?.total_orderly_liquidation_value,
      reportData?.orderly_liquidation_value,
      reportData?.olv,
      reportData?.analysis?.total_orderly_liquidation_value,
      reportData?.analysis?.orderly_liquidation_value,
      reportData?.valuation?.orderly_liquidation_value,
      reportData?.preview_data?.total_orderly_liquidation_value,
      reportData?.preview_data?.orderly_liquidation_value,
    ]) ??
    resolveValuationMethodValue(reportData, "OLV") ??
    deriveLiquidationValue(reportData, "OLV")
  );
}

function formatCurrencyValue(
  value: number | undefined,
  currencyCode: string
): string {
  if (value === undefined) return "See Schedule A";

  try {
    return new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: currencyCode,
      currencyDisplay: "narrowSymbol",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `$${new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value)}`;
  }
}

function resolveFairMarketValue(reportData: any): number | undefined {
  const lots = Array.isArray(reportData?.lots) ? reportData.lots : [];
  return (
    firstNumericValue([
      reportData?.total_value,
      reportData?.total_appraised_value,
      reportData?.fair_market_value,
      reportData?.fmv,
      reportData?.valuation_data?.baseFMV,
      reportData?.valuation_data?.base_fmv,
      reportData?.preview_data?.total_value,
      reportData?.preview_data?.fair_market_value,
    ]) ??
    resolveValuationMethodRecordValue(reportData, "FMV") ??
    (lots.length > 0 ? calculateAssetLotsTotalValue(lots) : undefined)
  );
}

function resolveTradeInValue(reportData: any): number | undefined {
  return (
    firstNumericValue([
      reportData?.total_trade_in_value,
      reportData?.trade_in_value,
      reportData?.tkv,
      reportData?.valuation?.trade_in_value,
      reportData?.preview_data?.trade_in_value,
    ]) ?? resolveValuationMethodRecordValue(reportData, "TKV")
  );
}

function methodLabel(code: AssetValuationCode): string {
  return {
    FMV: "Fair Market Value",
    FLV: "Forced Liquidation Value",
    OLV: "Orderly Liquidation Value",
    TKV: "Trade-In Value",
  }[code];
}

function methodDefinition(code: AssetValuationCode, currencyCode: string): string {
  switch (code) {
    case "FMV":
      return `The estimated price, expressed in ${currencyCode}, at which the assets would change hands between a willing buyer and a willing seller, neither being under compulsion to transact and both having reasonable knowledge of the relevant facts.`;
    case "FLV":
      return `The estimated gross amount, expressed in ${currencyCode}, that could typically be realized from a properly advertised public sale when the seller is compelled to sell the assets on an as-is, where-is basis within a short period.`;
    case "OLV":
      return `The estimated gross amount, expressed in ${currencyCode}, that could typically be realized from a properly advertised and professionally managed sale of the assets on an as-is, where-is basis over a reasonable liquidation period.`;
    case "TKV":
      return `The estimated amount, expressed in ${currencyCode}, that a dealer or purchaser may allow for the assets as part of an exchange toward another asset, subject to market conditions and the terms of the transaction.`;
  }
}

/**
 * Resolve the selected valuation methods once so every appraisal section uses
 * the same labels, definitions, totals, and order. Legacy records without an
 * explicit selection retain the historical FLV/OLV behavior.
 */
export function resolveSelectedAssetValuationMethods(
  reportData: any
): ResolvedAssetValuationMethod[] {
  reportData = projectAssetAppraisalValues(reportData);
  const selectedCodes = resolveAssetValuationCodes(reportData, ["FLV", "OLV"]);

  const currencyCode = String(reportData?.currency || "CAD").toUpperCase();
  const valueResolvers: Record<
    AssetValuationCode,
    (data: any) => number | undefined
  > = {
    FMV: resolveFairMarketValue,
    FLV: resolveForcedLiquidationValue,
    OLV: resolveOrderlyLiquidationValue,
    TKV: resolveTradeInValue,
  };

  return selectedCodes.map((code) => {
    const value = valueResolvers[code](reportData);
    return {
      code,
      label: methodLabel(code),
      definition: methodDefinition(code, currencyCode),
      value,
      formattedValue: formatCurrencyValue(value, currencyCode),
    };
  });
}

function normalizeText(value: unknown): string {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function wrapWords(value: string, maxLength: number): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxLength || !current) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  return lines;
}

function resolveAddressSource(reportData: any): string {
  const explicit = [
    reportData?.certificate_address,
    reportData?.owner_address,
    reportData?.client_address,
    reportData?.head_office_address,
    reportData?.company_address,
    reportData?.inspection_location,
    reportData?.location,
    reportData?.address,
    reportData?.preview_data?.certificate_address,
    reportData?.preview_data?.owner_address,
    reportData?.preview_data?.client_address,
    reportData?.preview_data?.inspection_location,
    reportData?.preview_data?.location,
  ]
    .map(normalizeText)
    .find(Boolean);
  if (explicit) return explicit;

  const lots = Array.isArray(reportData?.lots) ? reportData.lots : [];
  const locations = Array.from(
    new Set(
      lots
        .map((lot: any) =>
          normalizeText(
            lot?.location ||
              lot?.inspection_location ||
              lot?.address ||
              lot?.site_address
          )
        )
        .filter(Boolean)
    )
  );
  return locations.join("; ");
}

function wrapAddressLines(value: string): [string, string, string] {
  // The background has exactly three address baselines. Normalize common
  // Canadian address shapes, then fold overflow into the final line rather than
  // adding paragraphs that would shift every absolute layout anchor below it.
  const fallback = value || "Location not provided";
  let parts = fallback
    .split(/\r?\n+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 1 && parts[0].includes(",")) {
    parts = parts[0]
      .split(/\s*,\s*/)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  if (
    parts.length === 4 &&
    /^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i.test(parts[3])
  ) {
    parts = [`${parts[0]},`, `${parts[1]}, ${parts[2]}`, parts[3]];
  } else if (
    parts.length === 3 &&
    /^[A-Z]{2}$/i.test(parts[1]) &&
    /^[A-Z]\d[A-Z]\s?\d[A-Z]\d$/i.test(parts[2])
  ) {
    parts = [`${parts[0]}, ${parts[1]}`, parts[2]];
  } else if (parts.length === 3 && /^[A-Z]{2}$/i.test(parts[2])) {
    parts = [parts[0], `${parts[1]}, ${parts[2]}`];
  } else if (parts.length === 2 && /^[A-Z]{2}$/i.test(parts[1])) {
    parts = [`${parts[0]}, ${parts[1]}`];
  }

  const wrapped: string[] = [];
  for (const part of parts) {
    for (const line of wrapWords(part, 40)) {
      if (wrapped.length < 3) {
        wrapped.push(line);
      } else {
        wrapped[2] = `${wrapped[2]}, ${line}`;
      }
    }
  }

  while (wrapped.length < 3) wrapped.push("");
  return [wrapped[0], wrapped[1], wrapped[2]];
}

function signatoryFromValue(
  value: any,
  fallback: CertificateSignatory
): CertificateSignatory {
  if (typeof value === "string") {
    return { ...fallback, name: normalizeText(value) || fallback.name };
  }
  if (!value || typeof value !== "object") return fallback;
  return {
    name: normalizeText(value.name) || fallback.name,
    role: normalizeText(value.role || value.title) || fallback.role,
    company: normalizeText(value.company) || fallback.company,
  };
}

function resolveSignatories(reportData: any): {
  primary: CertificateSignatory;
  secondary?: CertificateSignatory;
} {
  const company =
    normalizeText(reportData?.appraisal_company) || CERTIFICATE_COMPANY;
  const primaryFallback: CertificateSignatory = {
    name:
      normalizeText(
        reportData?.appraiser ||
          reportData?.inspector_name ||
          reportData?.prepared_by ||
          reportData?.user_name
      ) || "Certified Appraiser",
    role:
      normalizeText(
        reportData?.appraiser_role ||
          reportData?.appraiser_title ||
          reportData?.inspector_role ||
          reportData?.prepared_by_role
      ) || "Certified Appraiser",
    company,
  };

  const signatories = Array.isArray(reportData?.certificate_signatories)
    ? reportData.certificate_signatories
    : [];

  const primary = signatoryFromValue(
    signatories[0] || {
      name:
        reportData?.certificate_primary_signatory ||
        reportData?.certificate_primary_name,
      role:
        reportData?.certificate_primary_role ||
        reportData?.certificate_primary_title,
      company: reportData?.certificate_primary_company,
    },
    primaryFallback
  );

  const secondarySource = signatories[1] ||
    (reportData?.certificate_secondary_signatory ||
    reportData?.certificate_secondary_name
      ? {
          name:
            reportData?.certificate_secondary_signatory ||
            reportData?.certificate_secondary_name,
          role:
            reportData?.certificate_secondary_role ||
            reportData?.certificate_secondary_title,
          company: reportData?.certificate_secondary_company,
        }
      : null);
  const secondary = secondarySource
    ? signatoryFromValue(secondarySource, {
        name: "",
        role: "Certified Appraiser",
        company,
      })
    : undefined;

  return {
    primary,
    secondary: secondary?.name ? secondary : undefined,
  };
}

export function resolveAssetCertificateData(
  reportData: any
): AssetCertificateData {
  // This object is the data/render merge boundary. All field fallbacks and
  // formatting are complete before the branded layout is constructed.
  const recipientName =
    normalizeText(
      reportData?.owner_name ||
        reportData?.client_name ||
        reportData?.prepared_for ||
        reportData?.company_name
    ) || "Asset owner not provided";
  const forcedLiquidationValue = resolveForcedLiquidationValue(reportData);
  const orderlyLiquidationValue =
    resolveOrderlyLiquidationValue(reportData);
  const currencyCode = String(reportData?.currency || "CAD").toUpperCase();
  const signatories = resolveSignatories(reportData);
  const valuationMethods = resolveSelectedAssetValuationMethods(reportData);

  return {
    recipientName,
    recipientAddressLines: wrapAddressLines(
      resolveAddressSource(reportData)
    ),
    forcedLiquidationValue,
    orderlyLiquidationValue,
    formattedForcedLiquidationValue: formatCurrencyValue(
      forcedLiquidationValue,
      currencyCode
    ),
    formattedOrderlyLiquidationValue: formatCurrencyValue(
      orderlyLiquidationValue,
      currencyCode
    ),
    valuationMethods,
    primarySignatory: signatories.primary,
    secondarySignatory: signatories.secondary,
  };
}

async function loadCertificateBackground(): Promise<Buffer> {
  // Cache the immutable artwork per process. Two paths support running from the
  // server package or repository root without making deployment cwd-sensitive.
  if (!certificateBackgroundPromise) {
    certificateBackgroundPromise = (async () => {
      const candidates = [
        path.resolve(process.cwd(), "public", CERTIFICATE_BACKGROUND_FILENAME),
        path.resolve(
          process.cwd(),
          "server",
          "public",
          CERTIFICATE_BACKGROUND_FILENAME
        ),
      ];

      for (const candidate of candidates) {
        try {
          return await fs.readFile(candidate);
        } catch {}
      }

      throw new Error(
        `Certificate background not found. Checked: ${candidates.join(", ")}`
      );
    })();
  }
  return certificateBackgroundPromise;
}

function certificateRun(
  text: string,
  options: {
    size: number;
    bold?: boolean;
    italics?: boolean;
    break?: number;
  }
): TextRun {
  return new TextRun({
    text,
    font: CERTIFICATE_FONT,
    size: options.size,
    bold: options.bold,
    italics: options.italics,
    break: options.break,
    color: "000000",
  });
}

function noBorders() {
  return {
    top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    insideHorizontal: {
      style: BorderStyle.NONE,
      size: 0,
      color: "FFFFFF",
    },
    insideVertical: {
      style: BorderStyle.NONE,
      size: 0,
      color: "FFFFFF",
    },
  };
}

function signatoryParagraph(
  text: string,
  options: { bold?: boolean } = {}
): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    spacing: {
      before: 0,
      after: 0,
      line: 270,
      lineRule: LineRuleType.EXACT,
    },
    children: [
      certificateRun(text, {
        size: 22,
        bold: options.bold,
      }),
    ],
  });
}

function buildSignatoryCell(
  signatory: CertificateSignatory,
  signatureParagraph: Paragraph | null,
  includeSignatureSpacer: boolean,
  width: number
): TableCell {
  const signatureSpacer = includeSignatureSpacer
    ? new Paragraph({
        spacing: {
          before: 0,
          after: 0,
          line: 660,
          lineRule: LineRuleType.EXACT,
        },
      })
    : null;

  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    borders: noBorders(),
    margins: { top: 0, bottom: 0, left: 360, right: 180 },
    children: [
      ...(signatureParagraph
        ? [signatureParagraph]
        : signatureSpacer
          ? [signatureSpacer]
          : []),
      signatoryParagraph(signatory.name, { bold: true }),
      signatoryParagraph(signatory.role),
      signatoryParagraph(signatory.company),
    ],
  });
}

function namesLikelyMatch(left: unknown, right: unknown): boolean {
  const normalizeName = (value: unknown) =>
    normalizeText(value)
      .toLowerCase()
      .replace(/\b(b\.?a\.?|cppa|cpa|asa|aac?i)\b/g, "")
      .replace(/[^a-z]+/g, " ")
      .trim();
  const a = normalizeName(left);
  const b = normalizeName(right);
  return Boolean(a && b && (a.includes(b) || b.includes(a)));
}

export async function buildCertificateOfAppraisal(
  reportData: any,
  _contentWidthTw: number,
  _reportDate: string,
  _options: { monochrome?: boolean; compact?: boolean } = {}
): Promise<Array<Paragraph | Table>> {
  // Layout below is calibrated against the background's pixel geometry. Keep
  // paragraph order and exact spacing stable unless the artwork changes too.
  const sourceBackground = await loadCertificateBackground();
  // The proposal notes require a monochrome appraisal body while preserving
  // the full-colour cover and corporate logos.
  const background = _options.monochrome
    ? await sharp(sourceBackground).grayscale().png().toBuffer()
    : sourceBackground;
  const data = resolveAssetCertificateData(reportData);
  const suppliedSignature = buildSignatureImageParagraph(reportData, {
    width: 165,
    height: 44,
    before: 0,
    after: 0,
    alignment: AlignmentType.LEFT,
  });
  const primarySignature =
    suppliedSignature &&
    namesLikelyMatch(
      reportData?.appraiser || reportData?.inspector_name,
      data.primarySignatory.name
    )
      ? suppliedSignature
      : null;

  // Floating the full-page art behind text lets selectable certificate content
  // occupy normal document flow while retaining a single branded backdrop.
  const backgroundParagraph = new Paragraph({
    spacing: {
      before: 0,
      after: 0,
      line: 20,
      lineRule: LineRuleType.EXACT,
    },
    children: [
      new ImageRun({
        data: background as any,
        transformation: {
          width: 814,
          height: 1061,
        },
        floating: {
          horizontalPosition: {
            relative: HorizontalPositionRelativeFrom.PAGE,
            offset: 0,
          },
          verticalPosition: {
            relative: VerticalPositionRelativeFrom.PAGE,
            offset: 0,
          },
          behindDocument: true,
          allowOverlap: true,
          layoutInCell: true,
          wrap: {
            type: TextWrappingType.NONE,
          },
          margins: {
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
          },
        },
      } as any),
    ],
  });

  const proofParagraph = new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: {
      before: 3580,
      after: 672,
      line: 240,
      lineRule: LineRuleType.EXACT,
    },
    children: [
      certificateRun(
        "Proof of certification that on this given date,",
        { size: 22 }
      ),
      certificateRun("the specified assets belonging to:", {
        size: 22,
        break: 1,
      }),
    ],
  });

  const [addressLine1, addressLine2, addressLine3] =
    data.recipientAddressLines;
  const recipientNameSize =
    // Reduce type only at known thresholds so long user-entered identities fit
    // their artwork region without affecting subsequent vertical anchors.
    data.recipientName.length > 90
      ? 16
      : data.recipientName.length > 70
        ? 18
        : data.recipientName.length > 52
          ? 20
          : data.recipientName.length > 40
            ? 24
            : 28;
  const longestAddressLine = Math.max(
    addressLine1.length,
    addressLine2.length,
    addressLine3.length
  );
  const recipientAddressSize =
    longestAddressLine > 80
      ? 16
      : longestAddressLine > 64
        ? 18
        : longestAddressLine > 48
          ? 22
          : 28;
  const recipientParagraph = new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: {
      before: 0,
      after: 1886,
      line: 344,
      lineRule: LineRuleType.EXACT,
    },
    children: [
      certificateRun(data.recipientName, {
        size: recipientNameSize,
        bold: true,
      }),
      certificateRun(addressLine1, {
        size: recipientAddressSize,
        break: 1,
      }),
      certificateRun(addressLine2, {
        size: recipientAddressSize,
        break: 1,
      }),
      certificateRun(addressLine3, {
        size: recipientAddressSize,
        break: 1,
      }),
    ],
  });

  const inspectionText = data.valuationMethods.length
    ? [
        certificateRun("Were personally inspected in order to determine", {
          size: 22,
        }),
        certificateRun("a ", { size: 22, break: 1 }),
        certificateRun(
          data.valuationMethods.map((method) => method.label).join(" & "),
          { size: 22, bold: true }
        ),
        certificateRun(" of:", { size: 22 }),
      ]
    : [certificateRun("Were personally inspected.", { size: 22 })];
  const inspectionParagraph = new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: {
      before: 0,
      after: 420,
      line: 270,
      lineRule: LineRuleType.EXACT,
    },
    children: inspectionText,
  });

  const totalRuns = data.valuationMethods.map(
    (method, index) =>
      certificateRun(`Total ${method.label}: ${method.formattedValue}`, {
        size: 27,
        bold: true,
        break: index === 0 ? undefined : 1,
      })
  );
  const totalsParagraph = new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: {
      before: 0,
      after: primarySignature ? 280 : 460,
      line: 344,
      lineRule: LineRuleType.EXACT,
    },
    children: totalRuns,
  });

  const hasSecondary = Boolean(data.secondarySignatory);
  // The primary column owns the signature image; secondary width is the exact
  // remainder so the fixed table never exceeds its certificate content box.
  const primaryColumnWidth = hasSecondary
    ? Math.round(CERTIFICATE_TABLE_WIDTH * 0.57)
    : CERTIFICATE_TABLE_WIDTH;
  const secondaryColumnWidth = CERTIFICATE_TABLE_WIDTH - primaryColumnWidth;
  const signatoryTable = new Table({
    width: { size: CERTIFICATE_TABLE_WIDTH, type: WidthType.DXA },
    alignment: AlignmentType.CENTER,
    layout: TableLayoutType.FIXED,
    columnWidths: hasSecondary
      ? [primaryColumnWidth, secondaryColumnWidth]
      : [primaryColumnWidth],
    borders: noBorders(),
    rows: [
      new TableRow({
        children: [
          buildSignatoryCell(
            data.primarySignatory,
            primarySignature,
            Boolean(primarySignature),
            primaryColumnWidth
          ),
          ...(data.secondarySignatory
            ? [
                buildSignatoryCell(
                  data.secondarySignatory,
                  null,
                  Boolean(primarySignature),
                  secondaryColumnWidth
                ),
              ]
            : []),
        ],
      }),
    ],
  });

  const disclaimerParagraph = new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: {
      before: 220,
      after: 0,
      line: 200,
      lineRule: LineRuleType.EXACT,
    },
    children: [
      certificateRun(
        "THIS PAGE IS NOT AN APPRAISAL REPORT. THE APPRAISAL REPORT MUST BE READ IN ITS ENTIRETY.",
        { size: 16, italics: true }
      ),
    ],
  });

  // Returned order is the overlay stack as well as the vertical reading order.
  return [
    backgroundParagraph,
    proofParagraph,
    recipientParagraph,
    inspectionParagraph,
    totalsParagraph,
    signatoryTable,
    disclaimerParagraph,
  ];
}
