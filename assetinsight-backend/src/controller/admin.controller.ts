/**
 * Administrative HTTP facade for dashboards, identities and report governance.
 *
 * This controller joins several historical report models into stable admin response
 * shapes. Security-sensitive workflow transitions remain guarded by assignment,
 * artifact-readiness and release services rather than trusting request payload state.
 */
import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import User, { CRM_SPECIALIZATION_VALUES } from "../models/user.model.js";
import { assertReviewWorkflowAssignment } from "../service/reviewWorkflowAssignmentService.js";
import {
  validateAdminCredentials,
  listAdmins,
  createAdmin,
  deleteAdminById,
  setAdminBlocked,
  updateAdminPassword,
} from "../service/adminService.js";
import PdfReport from "../models/pdfReport.model.js";
import AssetReport from "../models/asset.model.js";
import RealEstateReport from "../models/realEstate.model.js";
import LotListing from "../models/lotListing.model.js";
import { sendEmail } from "../utils/sendVerificationEmail.js";
import { notifyUser } from "../service/notificationService.js";
import { cascadeDeleteSecurityRecords } from "../service/deviceAccessService.js";
import {
  DEFAULT_ASSET_AUTO_APPROVAL_THRESHOLD,
  getAssetAutoApprovalThreshold,
  isAuctioneerSpecWebSearchEnabled,
  setAssetAutoApprovalThreshold,
  setAuctioneerSpecWebSearchEnabled,
} from "../service/systemSettingsService.js";
import { countLotsWithCrDisclaimers } from "../utils/crDisclaimers.js";
import {
  getReportApproverOptions,
  normalizeReportApproverId,
} from "../service/approvalAssignmentService.js";
import {
  assertReportFilesReadyForWorkflow,
  assignReleaseManager,
  getReportDownloadAccess,
  getReportDownloadAccessForGeneration,
  getReleaseManagerOptions,
  normalizeReleaseManagerId,
  releaseReportGroupById,
  releaseStatusForPayload,
  sendAssignedReleaseEmail,
} from "../service/reportReleaseService.js";
import {
  getGlobalPreviewSupervisorSetting,
  PreviewSupervisorSettingError,
  setGlobalPreviewSupervisorSetting,
} from "../service/previewSupervisorService.js";
import { resolveReportGenerationStateForProfile } from "../utils/reportFileState.js";
import {
  buildReportArtifactFilenames,
  getReportContractNumber,
} from "../utils/reportArtifactNames.js";
import {
  getAdminPerformanceStats,
  getAdminPerformanceUserDetail,
  getAdminWorkflowQueueSnapshot,
  parseAdminPerformanceFilters,
} from "../service/adminPerformanceStatsService.js";
import { disconnectProposalValuationUser } from "../service/proposalValuationRealtimeService.js";

function buildCrCountReportData(record: any, previewData: any) {
  return {
    ...(record || {}),
    ...(previewData || {}),
    lots: Array.isArray(previewData?.lots)
      ? previewData.lots
      : Array.isArray(record?.lots)
        ? record.lots
        : [],
    cr_disclaimers: previewData?.cr_disclaimers,
    cr_disclaimers_by_lot: previewData?.cr_disclaimers_by_lot,
  };
}

const APPROVED_REPORT_STATUSES = ["approved", "completed"];
const REPORT_TYPE_KEYS = ["Asset", "RealEstate", "Salvage", "LotListing"] as const;
type DashboardReportType = (typeof REPORT_TYPE_KEYS)[number];

// Server-generated draft preview derivatives exist only to let owners/admins inspect
// an explicitly saved draft. They must never affect normal report lists or analytics.
const excludeDraftPreviewReports = <T extends Record<string, unknown>>(filter: T): T & {
  is_draft_preview: { $ne: true };
} => ({ ...filter, is_draft_preview: { $ne: true } });

function parseNumberLike(value: any): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return 0;
  const cleaned = value.replace(/[^0-9.-]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getReportLots(record: any): any[] {
  if (Array.isArray(record?.preview_data?.lots) && record.preview_data.lots.length) {
    return record.preview_data.lots;
  }
  if (Array.isArray(record?.lots)) return record.lots;
  return [];
}

function sumLotValues(lots: any[]): number {
  return lots.reduce((sum, lot) => sum + parseNumberLike(lot?.estimated_value ?? lot?.fmv ?? lot?.fair_market_value), 0);
}

function getReportLotValue(record: any, preferReportTotal = false): number {
  const reportTotal = parseNumberLike(record?.preview_data?.total_value ?? record?.total_value);
  if (preferReportTotal && reportTotal > 0) return reportTotal;
  const lotTotal = sumLotValues(getReportLots(record));
  return lotTotal > 0 ? lotTotal : reportTotal;
}

function getUserKey(value: any): string {
  const raw = value?._id ?? value;
  return raw ? String(raw) : "unknown";
}

function displayUserName(user: any, fallbackId: string): string {
  return user?.username || user?.email || user?.companyName || fallbackId;
}

const USER_ADMIN_SAFE_SELECT = [
  "email",
  "username",
  "companyName",
  "contactEmail",
  "contactPhone",
  "companyAddress",
  "crmAddress",
  "crmGeo",
  "crmQuadrant",
  "crmSpecializations",
  "role",
  "isBlocked",
  "isVerified",
  "isCrmAgent",
  "isReviewAccount",
  "proposalValuationEnabled",
  "crmAssignedAt",
  "crmAssignedBy",
  "reportApprover",
  "releaseManager",
  "msOutlookCalendarConnected",
  "msOutlookConnectedEmail",
  "msOutlookConnectedAt",
  "authProvider",
  "cvUrl",
  "cvFilename",
  "cvUploadedAt",
  "avatarUrl",
  "avatarUploadedAt",
  "createdAt",
  "updatedAt",
].join(" ");

// The Users table needs only assignment and status fields. Profile-only fields
// are loaded on demand by getAdminUserProfile to keep the list endpoint fast.
const USER_ADMIN_LIST_SELECT = [
  "email",
  "username",
  "companyName",
  "role",
  "isBlocked",
  "isCrmAgent",
  "proposalValuationEnabled",
  "reportApprover",
  "releaseManager",
  "avatarUrl",
  "avatarUploadedAt",
  "createdAt",
  "updatedAt",
].join(" ");

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function getLotNumber(lot: any, index: number): string {
  return cleanString(
    lot?.lot_number ??
      lot?.lotNumber ??
      lot?.lot_no ??
      lot?.lotNo ??
      lot?.lot_id ??
      lot?.lotId ??
      index + 1
  ).replace(/^lot\s*#?\s*/i, "") || String(index + 1);
}

function reportImageUrls(record: any): string[] {
  const values = [
    ...(Array.isArray(record?.preview_data?.image_urls) ? record.preview_data.image_urls : []),
    ...(Array.isArray(record?.preview_data?.imageUrls) ? record.preview_data.imageUrls : []),
    ...(Array.isArray(record?.imageUrls) ? record.imageUrls : []),
    ...(Array.isArray(record?.image_urls) ? record.image_urls : []),
  ];
  return values.map((value) => cleanString(value)).filter((value) => /^https?:\/\//i.test(value));
}

function firstImageForLot(lot: any, globalImages: string[] = []): string | null {
  const indexedCandidates = [
    ...(Array.isArray(lot?.image_indexes) ? lot.image_indexes : []),
    ...(Array.isArray(lot?.extra_image_indexes) ? lot.extra_image_indexes : []),
  ]
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0)
    .map((index) => globalImages[index])
    .filter(Boolean);
  const candidates: unknown[] = [
    lot?.image_url,
    ...(Array.isArray(lot?.image_urls) ? lot.image_urls : []),
    ...(Array.isArray(lot?.extra_image_urls) ? lot.extra_image_urls : []),
    ...(Array.isArray(lot?.images) ? lot.images : []),
    ...indexedCandidates,
  ];
  for (const candidate of candidates) {
    const value = typeof candidate === "string"
      ? candidate.trim()
      : cleanString((candidate as any)?.url ?? (candidate as any)?.uri);
    if (/^https?:\/\//i.test(value)) return value;
  }
  return null;
}

function buildLotThumbnails(lots: any[], globalImages: string[] = []) {
  return lots.flatMap((lot, index) => {
    const url = firstImageForLot(lot, globalImages);
    if (!url) return [];
    return [{
      lotNumber: getLotNumber(lot, index),
      title: cleanString(lot?.title ?? lot?.description) || `Lot ${index + 1}`,
      url,
    }];
  });
}

function getLotNumbers(lots: any[]): string[] {
  return lots.map(getLotNumber).filter(Boolean);
}

function buildLotNumberSummary(lots: any[]): string {
  const values = getLotNumbers(lots);
  if (values.length === 0) return "";
  const visible = values.length <= 2 ? values : [values[0], values[1], values[values.length - 1]];
  const suffix = values.length > visible.length ? ` +${values.length - visible.length} more` : "";
  return `${visible.map((value) => `Lot ${value}`).join(", ")}${suffix}`;
}

function buildDownloadFilenames(input: {
  reportType: string;
  contractNo: unknown;
  reportId: unknown;
  lots?: any[];
}) {
  if (!["Asset", "LotListing"].includes(input.reportType)) return undefined;
  const names = buildReportArtifactFilenames({
    kind: input.reportType === "LotListing" ? "lotListing" : "asset",
    contractNo: input.contractNo,
    reportId: input.reportId,
    fallback: input.reportId,
    lots: input.lots || [],
  });
  return {
    cr: names.crPdf,
    cr_docx: names.crDocx,
    docx: names.docx,
    excel: names.excel,
    images: names.imagesZip,
  };
}

async function findSafeAdminUserProfile(id: string) {
  return User.findById(id)
    .select(USER_ADMIN_SAFE_SELECT)
    .populate("reportApprover", "email username companyName role")
    .populate("releaseManager", "email username companyName role")
    .lean();
}

export const getMonthlyStats = async (_req: Request, res: Response) => {
  try {
    const now = new Date();
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1); // first day next month
    const start = new Date(end);
    start.setMonth(start.getMonth() - 12);

    const makeMonthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const months: string[] = [];
    const cursor = new Date(start);
    for (let i = 0; i < 12; i++) {
      months.push(makeMonthKey(cursor));
      cursor.setMonth(cursor.getMonth() + 1);
    }

    const monthlyGroup = [
      {
        $group: {
          _id: {
            m: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
          },
          c: { $sum: 1 },
        },
      },
    ];

    const [assetAgg, realEstateAgg, lotListingAgg, salvageAgg, usersAgg] = await Promise.all([
      AssetReport.aggregate([
        { $match: excludeDraftPreviewReports({ createdAt: { $gte: start, $lt: end }, status: { $in: APPROVED_REPORT_STATUSES } }) },
        ...monthlyGroup,
      ]),
      RealEstateReport.aggregate([
        { $match: { createdAt: { $gte: start, $lt: end }, status: { $in: APPROVED_REPORT_STATUSES } } },
        ...monthlyGroup,
      ]),
      LotListing.aggregate([
        { $match: excludeDraftPreviewReports({ createdAt: { $gte: start, $lt: end }, status: { $in: APPROVED_REPORT_STATUSES } }) },
        ...monthlyGroup,
      ]),
      (PdfReport as any).aggregate([
        { $match: { createdAt: { $gte: start, $lt: end }, reportType: "Salvage" } },
        { $project: { createdAt: 1, grp: { $ifNull: ["$report", "$_id"] } } },
        {
          $group: {
            _id: {
              m: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
              r: "$grp",
            },
          },
        },
        { $group: { _id: { m: "$_id.m" }, c: { $sum: 1 } } },
      ]),
      (User as any).aggregate([
        { $match: { createdAt: { $gte: start, $lt: end } } },
        {
          $group: {
            _id: { m: { $dateToString: { format: "%Y-%m", date: "$createdAt" } } },
            c: { $sum: 1 },
          },
        },
      ]),
    ]);

    const reportsByType: Record<DashboardReportType, number[]> = {
      Asset: Array(12).fill(0),
      RealEstate: Array(12).fill(0),
      Salvage: Array(12).fill(0),
      LotListing: Array(12).fill(0),
    };
    const reportTotals = Array(12).fill(0);

    const addMonthlyCounts = (type: DashboardReportType, rows: any[]) => {
      for (const r of rows) {
        const idx = months.indexOf(r._id?.m);
        if (idx < 0) continue;
        reportsByType[type][idx] += r.c;
        reportTotals[idx] += r.c;
      }
    };

    addMonthlyCounts("Asset", assetAgg);
    addMonthlyCounts("RealEstate", realEstateAgg);
    addMonthlyCounts("LotListing", lotListingAgg);
    addMonthlyCounts("Salvage", salvageAgg);

    const userTotals = Array(12).fill(0);
    for (const u of usersAgg) {
      const idx = months.indexOf(u._id?.m);
      if (idx >= 0) userTotals[idx] = u.c;
    }

    const lastIdx = months.length - 1;
    const prevIdx = months.length - 2;
    const reportsNow = reportTotals[lastIdx] || 0;
    const reportsPrev = reportTotals[prevIdx] || 0;
    const usersNow = userTotals[lastIdx] || 0;
    const usersPrev = userTotals[prevIdx] || 0;

    const pct = (a: number, b: number) => (b === 0 ? (a === 0 ? 0 : 100) : ((a - b) / b) * 100);

    return res.status(200).json({
      months,
      reports: {
        totals: reportTotals,
        byType: reportsByType,
      },
      users: {
        totals: userTotals,
      },
      deltas: {
        reports: { total: reportsNow, delta: reportsNow - reportsPrev, percent: pct(reportsNow, reportsPrev) },
        users: { total: usersNow, delta: usersNow - usersPrev, percent: pct(usersNow, usersPrev) },
      },
    });
  } catch (e) {
    console.error("getMonthlyStats error", e);
    return res.status(500).json({ message: "Failed to fetch monthly stats" });
  }
};

export const getDashboardAnalytics = async (_req: Request, res: Response) => {
  try {
    const userDocs = await User.find({})
      .select("username email companyName")
      .lean();
    const usersById = new Map(userDocs.map((user: any) => [String(user._id), user]));

    const makeReportBucket = (userId: string) => {
      const user = usersById.get(userId);
      return {
        userId,
        label: displayUserName(user, userId),
        email: user?.email || "",
        total: 0,
        Asset: 0,
        LotListing: 0,
        RealEstate: 0,
        Salvage: 0,
      };
    };

    const reportsByUser = new Map<string, ReturnType<typeof makeReportBucket>>();
    const lotStatsByUser = new Map<string, { userId: string; label: string; email: string; lotCount: number; lotValue: number }>();

    const ensureReportBucket = (userId: string) => {
      if (!reportsByUser.has(userId)) reportsByUser.set(userId, makeReportBucket(userId));
      return reportsByUser.get(userId)!;
    };

    const ensureLotBucket = (userId: string) => {
      if (!lotStatsByUser.has(userId)) {
        const user = usersById.get(userId);
        lotStatsByUser.set(userId, {
          userId,
          label: displayUserName(user, userId),
          email: user?.email || "",
          lotCount: 0,
          lotValue: 0,
        });
      }
      return lotStatsByUser.get(userId)!;
    };

    const addReportCount = (userId: string, type: DashboardReportType, count = 1) => {
      const bucket = ensureReportBucket(userId);
      bucket[type] += count;
      bucket.total += count;
    };

    const [assetReports, realEstateByUser, lotListings, salvageByUser] = await Promise.all([
      AssetReport.find(excludeDraftPreviewReports({ status: { $in: APPROVED_REPORT_STATUSES } }))
        .select("user lots preview_data total_value")
        .lean(),
      RealEstateReport.aggregate([
        { $match: { status: { $in: APPROVED_REPORT_STATUSES } } },
        { $group: { _id: "$user", count: { $sum: 1 } } },
      ]),
      LotListing.find(excludeDraftPreviewReports({ status: { $in: APPROVED_REPORT_STATUSES } }))
        .select("user lots preview_data total_value")
        .lean(),
      (PdfReport as any).aggregate([
        { $match: { reportType: "Salvage" } },
        { $project: { user: 1, grp: { $ifNull: ["$report", "$_id"] } } },
        { $group: { _id: { user: "$user", report: "$grp" } } },
        { $group: { _id: "$_id.user", count: { $sum: 1 } } },
      ]),
    ]);

    for (const report of assetReports as any[]) {
      const userId = getUserKey(report.user);
      addReportCount(userId, "Asset");
      const lots = getReportLots(report);
      const lotBucket = ensureLotBucket(userId);
      lotBucket.lotCount += lots.length;
      lotBucket.lotValue += getReportLotValue(report);
    }

    for (const row of realEstateByUser as any[]) {
      addReportCount(getUserKey(row._id), "RealEstate", row.count || 0);
    }

    for (const listing of lotListings as any[]) {
      const userId = getUserKey(listing.user);
      addReportCount(userId, "LotListing");
      const lots = getReportLots(listing);
      const lotBucket = ensureLotBucket(userId);
      lotBucket.lotCount += lots.length;
      lotBucket.lotValue += getReportLotValue(listing, true);
    }

    for (const row of salvageByUser as any[]) {
      addReportCount(getUserKey(row._id), "Salvage", row.count || 0);
    }

    return res.status(200).json({
      reportsByUser: Array.from(reportsByUser.values()).sort((a, b) => b.total - a.total),
      lotListingsByUser: Array.from(reportsByUser.values())
        .filter((item) => item.LotListing > 0)
        .map((item) => ({ userId: item.userId, label: item.label, email: item.email, count: item.LotListing }))
        .sort((a, b) => b.count - a.count),
      lotStatsByUser: Array.from(lotStatsByUser.values()).sort((a, b) => b.lotCount - a.lotCount),
    });
  } catch (e) {
    console.error("getDashboardAnalytics error", e);
    return res.status(500).json({ message: "Failed to fetch dashboard analytics" });
  }
};

function rangeDate(value: unknown, fallback: Date, endOfDay = false): Date {
  const parsed = value ? new Date(String(value)) : fallback;
  const date = Number.isNaN(parsed.getTime()) ? fallback : parsed;
  const result = new Date(date);
  if (endOfDay) result.setUTCHours(23, 59, 59, 999);
  else result.setUTCHours(0, 0, 0, 0);
  return result;
}

function percentChange(current: number, previous: number): number {
  if (previous <= 0) return current > 0 ? 100 : 0;
  return Number((((current - previous) / previous) * 100).toFixed(1));
}

function dateKey(value: Date | string): string {
  return new Date(value).toISOString().slice(0, 10);
}

export const getDesktopDashboardStats = async (req: Request, res: Response) => {
  try {
    const now = new Date();
    const defaultFrom = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
    const from = rangeDate(req.query.from, defaultFrom);
    const to = rangeDate(req.query.to, now, true);
    if (from > to) return res.status(400).json({ message: "From date must be before to date" });

    const spanMs = Math.max(to.getTime() - from.getTime() + 1, 24 * 60 * 60 * 1000);
    const previousTo = new Date(from.getTime() - 1);
    const previousFrom = new Date(previousTo.getTime() - spanMs + 1);
    const currentRange = { createdAt: { $gte: from, $lte: to } };
    const previousRange = { createdAt: { $gte: previousFrom, $lte: previousTo } };
    const currentAssetLikeRange = excludeDraftPreviewReports(currentRange);
    const previousAssetLikeRange = excludeDraftPreviewReports(previousRange);

    const countPdfGroups = async (filter: Record<string, unknown>) => {
      const rows = await (PdfReport as any).aggregate([
        { $match: filter },
        { $group: { _id: { $ifNull: ["$report", "$_id"] } } },
        { $count: "count" },
      ]);
      return Number(rows?.[0]?.count || 0);
    };

    const countAssetLikeLots = async (model: any, filter: Record<string, unknown>) => {
      const rows = await model.aggregate([
        { $match: filter },
        {
          $project: {
            lots: {
              $cond: [
                { $gt: [{ $size: { $ifNull: ["$preview_data.lots", []] } }, 0] },
                "$preview_data.lots",
                { $ifNull: ["$lots", []] },
              ],
            },
          },
        },
        { $group: { _id: null, total: { $sum: { $size: "$lots" } } } },
      ]);
      return Number(rows?.[0]?.total || 0);
    };

    const [
      assetCurrent,
      lotCurrent,
      realEstateCurrent,
      salvageCurrent,
      assetPrevious,
      lotPrevious,
      realEstatePrevious,
      salvagePrevious,
      totalUsers,
      pendingAsset,
      pendingLot,
      pendingRealEstate,
      pendingPdf,
      releasedAsset,
      releasedLot,
      releasedRealEstate,
      releasedPdf,
      assetDates,
      lotDates,
      realEstateDates,
      pdfDateGroups,
      recentAssets,
      recentLots,
      recentRealEstate,
      recentPdf,
      assetLotsCurrent,
      lotListingLotsCurrent,
      assetLotsPrevious,
      lotListingLotsPrevious,
      workflowQueue,
    ] = await Promise.all([
      AssetReport.countDocuments(currentAssetLikeRange),
      LotListing.countDocuments(currentAssetLikeRange),
      RealEstateReport.countDocuments(currentRange),
      countPdfGroups({ ...currentRange, reportType: "Salvage" }),
      AssetReport.countDocuments(previousAssetLikeRange),
      LotListing.countDocuments(previousAssetLikeRange),
      RealEstateReport.countDocuments(previousRange),
      countPdfGroups({ ...previousRange, reportType: "Salvage" }),
      User.countDocuments({ role: "user" }),
      AssetReport.countDocuments(excludeDraftPreviewReports({ status: "pending_approval" })),
      LotListing.countDocuments(excludeDraftPreviewReports({ status: "pending_approval" })),
      RealEstateReport.countDocuments({ status: "pending_approval" }),
      countPdfGroups({ approvalStatus: "pending", reportType: "Salvage" }),
      AssetReport.countDocuments(excludeDraftPreviewReports({ status: "approved" })),
      LotListing.countDocuments(excludeDraftPreviewReports({ status: "approved" })),
      RealEstateReport.countDocuments({ status: "approved" }),
      countPdfGroups({ approvalStatus: "approved", reportType: "Salvage" }),
      AssetReport.find(currentAssetLikeRange).select("createdAt").lean(),
      LotListing.find(currentAssetLikeRange).select("createdAt").lean(),
      RealEstateReport.find(currentRange).select("createdAt").lean(),
      (PdfReport as any).aggregate([
        // Asset and Real Estate are counted from their parents above, matching
        // the report KPI/type counts. Only Salvage uses grouped artifact rows.
        { $match: { ...currentRange, reportType: "Salvage" } },
        { $group: { _id: { $ifNull: ["$report", "$_id"] }, createdAt: { $min: "$createdAt" } } },
      ]),
      AssetReport.find(excludeDraftPreviewReports({ adminArchivedAt: null })).select("createdAt status release_status released_at preview_data contract_no user").populate("user", "email username companyName").sort({ createdAt: -1 }).limit(8).lean(),
      LotListing.find(excludeDraftPreviewReports({ adminArchivedAt: null })).select("createdAt status release_status released_at preview_data lots contract_no user").populate("user", "email username companyName").sort({ createdAt: -1 }).limit(8).lean(),
      RealEstateReport.find({ adminArchivedAt: null }).select("createdAt status release_status released_at preview_data property_details user").populate("user", "email username companyName").sort({ createdAt: -1 }).limit(8).lean(),
      PdfReport.find({ adminArchivedAt: null, reportType: "Salvage" }).select("createdAt approvalStatus release_status released_at reportType filename address contract_no user report").populate("user", "email username companyName").sort({ createdAt: -1 }).limit(12).lean(),
      countAssetLikeLots(AssetReport, currentAssetLikeRange),
      countAssetLikeLots(LotListing, currentAssetLikeRange),
      countAssetLikeLots(AssetReport, previousAssetLikeRange),
      countAssetLikeLots(LotListing, previousAssetLikeRange),
      getAdminWorkflowQueueSnapshot(),
    ]);

    const totalCurrent = assetCurrent + lotCurrent + realEstateCurrent + salvageCurrent;
    const totalPrevious = assetPrevious + lotPrevious + realEstatePrevious + salvagePrevious;
    const totalLotsCurrent = assetLotsCurrent + lotListingLotsCurrent;
    const totalLotsPrevious = assetLotsPrevious + lotListingLotsPrevious;
    const daily = new Map<string, number>();
    for (let cursor = new Date(from); cursor <= to; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      daily.set(dateKey(cursor), 0);
    }
    const addDates = (rows: any[]) => rows.forEach((row) => {
      const key = dateKey(row.createdAt);
      daily.set(key, (daily.get(key) || 0) + 1);
    });
    addDates(assetDates as any[]);
    addDates(lotDates as any[]);
    addDates(realEstateDates as any[]);
    addDates(pdfDateGroups as any[]);

    const recent = [
      ...(recentAssets as any[]).map((report) => {
        const lots = getReportLots(report);
        const thumbnails = buildLotThumbnails(lots, reportImageUrls(report));
        return {
          _id: String(report._id),
          title: cleanString(report.preview_data?.client_name ?? report.preview_data?.prepared_for) || "Asset Report",
          contractNo: getReportContractNumber(report, report._id),
          type: "Asset",
          lotCount: lots.length,
          lotNumberSummary: buildLotNumberSummary(lots),
          thumbnailUrl: thumbnails[0]?.url || null,
          owner: report.user,
          createdAt: report.createdAt,
          status: report.status,
          releaseStatus: releaseStatusForPayload(report),
        };
      }),
      ...(recentLots as any[]).map((report) => {
        const lots = getReportLots(report);
        const thumbnails = buildLotThumbnails(lots, reportImageUrls(report));
        return {
          _id: String(report._id),
          title: cleanString(lots[0]?.title) || "Lot Listing",
          contractNo: getReportContractNumber(report, report._id),
          type: "LotListing",
          lotCount: lots.length,
          lotNumberSummary: buildLotNumberSummary(lots),
          thumbnailUrl: thumbnails[0]?.url || null,
          owner: report.user,
          createdAt: report.createdAt,
          status: report.status,
          releaseStatus: releaseStatusForPayload(report),
        };
      }),
      ...(recentRealEstate as any[]).map((report) => ({
        _id: String(report._id),
        title: cleanString(report.preview_data?.property_details?.address ?? report.property_details?.address) || "Real Estate Report",
        type: "RealEstate",
        lotCount: 0,
        thumbnailUrl: null,
        owner: report.user,
        createdAt: report.createdAt,
        status: report.status,
        releaseStatus: releaseStatusForPayload(report),
      })),
      ...(recentPdf as any[]).map((report) => ({
        _id: String(report.report || report._id),
        title: report.address || report.filename || "Report",
        contractNo: report.contract_no,
        type: report.reportType || "Report",
        lotCount: 0,
        thumbnailUrl: null,
        owner: report.user,
        createdAt: report.createdAt,
        status: report.approvalStatus,
        releaseStatus: releaseStatusForPayload(report),
      })),
    ]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .filter((item, index, rows) => rows.findIndex((candidate) => candidate._id === item._id) === index)
      .slice(0, 8);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      range: { from: from.toISOString(), to: to.toISOString() },
      kpis: {
        reports: { value: totalCurrent, percent: percentChange(totalCurrent, totalPrevious) },
        lots: { value: totalLotsCurrent, percent: percentChange(totalLotsCurrent, totalLotsPrevious) },
        // Kept for older desktop builds; new clients use `lots` above.
        lotListings: { value: lotCurrent, percent: percentChange(lotCurrent, lotPrevious) },
        users: { value: totalUsers },
        pending: pendingAsset + pendingLot + pendingRealEstate + pendingPdf,
        released: releasedAsset + releasedLot + releasedRealEstate + releasedPdf,
      },
      activity: Array.from(daily.entries()).map(([date, value]) => ({ date, value })),
      byType: [
        { type: "Asset", value: assetCurrent },
        { type: "LotListing", value: lotCurrent },
        { type: "RealEstate", value: realEstateCurrent },
        { type: "Salvage", value: salvageCurrent },
      ],
      queue: {
        ...workflowQueue,
        // Compatibility aliases for older admin/desktop dashboard builds.
        pendingReview: workflowQueue.awaitingApproval,
        inReview: workflowQueue.preparingPreview + workflowQueue.generatingFiles,
        readyForRelease: workflowQueue.awaitingRelease,
      },
      recentReports: recent,
    });
  } catch (error) {
    console.error("getDesktopDashboardStats error", error);
    return res.status(500).json({ message: "Failed to load dashboard" });
  }
};

export const getPerformanceStats = async (req: Request, res: Response) => {
  try {
    const filters = parseAdminPerformanceFilters(req.query as Record<string, unknown>);
    const payload = await getAdminPerformanceStats(filters);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(payload);
  } catch (error: any) {
    console.error("getPerformanceStats error", error);
    const message = error?.message || "Failed to load employee statistics";
    return res.status(/invalid|before/i.test(message) ? 400 : 500).json({ message });
  }
};

export const getPerformanceUserStats = async (req: Request, res: Response) => {
  try {
    const filters = parseAdminPerformanceFilters(req.query as Record<string, unknown>);
    const payload = await getAdminPerformanceUserDetail(String(req.params.id || ""), filters);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(payload);
  } catch (error: any) {
    console.error("getPerformanceUserStats error", error);
    const message = error?.message || "Failed to load employee details";
    return res.status(/invalid|before|not found/i.test(message) ? 400 : 500).json({ message });
  }
};

export const getAdminStats = async (_req: Request, res: Response) => {
  try {
    const [
      totalUsers,
      totalAdmins,
      assetApprovedTotal,
      realEstateApprovedTotal,
      salvageReports,
      lotListingReports,
    ] = await Promise.all([
      User.countDocuments({}),
      User.countDocuments({ role: { $in: ["admin", "superadmin"] } }),
      AssetReport.countDocuments(excludeDraftPreviewReports({ status: { $in: APPROVED_REPORT_STATUSES } })),
      RealEstateReport.countDocuments({ status: { $in: APPROVED_REPORT_STATUSES } }),
      (PdfReport as any)
        .aggregate([
          { $match: { reportType: "Salvage" } },
          { $group: { _id: { $ifNull: ["$report", "$_id"] } } },
          { $count: "count" },
        ])
        .then((a: any[]) => (a?.[0]?.count || 0)),
      LotListing.countDocuments(excludeDraftPreviewReports({ status: { $in: APPROVED_REPORT_STATUSES } })),
    ]);

    const totalReports = assetApprovedTotal + realEstateApprovedTotal + salvageReports + lotListingReports;

    return res.status(200).json({
      totalUsers,
      totalAdmins,
      totalReports,
      byType: {
        Asset: assetApprovedTotal,
        RealEstate: realEstateApprovedTotal,
        Salvage: salvageReports,
        LotListing: lotListingReports,
      },
    });
  } catch (e) {
    console.error("getAdminStats error", e);
    return res.status(500).json({ message: "Failed to fetch stats" });
  }
};

export const getSpecWebSearchSetting = async (_req: Request, res: Response) => {
  try {
    const enabled = await isAuctioneerSpecWebSearchEnabled();
    return res.status(200).json({
      enabled,
      message: enabled
        ? "Auctioneer spec web search is enabled"
        : "Auctioneer spec web search is disabled",
    });
  } catch (e) {
    console.error("getSpecWebSearchSetting error", e);
    return res.status(500).json({ message: "Failed to load spec web search setting" });
  }
};

export const updateSpecWebSearchSetting = async (req: Request, res: Response) => {
  try {
    const enabled = req.body?.enabled === true;
    await setAuctioneerSpecWebSearchEnabled(enabled, (req as any).userId);
    return res.status(200).json({
      enabled,
      message: enabled
        ? "Auctioneer spec web search enabled"
        : "Auctioneer spec web search disabled",
    });
  } catch (e) {
    console.error("updateSpecWebSearchSetting error", e);
    return res.status(500).json({ message: "Failed to update spec web search setting" });
  }
};

function parseApprovalThresholdInput(value: unknown): number {
  const parsed = Number.parseFloat(
    String(value ?? "")
      .replace(/,/g, "")
      .replace(/[^0-9.-]+/g, "")
  );
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export const getAssetApprovalThresholdSetting = async (_req: Request, res: Response) => {
  try {
    const threshold = await getAssetAutoApprovalThreshold();
    return res.status(200).json({
      threshold,
      defaultThreshold: DEFAULT_ASSET_AUTO_APPROVAL_THRESHOLD,
      message: "Asset auto-approval threshold loaded",
    });
  } catch (e) {
    console.error("getAssetApprovalThresholdSetting error", e);
    return res.status(500).json({ message: "Failed to load asset approval threshold" });
  }
};

export const updateAssetApprovalThresholdSetting = async (req: Request, res: Response) => {
  try {
    const threshold = parseApprovalThresholdInput(req.body?.threshold ?? req.body?.value);
    if (!Number.isFinite(threshold) || threshold < 0) {
      return res.status(400).json({ message: "Threshold must be a non-negative number" });
    }
    if (threshold > 1000000000) {
      return res.status(400).json({ message: "Threshold is too high" });
    }

    const saved = await setAssetAutoApprovalThreshold(threshold, (req as any).userId);
    return res.status(200).json({
      ...saved,
      defaultThreshold: DEFAULT_ASSET_AUTO_APPROVAL_THRESHOLD,
      message: "Asset approval threshold updated",
    });
  } catch (e) {
    console.error("updateAssetApprovalThresholdSetting error", e);
    return res.status(500).json({ message: "Failed to update asset approval threshold" });
  }
};

// -------------------------
// Users (for admin/superadmin)
// -------------------------
export const getUsers = async (req: Request, res: Response) => {
  try {
    const { q, from, to, isBlocked, isCrmAgent } = req.query as Record<string, string | undefined>;
    const page = Math.max(parseInt((req.query.page as string) || "1", 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || "20", 10) || 20, 1), 100);

    const filter: any = { role: "user" };
    if (q) {
      const regex = new RegExp(q, "i");
      filter.$or = [{ email: regex }, { username: regex }, { companyName: regex }];
    }
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }
    if (typeof isBlocked !== "undefined") {
      if (isBlocked === "true" || isBlocked === "false") {
        filter.isBlocked = isBlocked === "true";
      }
    }
    if (typeof isCrmAgent !== "undefined") {
      if (isCrmAgent === "true" || isCrmAgent === "false") {
        filter.isCrmAgent = isCrmAgent === "true";
      }
    }

    // Fetch table rows, total, and the shared assignment choices together.
    // Returning choices in this response removes two extra desktop round trips.
    const [items, total, assignmentOptions] = await Promise.all([
      User.find(filter)
        .select(USER_ADMIN_LIST_SELECT)
        .populate("reportApprover", "email username companyName role")
        .populate("releaseManager", "email username companyName role")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
      User.find({ isBlocked: { $ne: true } })
        .select("_id email username companyName role")
        .sort({ role: 1, username: 1, email: 1 })
        .lean(),
    ]);

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ items, total, page, limit, assignmentOptions });
  } catch (e) {
    console.error("getUsers error", e);
    return res.status(500).json({ message: "Failed to fetch users" });
  }
};

export const getAdminUserProfile = async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid user id" });
    }
    const user = await findSafeAdminUserProfile(id);
    if (!user || user.role !== "user") {
      return res.status(404).json({ message: "User not found" });
    }
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ user });
  } catch (error) {
    console.error("getAdminUserProfile error", error);
    return res.status(500).json({ message: "Failed to load user profile" });
  }
};

export const updateAdminUserProfile = async (req: any, res: Response) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    const user = await User.findById(id).select(USER_ADMIN_SAFE_SELECT);
    if (!user || user.role !== "user") {
      return res.status(404).json({ message: "User not found" });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const editableStrings = [
      "username",
      "companyName",
      "contactEmail",
      "contactPhone",
      "companyAddress",
      "crmAddress",
      "crmQuadrant",
    ] as const;
    for (const field of editableStrings) {
      if (Object.prototype.hasOwnProperty.call(body, field)) {
        (user as any)[field] = cleanString(body[field]) || undefined;
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, "email")) {
      const email = cleanString(body.email).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ message: "Enter a valid email address" });
      }
      const duplicate = await User.exists({ _id: { $ne: user._id }, email });
      if (duplicate) {
        return res.status(409).json({ message: "A user with this email already exists" });
      }
      user.email = email;
    }

    if (Object.prototype.hasOwnProperty.call(body, "crmSpecializations")) {
      if (!Array.isArray(body.crmSpecializations)) {
        return res.status(400).json({ message: "CRM specializations must be a list" });
      }
      const allowed = new Set<string>(CRM_SPECIALIZATION_VALUES);
      const values = Array.from(new Set<string>(
        body.crmSpecializations
          .map((value: unknown) => cleanString(value))
          .filter((value: string) => Boolean(value))
      ));
      if (values.some((value) => !allowed.has(value))) {
        return res.status(400).json({ message: "One or more CRM specializations are invalid" });
      }
      (user as any).crmSpecializations = values;
    }

    if (Object.prototype.hasOwnProperty.call(body, "isCrmAgent")) {
      const next = body.isCrmAgent === true;
      if (next && !user.isCrmAgent) {
        (user as any).crmAssignedAt = new Date();
        (user as any).crmAssignedBy = req.userId || req.user?._id || null;
      }
      user.isCrmAgent = next;
    }

    const proposalValuationWasEnabled =
      (user as any).proposalValuationEnabled === true;
    if (Object.prototype.hasOwnProperty.call(body, "proposalValuationEnabled")) {
      if (user.isReviewAccount === true && body.proposalValuationEnabled === true) {
        return res.status(400).json({ message: "Review accounts cannot access production valuation collaboration." });
      }
      (user as any).proposalValuationEnabled = body.proposalValuationEnabled === true;
    }

    if (Object.prototype.hasOwnProperty.call(body, "reportApprover")) {
      const approverId = normalizeReportApproverId(body.reportApprover);
      if (body.reportApprover && !approverId) {
        return res.status(400).json({ message: "Invalid report approver" });
      }
      if (approverId) {
        await assertReviewWorkflowAssignment(user, approverId);
        const active = await User.exists({ _id: approverId, isBlocked: { $ne: true } });
        if (!active) return res.status(400).json({ message: "Selected approver is not active" });
      }
      (user as any).reportApprover = approverId;
    }

    if (Object.prototype.hasOwnProperty.call(body, "releaseManager")) {
      const managerId = normalizeReleaseManagerId(body.releaseManager);
      if (body.releaseManager && !managerId) {
        return res.status(400).json({ message: "Invalid release manager" });
      }
      if (managerId) {
        await assertReviewWorkflowAssignment(user, managerId);
        const active = await User.exists({ _id: managerId, isBlocked: { $ne: true } });
        if (!active) return res.status(400).json({ message: "Selected release manager is not active" });
      }
      (user as any).releaseManager = managerId;
    }

    await user.save();
    if (
      proposalValuationWasEnabled &&
      (user as any).proposalValuationEnabled !== true
    ) {
      disconnectProposalValuationUser(id, "account-capability-disabled");
    }
    const safe = await findSafeAdminUserProfile(id);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ user: safe });
  } catch (error: any) {
    console.error("updateAdminUserProfile error", error);
    return res.status(400).json({ message: error?.message || "Failed to update user profile" });
  }
};

export const getReportCreators = async (_req: Request, res: Response) => {
  try {
    const [assetIds, realEstateIds, lotListingIds, pdfIds] = await Promise.all([
      AssetReport.distinct("user"),
      RealEstateReport.distinct("user"),
      LotListing.distinct("user"),
      PdfReport.distinct("user"),
    ]);
    const ids = Array.from(new Set([...assetIds, ...realEstateIds, ...lotListingIds, ...pdfIds].map(String)))
      .filter((id) => mongoose.isValidObjectId(id));
    const users = await User.find({ _id: { $in: ids } })
      .select("email username companyName role isBlocked")
      .sort({ username: 1, email: 1 })
      .lean();
    const items = users.map((user: any) => ({
      _id: String(user._id),
      email: user.email,
      username: user.username,
      companyName: user.companyName,
      role: user.role,
      isBlocked: Boolean(user.isBlocked),
      label: user.username || user.companyName || user.email,
    }));
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ items });
  } catch (error) {
    console.error("getReportCreators error", error);
    return res.status(500).json({ message: "Failed to load report creators" });
  }
};

export const getReportApprovers = async (_req: Request, res: Response) => {
  try {
    const approvers = await getReportApproverOptions();
    return res.status(200).json({ approvers });
  } catch (e) {
    console.error("getReportApprovers error", e);
    return res.status(500).json({ message: "Failed to fetch report approvers" });
  }
};

export const updateUserReportApprover = async (req: Request, res: Response) => {
  try {
    const { id } = req.params as any;
    const { reportApprover } = req.body || {};
    const user = await User.findById(id).select("role reportApprover isReviewAccount");
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.role !== "user") {
      return res.status(403).json({ message: "Report approver can only be assigned to user accounts" });
    }

    const approverId = normalizeReportApproverId(reportApprover);
    if (reportApprover && !approverId) {
      return res.status(400).json({ message: "Invalid report approver" });
    }
    if (approverId) {
      await assertReviewWorkflowAssignment(user, approverId);
      const approver = await User.findOne({
        _id: approverId,
        isBlocked: { $ne: true },
      }).select("_id");
      if (!approver) {
        return res.status(400).json({ message: "Selected approver must be an active user" });
      }
    }

    (user as any).reportApprover = approverId;
    await user.save();

    const safe = await User.findById(id)
      .select(USER_ADMIN_SAFE_SELECT)
      .populate("reportApprover", "email username companyName role")
      .populate("releaseManager", "email username companyName role");
    return res.status(200).json({ user: safe });
  } catch (e) {
    const msg = (e as any)?.message || "Failed to update report approver";
    return res.status(400).json({ message: msg });
  }
};

export const getReleaseManagers = async (_req: Request, res: Response) => {
  try {
    const releaseManagers = await getReleaseManagerOptions();
    return res.status(200).json({ releaseManagers });
  } catch (e) {
    console.error("getReleaseManagers error", e);
    return res.status(500).json({ message: "Failed to fetch release managers" });
  }
};

export const updateUserReleaseManager = async (req: Request, res: Response) => {
  try {
    const { id } = req.params as any;
    const { releaseManager } = req.body || {};
    const user = await User.findById(id).select("role releaseManager isReviewAccount");
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.role !== "user") {
      return res.status(403).json({ message: "Release manager can only be assigned to user accounts" });
    }

    const managerId = normalizeReleaseManagerId(releaseManager);
    if (releaseManager && !managerId) {
      return res.status(400).json({ message: "Invalid release manager" });
    }
    if (managerId) {
      await assertReviewWorkflowAssignment(user, managerId);
      const manager = await User.findOne({
        _id: managerId,
        isBlocked: { $ne: true },
      }).select("_id");
      if (!manager) {
        return res.status(400).json({ message: "Selected release manager must be an active user" });
      }
    }

    (user as any).releaseManager = managerId;
    await user.save();

    const safe = await User.findById(id)
      .select(USER_ADMIN_SAFE_SELECT)
      .populate("reportApprover", "email username companyName role")
      .populate("releaseManager", "email username companyName role");
    return res.status(200).json({ user: safe });
  } catch (e) {
    const msg = (e as any)?.message || "Failed to update release manager";
    return res.status(400).json({ message: msg });
  }
};

export const getPreviewSupervisorSetting = async (_req: Request, res: Response) => {
  try {
    const setting = await getGlobalPreviewSupervisorSetting();
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(setting);
  } catch (error) {
    console.error("getPreviewSupervisorSetting error", error);
    return res.status(500).json({ message: "Failed to load preview supervisor" });
  }
};

export const updatePreviewSupervisorSetting = async (req: any, res: Response) => {
  try {
    const { previewSupervisor } = req.body || {};
    const setting = await setGlobalPreviewSupervisorSetting(
      previewSupervisor,
      req.userId || req.user?._id
    );
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(setting);
  } catch (error: any) {
    if (error instanceof PreviewSupervisorSettingError) {
      return res.status(400).json({ message: error.message });
    }
    console.error("updatePreviewSupervisorSetting error", error);
    return res.status(500).json({ message: "Failed to update preview supervisor" });
  }
};

export const releaseAdminReport = async (req: any, res: Response) => {
  try {
    const released = await releaseReportGroupById(req.params.id, req.user, { isAdmin: true });
    if (!released) return res.status(404).json({ message: "Report not found" });
    return res.status(200).json({
      message: "Report released successfully",
      data: released,
    });
  } catch (e: any) {
    const statusCode = Number(e?.statusCode || 500);
    if (statusCode === 403 || statusCode === 409) {
      return res.status(statusCode).json({
        ...(e?.code ? { code: e.code } : {}),
        message: e?.message || "Not authorized to release this report",
        ...(e?.downloadAccess ? { download_access: e.downloadAccess } : {}),
      });
    }
    console.error("releaseAdminReport error", e);
    return res.status(500).json({ message: e?.message || "Failed to release report" });
  }
};

export const blockUserByAdmin = async (req: Request, res: Response) => {
  try {
    const { id } = req.params as any;
    const { blocked } = req.body || {};
    if (typeof blocked !== "boolean") {
      return res.status(400).json({ message: "blocked must be boolean" });
    }
    const user = await User.findById(id).select("role isBlocked");
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.role !== "user") {
      return res.status(403).json({ message: "Cannot change block status for admin accounts here" });
    }
    user.isBlocked = blocked as any;
    await user.save();
    if (blocked) {
      disconnectProposalValuationUser(String(user._id), "account-blocked");
    }
    const safe = await User.findById(id)
      .select(USER_ADMIN_SAFE_SELECT)
      .populate("reportApprover", "email username companyName role")
      .populate("releaseManager", "email username companyName role");
    return res.status(200).json({ user: safe });
  } catch (e) {
    const msg = (e as any)?.message || "Failed to update block status";
    return res.status(400).json({ message: msg });
  }
};

export const deleteUserByAdmin = async (req: Request, res: Response) => {
  try {
    const { id } = req.params as any;
    const user = await User.findById(id).select("role");
    if (!user) return res.status(404).json({ message: "User not found" });
    if (user.role !== "user") {
      return res.status(403).json({ message: "Cannot delete admin accounts here" });
    }
    await cascadeDeleteSecurityRecords(String(id));
    await User.deleteOne({ _id: id });
    disconnectProposalValuationUser(String(id), "account-deleted");
    return res.status(204).send();
  } catch (e) {
    const msg = (e as any)?.message || "Failed to delete user";
    return res.status(400).json({ message: msg });
  }
};

export const adminLogin = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const user = await validateAdminCredentials(email, password);
    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const accessToken = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET!,
      {
        expiresIn: "30m",
      }
    );
    const refreshToken = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_REFRESH_SECRET!,
      {
        expiresIn: "7d",
      }
    );

    // Do not persist admin refresh tokens in DB for now (reuse user controller if needed)
    // Return sanitized user payload
    const safeUser = await User.findById(user._id).select(
      "-password -refreshTokens -refreshToken"
    );
    return res.status(200).json({ accessToken, refreshToken, user: safeUser });
  } catch (err) {
    return res.status(500).json({ message: "Failed to login" });
  }
};

export const refreshAdminToken = async (req: Request, res: Response) => {
  try {
    // Accept refresh token via header or body
    const headerToken = req.headers["x-refresh-token"] as string | undefined;
    const bodyToken = (req.body as any)?.refreshToken as string | undefined;
    const refreshToken = (headerToken || bodyToken || "").trim();
    if (!refreshToken) {
      return res.status(401).json({ message: "Missing refresh token" });
    }

    let decoded: any;
    try {
      decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET!);
    } catch {
      return res.status(401).json({ message: "Invalid refresh token" });
    }

    const user = await User.findById(decoded.id).select("-password");
    if (!user) return res.status(401).json({ message: "User not found" });
    if ((user as any).isBlocked)
      return res.status(403).json({ message: "Account is blocked" });
    if (user.role !== "admin" && user.role !== "superadmin")
      return res.status(403).json({ message: "Admin privileges required" });

    const accessToken = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET!,
      { expiresIn: "30m" }
    );

    return res.status(200).json({ accessToken });
  } catch (e) {
    return res.status(500).json({ message: "Failed to refresh token" });
  }
};

export const me = async (req: Request, res: Response) => {
  try {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer "))
      return res.status(401).json({ message: "No token" });
    const token = auth.split(" ")[1];
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET!);
    const user = await User.findById(decoded.id).select(
      "-password -refreshTokens -refreshToken"
    );
    if (!user) return res.status(401).json({ message: "Invalid token" });
    if ((user as any).isBlocked)
      return res.status(403).json({ message: "Account is blocked" });
    return res.status(200).json({ user });
  } catch (e) {
    return res.status(401).json({ message: "Invalid token" });
  }
};

export const getAdmins = async (_req: Request, res: Response) => {
  const admins = await listAdmins();
  return res.status(200).json({ admins });
};

export const postAdmin = async (req: Request, res: Response) => {
  try {
    const { email, username, password, companyName } = req.body || {};
    if (!email) return res.status(400).json({ message: "Email is required" });
    const user = await createAdmin({ email, username, password, companyName });
    const safe = await User.findById(user._id).select(
      "-password -refreshTokens -refreshToken"
    );
    return res.status(201).json({ user: safe });
  } catch (e: any) {
    return res
      .status(400)
      .json({ message: e?.message || "Failed to create admin" });
  }
};

export const deleteAdmin = async (req: Request, res: Response) => {
  try {
    const { id } = req.params as any;
    await deleteAdminById(id);
    return res.status(204).send();
  } catch (e: any) {
    const msg = e?.message || "Failed to delete admin";
    const code = msg.includes("superadmin") ? 403 : 400;
    return res.status(code).json({ message: msg });
  }
};

export const blockAdmin = async (req: Request, res: Response) => {
  try {
    const { id } = req.params as any;
    const { blocked } = req.body || {};
    if (typeof blocked !== "boolean") {
      return res.status(400).json({ message: "blocked must be boolean" });
    }
    const user = await setAdminBlocked(id, blocked);
    const safe = await User.findById(user._id).select(
      "-password -refreshTokens -refreshToken"
    );
    return res.status(200).json({ user: safe });
  } catch (e: any) {
    const msg = e?.message || "Failed to update block status";
    const code = msg.includes("superadmin") ? 403 : 400;
    return res.status(code).json({ message: msg });
  }
};

export const changeAdminPassword = async (req: Request, res: Response) => {
  try {
    const { id } = req.params as any;
    const { password } = req.body || {};
    if (typeof password !== "string") {
      return res.status(400).json({ message: "password is required" });
    }

    const user = await updateAdminPassword(id, password);
    const safe = await User.findById(user._id).select(
      "-password -refreshTokens -refreshToken"
    );
    return res.status(200).json({ user: safe });
  } catch (e: any) {
    const msg = e?.message || "Failed to update password";
    return res.status(400).json({ message: msg });
  }
};

function applyReportArchiveFilter(filter: Record<string, any>, archived: boolean) {
  filter.adminArchivedAt = archived
    ? { $exists: true, $ne: null }
    : null;
}

function applyReportReleaseFilter(filter: Record<string, any>, releaseStatus?: string) {
  const normalized = String(releaseStatus || "").trim().toLowerCase();
  if (!["released", "pending_release"].includes(normalized)) return;

  const clause =
    normalized === "released"
      ? {
          $or: [
            { release_status: "released" },
            { release_status: null },
            { release_status: { $exists: false } },
          ],
        }
      : { release_status: "pending_release" };

  filter.$and = Array.isArray(filter.$and) ? [...filter.$and, clause] : [clause];
}

export const getAdminReports = async (req: any, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    const { q, reportType, from, to, userEmail, approvalStatus, archived, releaseStatus, contractNo } = req.query as Record<
      string,
      string | undefined
    >;
    const page = Math.max(
      parseInt((req.query.page as string) || "1", 10) || 1,
      1
    );
    const limit = Math.min(
      Math.max(parseInt((req.query.limit as string) || "20", 10) || 20, 1),
      200
    );

    // Approved Reports stays available to regular admins, but non-approved
    // records belong to the superadmin-only Preview Reports experience.
    const userRole = req.user?.role;
    const isSuperAdmin = userRole === "superadmin";
    const normalizedApprovalStatus = String(approvalStatus || "").trim().toLowerCase();
    const hasExplicitApprovalStatus = ["pending", "approved", "rejected"].includes(normalizedApprovalStatus);
    if (
      !isSuperAdmin &&
      hasExplicitApprovalStatus &&
      normalizedApprovalStatus !== "approved"
    ) {
      return res.status(403).json({ message: "Superadmin privileges required" });
    }
    const effectiveApprovalStatus = isSuperAdmin
      ? normalizedApprovalStatus
      : "approved";
    const hasEffectiveApprovalStatus = !isSuperAdmin || hasExplicitApprovalStatus;
    const archivedView = ["true", "1", "yes"].includes(String(archived || "").trim().toLowerCase());
    const exactContract = String(contractNo || "").trim();
    const exactContractRegex = exactContract
      ? new RegExp(`^${exactContract.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i")
      : null;

    // Build filters for PdfReports
    const pdfFilter: any = {};
    applyReportArchiveFilter(pdfFilter, archivedView);
    if (hasEffectiveApprovalStatus) {
      pdfFilter.approvalStatus = effectiveApprovalStatus;
    }
    if (q) {
      const regex = new RegExp(q, "i");
      pdfFilter.$or = [{ filename: regex }, { address: regex }];
    }
    if (exactContractRegex) pdfFilter.contract_no = exactContractRegex;
    if (reportType && reportType === 'Asset') {
      pdfFilter._id = null;
    } else if (reportType && reportType !== 'Asset') {
      pdfFilter.reportType = reportType;
    }
    applyReportReleaseFilter(pdfFilter, releaseStatus);
    if (from || to) {
      pdfFilter.createdAt = {};
      if (from) pdfFilter.createdAt.$gte = new Date(from);
      if (to) pdfFilter.createdAt.$lte = new Date(to);
    }

    // Build filters for AssetReports
    const assetStatusFilter = hasEffectiveApprovalStatus
      ? effectiveApprovalStatus === "approved"
        ? ["approved"]
        : effectiveApprovalStatus === "pending"
          ? ["pending_approval"]
          : ["declined"]
      : isSuperAdmin
        ? ["pending_approval", "approved", "declined"]
        : ["approved"];
    const assetFilter: any = excludeDraftPreviewReports({ status: { $in: assetStatusFilter } });
    applyReportArchiveFilter(assetFilter, archivedView);
    if (q) {
      const regex = new RegExp(q, "i");
      assetFilter.$or = [
        { contract_no: regex },
        { 'preview_data.contract_no': regex },
        { 'preview_data.client_name': regex },
        { 'preview_data.prepared_for': regex }
      ];
    }
    if (exactContractRegex) {
      assetFilter.$and = [
        ...(Array.isArray(assetFilter.$and) ? assetFilter.$and : []),
        { $or: [{ contract_no: exactContractRegex }, { 'preview_data.contract_no': exactContractRegex }] },
      ];
    }
    if (reportType && reportType === 'Asset') {
      // Include only AssetReports
    } else if (reportType) {
      // Exclude AssetReports if filtering by other types
      assetFilter._id = null; // Never match
    }
    if (from || to) {
      assetFilter.createdAt = {};
      if (from) assetFilter.createdAt.$gte = new Date(from);
      if (to) assetFilter.createdAt.$lte = new Date(to);
    }
    applyReportReleaseFilter(assetFilter, releaseStatus);

    // Build filters for RealEstateReports
    const realEstateStatusFilter = hasEffectiveApprovalStatus
      ? effectiveApprovalStatus === "approved"
        ? ["approved"]
        : effectiveApprovalStatus === "pending"
          ? ["pending_approval"]
          : ["declined"]
      : isSuperAdmin
        ? ["pending_approval", "approved", "declined"]
        : ["approved"];
    const realEstateFilter: any = { status: { $in: realEstateStatusFilter } };
    applyReportArchiveFilter(realEstateFilter, archivedView);
    if (exactContractRegex) realEstateFilter._id = null;
    if (q) {
      const regex = new RegExp(q, "i");
      realEstateFilter.$or = [
        { 'property_details.address': regex },
        { 'property_details.owner_name': regex },
        { 'preview_data.property_details.address': regex }
      ];
    }
    if (reportType && reportType === 'RealEstate') {
      // Include only RealEstateReports
    } else if (reportType) {
      // Exclude RealEstateReports if filtering by other types
      realEstateFilter._id = null; // Never match
    }
    if (from || to) {
      realEstateFilter.createdAt = {};
      if (from) realEstateFilter.createdAt.$gte = new Date(from);
      if (to) realEstateFilter.createdAt.$lte = new Date(to);
    }
    applyReportReleaseFilter(realEstateFilter, releaseStatus);

    // Handle user email filter
    let userIds: any[] = [];
    const creatorSearch = String(userEmail || "").trim().slice(0, 160);
    if (creatorSearch) {
      const escapedCreatorSearch = creatorSearch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const creatorRegex = new RegExp(escapedCreatorSearch, "i");
      const users = await User.find({
        $or: [
          { email: creatorRegex },
          { username: creatorRegex },
          { companyName: creatorRegex },
          { contactEmail: creatorRegex },
        ],
      }).select("_id");
      if (users.length) {
        userIds = users.map((u) => u._id);
        pdfFilter.user = { $in: userIds };
        assetFilter.user = { $in: userIds };
        realEstateFilter.user = { $in: userIds };
      } else {
        return res.status(200).json({ items: [], total: 0, page, limit });
      }
    }

    // Build filters for LotListings
    const lotListingStatusFilter = hasEffectiveApprovalStatus
      ? effectiveApprovalStatus === "approved"
        ? ["approved"]
        : effectiveApprovalStatus === "pending"
          ? ["pending_approval"]
          : ["declined"]
      : isSuperAdmin
        ? ["pending_approval", "approved", "declined"]
        : ["approved"];
    const lotListingFilter: any = excludeDraftPreviewReports({ status: { $in: lotListingStatusFilter } });
    applyReportArchiveFilter(lotListingFilter, archivedView);
    if (q) {
      const regex = new RegExp(q, "i");
      lotListingFilter.$or = [
        { contract_no: regex },
        { location: regex },
        { 'preview_data.contract_no': regex }
      ];
    }
    if (exactContractRegex) {
      lotListingFilter.$and = [
        ...(Array.isArray(lotListingFilter.$and) ? lotListingFilter.$and : []),
        { $or: [{ contract_no: exactContractRegex }, { 'preview_data.contract_no': exactContractRegex }] },
      ];
    }
    if (reportType && reportType !== 'LotListing') {
      lotListingFilter._id = null; // Never match
    }
    if (from || to) {
      lotListingFilter.createdAt = {};
      if (from) lotListingFilter.createdAt.$gte = new Date(from);
      if (to) lotListingFilter.createdAt.$lte = new Date(to);
    }
    applyReportReleaseFilter(lotListingFilter, releaseStatus);
    if (userIds.length > 0) {
      lotListingFilter.user = { $in: userIds };
    }

    // Fetch PdfReports (legacy reports)
    const pdfGroupsAgg = await (PdfReport as any).aggregate([
      { $match: pdfFilter },
      { $group: { _id: { $ifNull: ["$report", "$_id"] }, maxCreatedAt: { $max: "$createdAt" } } },
      { $sort: { maxCreatedAt: -1 } }
    ]);

    // Fetch approved AssetReports
    const assetReports = await AssetReport.find(assetFilter)
      .populate("user", "email username")
      .sort({ createdAt: -1 })
      .lean();

    // Fetch approved RealEstateReports
    const realEstateReportsData = await RealEstateReport.find(realEstateFilter)
      .populate("user", "email username")
      .sort({ createdAt: -1 })
      .lean();

    // Fetch LotListings
    const lotListingsData = await LotListing.find(lotListingFilter)
      .populate("user", "email username")
      .sort({ createdAt: -1 })
      .lean();

    // Convert AssetReports to match PdfReport format
    const assetItems = assetReports.map((r: any) => {
      const previewData = r.preview_data || {};
      const workflowAccess = getReportDownloadAccess(r);
      const generation = resolveReportGenerationStateForProfile(
        "asset",
        r,
        r.preview_files,
        r.files
      );
      const downloadAccess = getReportDownloadAccessForGeneration(r, generation);
      const currency = String(previewData?.currency || r.currency || 'CAD').toUpperCase();
      const baseFMV = previewData?.valuation_data?.baseFMV;
      const lots: any[] = getReportLots(r);
      const sumFromLots = lots.reduce((acc: number, lot: any) => {
        const raw = typeof lot?.estimated_value === 'string' ? lot.estimated_value : '';
        const num = parseFloat(String(raw).replace(/[^0-9.-]+/g, ''));
        return acc + (Number.isFinite(num) ? num : 0);
      }, 0);
      const total = Number.isFinite(baseFMV as any) ? (baseFMV as number) : sumFromLots;
      const lotNumberSummary = buildLotNumberSummary(lots);
      const lotThumbnails = buildLotThumbnails(lots, reportImageUrls(r));
      const contractNo = previewData.contract_no || r.contract_no || "";
      const fmvStr = total > 0 
        ? new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(total)
        : `${currency} 0.00`;

      return {
        _id: r._id,
        filename: `${previewData.client_name || 'Asset Report'}.docx`,
        address: previewData.client_name || previewData.prepared_for || 'Asset Report',
        fairMarketValue: fmvStr,
        user: r.user,
        reportType: 'Asset',
        createdAt: r.createdAt,
        contract_no: contractNo,
        lot_number_summary: lotNumberSummary || `#${String(r._id).slice(-6)}`,
        lot_numbers: getLotNumbers(lots),
        lotCount: lots.length,
        thumbnail_url: lotThumbnails[0]?.url || null,
        lot_thumbnails: lotThumbnails,
        location: previewData.location || r.location || "",
        fileType: 'docx',
        approvalStatus: downloadAccess.approval_status,
        approval_assigned_to: r.approval_assigned_to || null,
        release_status: releaseStatusForPayload(r),
        release_assigned_to: r.release_assigned_to || null,
        released_at: r.released_at || null,
        downloadable: downloadAccess.allowed,
        download_access: downloadAccess,
        preview_files: workflowAccess.allowed ? r.preview_files : {},
        ...generation,
        download_filenames: buildDownloadFilenames({
          reportType: "Asset",
          contractNo,
          reportId: r._id,
          lots,
        }),
        crDisclaimerCount: countLotsWithCrDisclaimers(buildCrCountReportData(r, previewData)),
        report: r._id, // Use same ID for grouping
        adminArchivedAt: r.adminArchivedAt || null,
      };
    });

    // Convert RealEstateReports to match PdfReport format
    const realEstateItems = realEstateReportsData.map((r: any) => {
      const previewData = r.preview_data || {};
      const workflowAccess = getReportDownloadAccess(r);
      const generation = resolveReportGenerationStateForProfile(
        "realEstate",
        r,
        r.preview_files,
        r.files
      );
      const downloadAccess = getReportDownloadAccessForGeneration(r, generation);
      const fmv = previewData.valuation?.fair_market_value || 
                  previewData.farmland_valuation?.fair_market_value_formatted || 
                  r.farmland_valuation?.fair_market_value_formatted || 
                  'N/A';
      const address = previewData.property_details?.address || 
                      r.property_details?.address || 
                      'Real Estate Report';

      return {
        _id: r._id,
        filename: `${address}.docx`,
        address: address,
        fairMarketValue: fmv,
        user: r.user,
        reportType: 'RealEstate',
        createdAt: r.createdAt,
        contract_no: undefined,
        fileType: 'docx',
        approvalStatus: downloadAccess.approval_status,
        approval_assigned_to: r.approval_assigned_to || null,
        release_status: releaseStatusForPayload(r),
        release_assigned_to: r.release_assigned_to || null,
        released_at: r.released_at || null,
        downloadable: downloadAccess.allowed,
        download_access: downloadAccess,
        preview_files: workflowAccess.allowed ? r.preview_files : {},
        ...generation,
        report: r._id, // Use same ID for grouping
        isRealEstateReport: true,
        property_type: r.property_type,
        language: r.language,
        adminArchivedAt: r.adminArchivedAt || null,
      };
    });

    // Convert LotListings to match PdfReport format
    const lotListingItems = lotListingsData.map((r: any) => {
      const previewData = r.preview_data || {};
      const workflowAccess = getReportDownloadAccess(r);
      const generation = resolveReportGenerationStateForProfile(
        "lotListing",
        r,
        r.preview_files,
        r.files
      );
      const downloadAccess = getReportDownloadAccessForGeneration(r, generation);
      const contractNo = previewData.contract_no || r.contract_no || 'Lot Listing';
      const location = previewData.location || r.location || '';
      const lots = previewData.lots || r.lots || [];
       const lotThumbnails = buildLotThumbnails(lots, reportImageUrls(r));
      const lotNumberSummary = buildLotNumberSummary(lots);
      const artifactNames = buildReportArtifactFilenames({
        kind: "lotListing",
        contractNo,
        reportId: r._id,
        fallback: r._id,
        lots,
      });

      return {
        _id: r._id,
        filename: artifactNames.excel,
        address: `${contractNo} - ${lotNumberSummary || `#${String(r._id).slice(-6)}`}${location ? ` - ${location}` : ""}`,
        fairMarketValue: `${lots.length} lots`,
        user: r.user,
        reportType: 'LotListing',
        createdAt: r.createdAt,
        contract_no: contractNo,
        lot_number_summary: lotNumberSummary || `#${String(r._id).slice(-6)}`,
        lot_numbers: getLotNumbers(lots),
        lotCount: lots.length,
        thumbnail_url: lotThumbnails[0]?.url || null,
        lot_thumbnails: lotThumbnails,
        fileType: 'xlsx',
        approvalStatus: downloadAccess.approval_status,
        approval_assigned_to: r.approval_assigned_to || null,
        release_status: releaseStatusForPayload(r),
        release_assigned_to: r.release_assigned_to || null,
        released_at: r.released_at || null,
        downloadable: downloadAccess.allowed,
        download_access: downloadAccess,
        preview_files: workflowAccess.allowed ? r.preview_files : {},
        files: workflowAccess.allowed ? r.files : {},
        ...generation,
        download_filenames: buildDownloadFilenames({
          reportType: "LotListing",
          contractNo,
          reportId: r._id,
          lots,
        }),
        crDisclaimerCount: countLotsWithCrDisclaimers(buildCrCountReportData(r, previewData)),
        report: r._id,
        isLotListing: true,
        status: r.status,
        location: location,
        adminArchivedAt: r.adminArchivedAt || null,
      };
    });

    // Fetch PdfReport details for the groups
    const reportIds = pdfGroupsAgg.map((g: any) => g._id);
    const pdfItems = reportIds.length > 0 
      ? await PdfReport.find({
          ...pdfFilter,
          $or: reportIds.map((id: any) => id ? { report: id } : { _id: id, report: { $exists: false } })
        })
        .populate("user", "email username")
        .sort({ createdAt: -1 })
        .lean()
      : [];

    const pdfGroupFileTypes = new Map<string, Set<string>>();
    for (const item of pdfItems as any[]) {
      const groupKey = String(item.report || item._id);
      const path = String(item.filePath || item.imagesFolderPath || "").trim();
      if (!path) continue;
      const fileTypes = pdfGroupFileTypes.get(groupKey) || new Set<string>();
      const filename = String(item.filename || "").trim().toLowerCase();
      const rawFileType =
        String(item.fileType || "").trim().toLowerCase() ||
        filename.split(".").pop() ||
        "";
      fileTypes.add(
        rawFileType === "zip" || rawFileType === "images" || filename.includes("images")
          ? "images"
          : rawFileType
      );
      pdfGroupFileTypes.set(groupKey, fileTypes);
    }

    const normalizedPdfItems = pdfItems.map((r: any) => {
      const workflowAccess = getReportDownloadAccess(r);
      const groupKey = String(r.report || r._id);
      const groupFileTypes = pdfGroupFileTypes.get(groupKey) || new Set<string>();
      const filesReady = ["docx", "xlsx", "images"].every((fileType) =>
        groupFileTypes.has(fileType)
      );
      const downloadAccess =
        workflowAccess.allowed && !filesReady
          ? {
              ...workflowAccess,
              allowed: false,
              code: "FILES_UNAVAILABLE" as const,
              message:
                "One or more required report files are unavailable. Regenerate the report files or contact support.",
            }
          : workflowAccess;
      return {
        ...r,
        approvalStatus: downloadAccess.approval_status,
        approval_assigned_to: r.approval_assigned_to || null,
        release_status: releaseStatusForPayload(r),
        release_assigned_to: r.release_assigned_to || null,
        released_at: r.released_at || null,
        downloadable: downloadAccess.allowed,
        download_access: downloadAccess,
        files_ready: filesReady,
        ...(!filesReady
          ? {
              generation_state: "error" as const,
              workflow_stage: "error" as const,
              workflow_message: downloadAccess.message,
            }
          : {}),
        lot_thumbnails: [],
        download_filenames: buildDownloadFilenames({
          reportType: r.reportType,
          contractNo: r.contract_no || r.address || r.filename,
          reportId: r.report || r._id,
        }),
      };
    });

    // Combine all lists and sort by date
    const allItems = [...normalizedPdfItems, ...assetItems, ...realEstateItems, ...lotListingItems].sort((a: any, b: any) => {
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    console.log(`[getAdminReports] role=${userRole} archived=${archivedView} pdf=${pdfItems.length} asset=${assetReports.length} re=${realEstateReportsData.length} lot=${lotListingsData.length} total=${allItems.length}`);

    // Apply pagination to combined results
    const total = allItems.length;
    const startIdx = (page - 1) * limit;
    const endIdx = startIdx + limit;
    const items = allItems.slice(startIdx, endIdx);

    return res.status(200).json({ items, total, page, limit });
  } catch (e) {
    console.error("getAdminReports error", e);
    return res.status(500).json({ message: "Failed to fetch reports" });
  }
};

export const getSameContractReports = async (req: any, res: Response) => {
  const contractNo = cleanString(req.query?.contractNo);
  if (!contractNo) {
    return res.status(400).json({ message: "Contract number is required" });
  }

  // Reuse the authoritative report serializer while forcing an exact contract
  // filter. Keeping this path separate prevents clients from silently sending
  // an unsupported query key and receiving unrelated reports.
  const forwarded = Object.create(req);
  Object.defineProperty(forwarded, "query", {
    configurable: true,
    enumerable: true,
    value: {
      contractNo,
      approvalStatus: "approved",
      archived: req.query?.archived || "false",
      page: "1",
      limit: "200",
    },
  });
  return getAdminReports(forwarded, res);
};

async function setAdminReportArchiveState(id: string, archived: boolean, userId?: string) {
  const archiveFields = archived
    ? { adminArchivedAt: new Date(), adminArchivedBy: userId || null }
    : { adminArchivedAt: null, adminArchivedBy: null };

  const [pdfDirect, pdfByReport, asset, realEstate, lotListing] = await Promise.all([
    (PdfReport as any).updateMany({ _id: id }, { $set: archiveFields }),
    (PdfReport as any).updateMany({ report: id }, { $set: archiveFields }),
    (AssetReport as any).updateOne({ _id: id }, { $set: archiveFields }),
    (RealEstateReport as any).updateOne({ _id: id }, { $set: archiveFields }),
    (LotListing as any).updateOne({ _id: id }, { $set: archiveFields }),
  ]);

  return [
    pdfDirect,
    pdfByReport,
    asset,
    realEstate,
    lotListing,
  ].reduce((sum: number, result: any) => {
    return sum + Number(result?.matchedCount || result?.n || 0);
  }, 0);
}

export const archiveAdminReport = async (req: any, res: Response) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ message: "Report id is required" });

    const matched = await setAdminReportArchiveState(id, true, req.userId || req.user?._id);
    if (matched <= 0) return res.status(404).json({ message: "Report not found" });

    return res.status(200).json({ message: "Report marked completed", archived: true });
  } catch (e: any) {
    console.error("archiveAdminReport error", e);
    return res.status(500).json({ message: e?.message || "Failed to archive report" });
  }
};

export const restoreAdminReport = async (req: any, res: Response) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ message: "Report id is required" });

    const matched = await setAdminReportArchiveState(id, false, req.userId || req.user?._id);
    if (matched <= 0) return res.status(404).json({ message: "Report not found" });

    return res.status(200).json({ message: "Report restored", archived: false });
  } catch (e: any) {
    console.error("restoreAdminReport error", e);
    return res.status(500).json({ message: e?.message || "Failed to restore report" });
  }
};

// Approve lot listing
export const approveLotListing = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const listing = await LotListing.findOne({
      _id: id,
      is_draft_preview: { $ne: true },
    }).populate("user", "email username");

    if (!listing) {
      return res.status(404).json({ message: "Lot listing not found" });
    }

    if (listing.status !== "pending_approval") {
      return res.status(400).json({ message: "Lot listing is not pending approval" });
    }
    assertReportFilesReadyForWorkflow("lotListing", listing);

    // Copy preview files to final files
    listing.files = listing.preview_files;
    listing.status = "approved";
    listing.decline_reason = undefined;
    (listing as any).approval_processed_at = new Date();
    await assignReleaseManager(listing, {
      userId: (listing as any).user?._id || (listing as any).user,
      forceManual: Boolean((listing as any).auctioneerWorkItem),
    });
    await listing.save();
    const releaseEmailSent = await sendAssignedReleaseEmail(listing, {
      reportType: "Lot Listing",
      creatorUserId: (listing as any).user?._id || (listing as any).user,
      title: (listing as any).preview_data?.contract_no || (listing as any).contract_no || "Lot Listing",
      summary: (listing as any).preview_data?.location || (listing as any).location || "",
    });
    if (releaseEmailSent) {
      await listing.save().catch((markerError: unknown) => {
        console.error("lot listing release email marker save error", markerError);
      });
    }

    // Send approval email
    try {
      const user = listing.user as any;
      const previewData = listing.preview_data || {};
      const awaitingRelease = String((listing as any).release_status || "") === "pending_release";
      const emailHtml = `
        <h2>Lot Listing Approved!</h2>
        <p>Great news! Your lot listing for contract <strong>${previewData.contract_no || listing.contract_no}</strong> has been approved.</p>
        <p><strong>Location:</strong> ${previewData.location || listing.location}</p>
        <p><strong>Total Lots:</strong> ${(previewData.lots || listing.lots)?.length || 0}</p>
        <br/>
        <p>${awaitingRelease ? "It is now waiting for release before downloads are available." : "You can now download your files from the app."}</p>
        ${awaitingRelease ? "" : `<p><a href="${listing.files?.excel}" style="background: #2563EB; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Download Excel</a></p>
        <br/>
        <p><a href="${listing.files?.images}" style="background: #059669; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Download Images ZIP</a></p>`}
      `;
      await sendEmail(
        user?.email || "",
        `Lot Listing Approved - ${previewData.contract_no || listing.contract_no}`,
        emailHtml
      );
    } catch (emailErr) {
      console.warn("Failed to send approval email:", emailErr);
    }

    await notifyUser({
      userId: String((listing as any).user?._id || (listing as any).user || ""),
      category: "report",
      type: "lot_listing_approved",
      title: "Lot Listing Approved",
      body: (listing as any).release_status === "pending_release"
        ? "Your lot listing has been approved and is waiting for release."
        : "Your lot listing has been approved and is ready in Reports.",
      data: {
        type: "lot_listing_approved",
        reportId: String(listing._id),
        reportType: "LotListing",
      },
    }).catch((pushErr) => {
      console.error("approveLotListing push error", pushErr);
    });

    return res.status(200).json({ message: "Lot listing approved", data: listing });
  } catch (e: any) {
    if (Number(e?.statusCode) === 409) {
      return res.status(409).json({
        code: e?.code,
        message: e?.message || "Report files are not ready for approval",
      });
    }
    console.error("approveLotListing error", e);
    return res.status(500).json({ message: "Failed to approve lot listing" });
  }
};

// Decline lot listing
export const declineLotListing = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};

    const listing = await LotListing.findOne({
      _id: id,
      is_draft_preview: { $ne: true },
    }).populate("user", "email username");

    if (!listing) {
      return res.status(404).json({ message: "Lot listing not found" });
    }

    if (listing.status !== "pending_approval") {
      return res.status(400).json({ message: "Lot listing is not pending approval" });
    }

    listing.status = "declined";
    listing.decline_reason = reason || "No reason provided";
    await listing.save();

    // Send decline email
    try {
      const user = listing.user as any;
      const previewData = listing.preview_data || {};
      const emailHtml = `
        <h2>Lot Listing Declined</h2>
        <p>Your lot listing for contract <strong>${previewData.contract_no || listing.contract_no}</strong> has been declined.</p>
        <p><strong>Reason:</strong> ${listing.decline_reason}</p>
        <br/>
        <p>Please review and make the necessary changes, then resubmit your lot listing.</p>
      `;
      await sendEmail(
        user?.email || "",
        `Lot Listing Declined - ${previewData.contract_no || listing.contract_no}`,
        emailHtml
      );
    } catch (emailErr) {
      console.warn("Failed to send decline email:", emailErr);
    }

    await notifyUser({
      userId: String((listing as any).user?._id || (listing as any).user || ""),
      category: "report",
      type: "lot_listing_declined",
      title: "Lot Listing Declined",
      body: "Your lot listing was declined. Review the notes and resubmit it.",
      data: {
        type: "lot_listing_declined",
        reportId: String(listing._id),
        reportType: "LotListing",
      },
    }).catch((pushErr) => {
      console.error("declineLotListing push error", pushErr);
    });

    return res.status(200).json({ message: "Lot listing declined", data: listing });
  } catch (e) {
    console.error("declineLotListing error", e);
    return res.status(500).json({ message: "Failed to decline lot listing" });
  }
};
