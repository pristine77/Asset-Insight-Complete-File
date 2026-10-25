import { createHash } from "crypto";
import path from "path";
import mongoose from "mongoose";
import AssetReport from "../models/asset.model.js";
import PdfReport from "../models/pdfReport.model.js";
import { buildReportArtifactFilenames, getReportLots } from "../utils/reportArtifactNames.js";

export const RELEASED_ARTIFACT_KINDS = [
  "cr-pdf",
  "cr-docx",
  "appraisal-docx",
  "excel",
  "images",
] as const;

export type ReleasedArtifactKind = (typeof RELEASED_ARTIFACT_KINDS)[number];

type ArtifactSource = {
  value: string;
  source: "current" | "legacy";
  legacyId?: string;
  isDirectory?: boolean;
};

export type ReleasedArtifactManifestItem = {
  kind: ReleasedArtifactKind;
  available: boolean;
  downloadUrl: string | null;
  filename: string;
  reasonCode: string | null;
  reason: string | null;
  recoverable: boolean;
};

export type QualitySeverity = "critical" | "warning" | "info";

export type ReleasedQualityFinding = {
  code: string;
  severity: QualitySeverity;
  title: string;
  message: string;
  lotId?: string;
  lotNumber?: string;
  field?: string;
  actionTarget?: "data" | "cr-notes" | "proposal-valuation" | "regenerate";
};

const clean = (value: unknown) => String(value ?? "").trim();

function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    const candidate = clean(value);
    if (candidate) return candidate;
  }
  return "";
}

export function parseMoney(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = clean(value).replace(/[^0-9.-]+/g, "");
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function getLotNumber(lot: any, index: number): string {
  return firstNonEmpty(
    lot?.lot_number,
    lot?.lotNumber,
    lot?.lot_no,
    lot?.lot_id,
    index + 1
  ).replace(/^lot\s*#?\s*/i, "");
}

export function getReleasedLotValues(lot: any) {
  return {
    flv: parseMoney(
      lot?.flv ?? lot?.forced_liquidation_value ?? lot?.forcedLiquidationValue
    ),
    olv: parseMoney(
      lot?.olv ?? lot?.orderly_liquidation_value ?? lot?.orderlyLiquidationValue
    ),
    fmv: parseMoney(
      lot?.fmv ??
        lot?.fair_market_value ??
        lot?.fairMarketValue ??
        lot?.estimated_value ??
        lot?.estimatedValue
    ),
  };
}

export function getReleasedLotImages(report: any, lot: any): string[] {
  const deleted = new Set<number>(
    Array.isArray(report?.preview_data?.deleted_image_indexes)
      ? report.preview_data.deleted_image_indexes.map(Number)
      : []
  );
  const reportImages = Array.isArray(report?.imageUrls) ? report.imageUrls : [];
  const values: string[] = [];
  const append = (value: unknown) => {
    const url = clean(value);
    if (url && !values.includes(url)) values.push(url);
  };

  if (Array.isArray(lot?.image_indexes)) {
    lot.image_indexes.forEach((index: unknown) => {
      const numeric = Number(index);
      if (!deleted.has(numeric)) append(reportImages[numeric]);
    });
  }
  if (Array.isArray(lot?.image_urls)) lot.image_urls.forEach(append);
  if (Array.isArray(lot?.extra_image_indexes)) {
    lot.extra_image_indexes.forEach((index: unknown) => {
      const numeric = Number(index);
      if (!deleted.has(numeric)) append(reportImages[numeric]);
    });
  }
  if (Array.isArray(lot?.extra_image_urls)) lot.extra_image_urls.forEach(append);
  append(lot?.image_url);
  return values;
}

function legacyKind(record: any): ReleasedArtifactKind | null {
  const fileType = clean(record?.fileType).toLowerCase();
  const name = clean(record?.filename).toLowerCase();
  if (fileType === "spec_pdf") return "cr-pdf";
  if (fileType === "xlsx" || /\.xlsx?$/.test(name)) return "excel";
  if (fileType === "images" || record?.imagesFolderPath) return "images";
  if (fileType === "docx" || /\.docx$/.test(name)) {
    return /(^|[-_\s])(cr|condition)([-_\s.]|$)/i.test(name)
      ? "cr-docx"
      : "appraisal-docx";
  }
  if (fileType === "pdf" && /(^|[-_\s])(cr|condition)([-_\s.]|$)/i.test(name)) {
    return "cr-pdf";
  }
  return null;
}

export async function loadLegacyArtifactMap(reportIds: string[]) {
  if (reportIds.length === 0) return new Map<string, any[]>();
  const objectIds = reportIds
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  if (objectIds.length === 0) return new Map<string, any[]>();
  // PdfReport's legacy interface uses Schema.Types.ObjectId, while runtime
  // queries correctly use Types.ObjectId. Keep the cast local to this bridge.
  const rows = await PdfReport.find({
    report: { $in: objectIds },
    reportModel: "AssetReport",
  } as any)
    .sort({ createdAt: -1 })
    .lean();
  const map = new Map<string, any[]>();
  rows.forEach((row: any) => {
    const key = String(row.report);
    const current = map.get(key) || [];
    current.push(row);
    map.set(key, current);
  });
  return map;
}

function currentArtifactValue(report: any, kind: ReleasedArtifactKind): string {
  const preview = report?.preview_files || {};
  const generated = report?.files || {};
  const candidates: Record<ReleasedArtifactKind, unknown[]> = {
    "cr-pdf": [preview.spec_pdf, generated.spec_pdf, preview.pdf, generated.pdf],
    "cr-docx": [preview.cr_docx, generated.cr_docx],
    "appraisal-docx": [preview.docx, generated.docx],
    excel: [preview.excel, generated.excel],
    images: [preview.images, generated.images],
  };
  return firstNonEmpty(...candidates[kind]);
}

export function resolveReleasedArtifactSource(
  report: any,
  legacyRows: any[],
  kind: ReleasedArtifactKind
): ArtifactSource | null {
  const current = currentArtifactValue(report, kind);
  if (current) return { value: current, source: "current" };

  const legacy = legacyRows.find((row) => legacyKind(row) === kind);
  if (!legacy) return null;
  const value = firstNonEmpty(legacy.filePath, legacy.imagesFolderPath);
  if (!value) return null;
  return {
    value,
    source: "legacy",
    legacyId: String(legacy._id),
    isDirectory: Boolean(legacy.imagesFolderPath && !legacy.filePath),
  };
}

function artifactFilename(report: any, kind: ReleasedArtifactKind): string {
  const names = buildReportArtifactFilenames({
    kind: "asset",
    contractNo: report?.contract_no || report?.preview_data?.contract_no,
    reportId: report?._id,
    lots: getReportLots(report),
  });
  if (kind === "cr-pdf") return names.crPdf;
  if (kind === "cr-docx") return names.crDocx;
  if (kind === "appraisal-docx") return names.docx;
  if (kind === "excel") return names.excel;
  return names.imagesZip;
}

export function buildReleasedArtifactManifest(report: any, legacyRows: any[]) {
  return Object.fromEntries(
    RELEASED_ARTIFACT_KINDS.map((kind) => {
      const source = resolveReleasedArtifactSource(report, legacyRows, kind);
      const filename = artifactFilename(report, kind);
      const recoverable = ["cr-pdf", "cr-docx", "excel"].includes(kind) &&
        getReportLots(report).length > 0;
      const item: ReleasedArtifactManifestItem = source
        ? {
            kind,
            available: true,
            downloadUrl: `/api/admin/released-appraisals/${String(
              report._id
            )}/artifacts/${kind}/download`,
            filename,
            reasonCode: null,
            reason: null,
            recoverable: false,
          }
        : {
            kind,
            available: false,
            downloadUrl: null,
            filename,
            reasonCode: recoverable ? "REGENERATION_AVAILABLE" : "NOT_GENERATED",
            reason: recoverable
              ? "This file is missing, but it can be restored by regenerating the report files."
              : "No current or legacy file is stored for this artifact.",
            recoverable,
          };
      return [kind, item];
    })
  ) as Record<ReleasedArtifactKind, ReleasedArtifactManifestItem>;
}

function missingText(value: unknown): boolean {
  return /^(|n\/?a|unknown|not found|none|no)$/i.test(clean(value));
}

function severityRank(value: QualitySeverity): number {
  return value === "critical" ? 3 : value === "warning" ? 2 : 1;
}

export function buildReleasedQuality(
  report: any,
  artifacts: Record<ReleasedArtifactKind, ReleasedArtifactManifestItem>
) {
  const lots = getReportLots(report);
  const findings: ReleasedQualityFinding[] = [];
  const add = (finding: ReleasedQualityFinding) => findings.push(finding);

  Object.values(artifacts).forEach((artifact) => {
    if (!artifact.available) {
      add({
        code: `MISSING_${artifact.kind.toUpperCase().replace(/-/g, "_")}`,
        severity: artifact.recoverable ? "warning" : "critical",
        title: `${artifact.filename} is unavailable`,
        message: artifact.reason || "The generated artifact is missing.",
        actionTarget: artifact.recoverable ? "regenerate" : "data",
      });
    }
  });

  const lotNumbers = new Map<string, Array<{ lot: any; index: number }>>();
  const serials = new Map<string, Array<{ lot: any; index: number }>>();
  let lotsWithImages = 0;
  const categoryValues = new Map<string, number[]>();

  lots.forEach((lot: any, index: number) => {
    const lotNumber = getLotNumber(lot, index);
    const lotId = firstNonEmpty(lot?.lot_id, index + 1);
    const serial = firstNonEmpty(
      lot?.serial_number,
      lot?.serial_no_or_label,
      lot?.condition_report_specs?.["Serial Number"],
      lot?.condition_report_specs?.VIN
    );
    const images = getReleasedLotImages(report, lot);
    if (images.length > 0) lotsWithImages += 1;
    const values = getReleasedLotValues(lot);

    if (missingText(lotNumber)) add({ code: "MISSING_LOT_NUMBER", severity: "critical", title: "Missing lot number", message: "Assign a lot number before the report is reused.", lotId, field: "lot_number", actionTarget: "data" });
    if (missingText(lot?.description)) add({ code: "MISSING_DESCRIPTION", severity: "warning", title: `Lot ${lotNumber || index + 1} has no description`, message: "Add a concise auction description.", lotId, lotNumber, field: "description", actionTarget: "data" });
    if (missingText(serial)) add({ code: "MISSING_SERIAL", severity: "info", title: `Lot ${lotNumber || index + 1} has no serial`, message: "Confirm whether a serial or VIN is available.", lotId, lotNumber, field: "serial_number", actionTarget: "data" });
    if (images.length === 0) add({ code: "MISSING_IMAGES", severity: "critical", title: `Lot ${lotNumber || index + 1} has no images`, message: "No lot images are attached to this released appraisal.", lotId, lotNumber, actionTarget: "data" });
    if (values.fmv == null || values.fmv <= 0) add({ code: "MISSING_FMV", severity: "critical", title: `Lot ${lotNumber || index + 1} has no FMV`, message: "Add a positive fair market value.", lotId, lotNumber, field: "fmv", actionTarget: "proposal-valuation" });
    if (values.flv != null && values.olv != null && values.flv > values.olv) add({ code: "INVALID_FLV_OLV", severity: "warning", title: `Lot ${lotNumber || index + 1} has FLV above OLV`, message: "Expected valuation order is FLV <= OLV <= FMV.", lotId, lotNumber, actionTarget: "proposal-valuation" });
    if (values.olv != null && values.fmv != null && values.olv > values.fmv) add({ code: "INVALID_OLV_FMV", severity: "warning", title: `Lot ${lotNumber || index + 1} has OLV above FMV`, message: "Expected valuation order is FLV <= OLV <= FMV.", lotId, lotNumber, actionTarget: "proposal-valuation" });

    const normalizedLot = lotNumber.toLowerCase();
    if (normalizedLot) lotNumbers.set(normalizedLot, [...(lotNumbers.get(normalizedLot) || []), { lot, index }]);
    const normalizedSerial = serial.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalizedSerial && !missingText(serial)) serials.set(normalizedSerial, [...(serials.get(normalizedSerial) || []), { lot, index }]);
    const category = firstNonEmpty(lot?.categories, lot?.category, "Uncategorized");
    if (values.fmv != null && values.fmv > 0) categoryValues.set(category, [...(categoryValues.get(category) || []), values.fmv]);
  });

  lotNumbers.forEach((entries, number) => {
    if (entries.length > 1) add({ code: "DUPLICATE_LOT_NUMBER", severity: "critical", title: `Duplicate lot number ${number}`, message: `${entries.length} lots use the same visible lot number.`, lotNumber: number, actionTarget: "data" });
  });
  serials.forEach((entries) => {
    if (entries.length > 1) add({ code: "DUPLICATE_SERIAL", severity: "warning", title: "Duplicate serial number", message: `${entries.length} lots share the same serial or VIN.`, actionTarget: "data" });
  });

  categoryValues.forEach((values, category) => {
    if (values.length < 4) return;
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 0;
    values.forEach((value) => {
      if (median > 0 && (value > median * 5 || value < median / 5)) add({ code: "CATEGORY_VALUE_OUTLIER", severity: "info", title: `${category} valuation outlier`, message: `A ${category} lot is materially outside the category median.`, actionTarget: "proposal-valuation" });
    });
  });

  const releasedAt = report?.released_at ? new Date(report.released_at) : null;
  const startedAt = report?.preview_submitted_at
    ? new Date(report.preview_submitted_at)
    : report?.createdAt
      ? new Date(report.createdAt)
      : null;
  const releaseTurnaroundMs = releasedAt && startedAt
    ? Math.max(0, releasedAt.getTime() - startedAt.getTime())
    : null;
  if (releaseTurnaroundMs != null && releaseTurnaroundMs > 7 * 24 * 60 * 60 * 1000) add({ code: "LONG_RELEASE_TURNAROUND", severity: "info", title: "Long release turnaround", message: "This appraisal took more than seven days from submission to release." });

  const counts = { critical: 0, warning: 0, info: 0 };
  findings.forEach((finding) => { counts[finding.severity] += 1; });
  const highestSeverity = findings
    .map((finding) => finding.severity)
    .sort((a, b) => severityRank(b) - severityRank(a))[0] || null;

  return {
    findings,
    summary: {
      issueCount: findings.length,
      counts,
      highestSeverity,
      imageCoveragePercent: lots.length ? Math.round((lotsWithImages / lots.length) * 100) : 0,
      lotsWithImages,
      totalLots: lots.length,
    },
    releaseTurnaroundMs,
  };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function buildReleasedInsights(report: any, quality: ReturnType<typeof buildReleasedQuality>) {
  const lots = getReportLots(report);
  const values = lots.map((lot: any, index: number) => ({
    lotId: firstNonEmpty(lot?.lot_id, index + 1),
    lotNumber: getLotNumber(lot, index),
    title: firstNonEmpty(lot?.title, lot?.description, `Lot ${index + 1}`),
    ...getReleasedLotValues(lot),
    imageCount: getReleasedLotImages(report, lot).length,
  }));
  const fmvValues = values.map((value) => value.fmv).filter((value): value is number => value != null && value > 0);
  const sum = (key: "flv" | "olv" | "fmv") => values.reduce((total, value) => total + (value[key] || 0), 0);
  return {
    currency: firstNonEmpty(report?.currency, "CAD"),
    totals: { flv: sum("flv"), olv: sum("olv"), fmv: sum("fmv") },
    medianFmv: median(fmvValues),
    highestValueLots: [...values].sort((a, b) => (b.fmv || 0) - (a.fmv || 0)).slice(0, 5),
    lotCount: lots.length,
    imageCount: values.reduce((total, value) => total + value.imageCount, 0),
    imageCoveragePercent: quality.summary.imageCoveragePercent,
    releaseTurnaroundMs: quality.releaseTurnaroundMs,
  };
}

export function buildReleasedAppraisalFingerprint(report: any, quality: unknown): string {
  const payload = {
    id: String(report?._id || ""),
    contract: report?.contract_no,
    currency: report?.currency,
    releasedAt: report?.released_at,
    files: report?.files,
    previewFiles: report?.preview_files,
    lots: getReportLots(report).map((lot: any, index: number) => ({
      lotId: lot?.lot_id,
      lotNumber: getLotNumber(lot, index),
      title: lot?.title,
      description: lot?.description,
      serial: lot?.serial_number || lot?.serial_no_or_label,
      category: lot?.categories || lot?.category,
      values: getReleasedLotValues(lot),
      imageCount: getReleasedLotImages(report, lot).length,
      specs: lot?.condition_report_specs,
      overrides: lot?.condition_report_specs_manual_overrides,
      damage: lot?.damage_analysis,
    })),
    quality,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function buildReleasedRow(report: any, legacyRows: any[]) {
  const artifacts = buildReleasedArtifactManifest(report, legacyRows);
  const quality = buildReleasedQuality(report, artifacts);
  const insights = buildReleasedInsights(report, quality);
  const lots = getReportLots(report);
  const user = report?.user || {};
  const lotThumbnails = lots.map((lot: any, index: number) => ({
    lotId: firstNonEmpty(lot?.lot_id, index + 1),
    lotNumber: getLotNumber(lot, index),
    title: firstNonEmpty(lot?.title, lot?.description, `Lot ${index + 1}`),
    imageUrl: getReleasedLotImages(report, lot)[0] || null,
  }));
  const lotNumbers = lotThumbnails.map((lot) => lot.lotNumber).filter(Boolean);
  const fmv = insights.totals.fmv || parseMoney(report?.total_value) || parseMoney(report?.total_appraised_value) || 0;
  return {
    id: String(report._id),
    reportType: "Asset",
    title: firstNonEmpty(report?.client_name, report?.prepared_for, report?.contract_no, "Asset appraisal"),
    contractNo: firstNonEmpty(report?.contract_no, report?.preview_data?.contract_no, "No contract"),
    currency: firstNonEmpty(report?.currency, "CAD"),
    lotCount: lots.length,
    lotNumberSummary: lotNumbers.length <= 3 ? lotNumbers.join(", ") : `${lotNumbers.slice(0, 2).join(", ")} +${lotNumbers.length - 2} more`,
    lotThumbnails,
    fmv,
    creator: {
      id: user?._id ? String(user._id) : String(report?.user || ""),
      name: firstNonEmpty(user?.username, user?.name, user?.email, "Unknown user"),
      email: firstNonEmpty(user?.email),
      avatarUrl: firstNonEmpty(user?.profilePictureUrl, user?.profile_picture_url) || null,
    },
    createdAt: report?.createdAt,
    releasedAt: report?.released_at,
    releaseTurnaroundMs: quality.releaseTurnaroundMs,
    archived: Boolean(report?.adminArchivedAt),
    artifacts,
    qualitySummary: quality.summary,
    qualityFindings: quality.findings,
    insights,
    fingerprint: buildReleasedAppraisalFingerprint(report, quality),
  };
}

export function getLegacyFilesystemCandidates(value: string): string[] {
  if (!value || /^https?:\/\//i.test(value)) return [];
  const normalized = value.replace(/^[/\\]+/, "");
  return [
    path.resolve(process.cwd(), value),
    path.resolve(process.cwd(), normalized),
    path.resolve(process.cwd(), "public", normalized),
    path.resolve(process.cwd(), "uploads", normalized),
  ];
}

export async function getReleasedAssetReport(reportId: string) {
  return AssetReport.findOne({
    _id: reportId,
    status: "approved",
    is_draft_preview: { $ne: true },
    $or: [{ release_status: "released" }, { released_at: { $ne: null } }],
  })
    .populate("user", "username name email profilePictureUrl profile_picture_url")
    .lean();
}
