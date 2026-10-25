import archiver from "archiver";
import axios from "axios";
import { createReadStream } from "fs";
import { access, stat } from "fs/promises";
import type { Response } from "express";
import mongoose from "mongoose";
import AssetReport from "../models/asset.model.js";
import ReleasedAppraisalAnalysis from "../models/releasedAppraisalAnalysis.model.js";
import User from "../models/user.model.js";
import type { AdminAuthRequest } from "../middleware/admin.middleware.js";
import {
  RELEASED_ARTIFACT_KINDS,
  buildReleasedAppraisalFingerprint,
  buildReleasedArtifactManifest,
  buildReleasedInsights,
  buildReleasedQuality,
  buildReleasedRow,
  getLegacyFilesystemCandidates,
  getReleasedAssetReport,
  loadLegacyArtifactMap,
  resolveReleasedArtifactSource,
  type ReleasedArtifactKind,
} from "../service/releasedAppraisalService.js";
import { createMongoReportJob } from "../utils/reportJobMongoQueue.js";

const noStore = (res: Response) =>
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function buildBaseQuery(archived: boolean) {
  const query: Record<string, any> = {
    status: "approved",
    is_draft_preview: { $ne: true },
    ...(archived
      ? { adminArchivedAt: { $ne: null } }
      : { adminArchivedAt: null }),
  };
  query.$or = [{ release_status: "released" }, { released_at: { $ne: null } }];
  return query;
}

function matchesIssue(row: any, issue: string) {
  if (!issue || issue === "all") return true;
  const findings = Array.isArray(row.qualityFindings) ? row.qualityFindings : [];
  if (issue === "critical" || issue === "warning") {
    return findings.some((finding: any) => finding.severity === issue);
  }
  if (issue === "missing-artifacts") return findings.some((finding: any) => /^MISSING_(CR|APPRAISAL|EXCEL|IMAGES)/.test(finding.code));
  if (issue === "valuation") return findings.some((finding: any) => /FMV|FLV|OLV|VALUE_OUTLIER/.test(finding.code));
  if (issue === "images") return findings.some((finding: any) => finding.code === "MISSING_IMAGES");
  if (issue === "duplicates") return findings.some((finding: any) => /^DUPLICATE_/.test(finding.code));
  if (issue === "turnaround") return findings.some((finding: any) => finding.code === "LONG_RELEASE_TURNAROUND");
  return true;
}

function sortRows(rows: any[], sort: string) {
  const compareDate = (a: any, b: any) => new Date(a.releasedAt || a.createdAt || 0).getTime() - new Date(b.releasedAt || b.createdAt || 0).getTime();
  if (sort === "released_asc") return rows.sort(compareDate);
  if (sort === "fmv_desc") return rows.sort((a, b) => Number(b.fmv || 0) - Number(a.fmv || 0));
  if (sort === "fmv_asc") return rows.sort((a, b) => Number(a.fmv || 0) - Number(b.fmv || 0));
  if (sort === "lots_desc") return rows.sort((a, b) => Number(b.lotCount || 0) - Number(a.lotCount || 0));
  if (sort === "issues_desc") return rows.sort((a, b) => Number(b.qualitySummary?.issueCount || 0) - Number(a.qualitySummary?.issueCount || 0));
  return rows.sort((a, b) => compareDate(b, a));
}

export async function listReleasedAppraisals(req: AdminAuthRequest, res: Response) {
  try {
    noStore(res);
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const archived = String(req.query.archived || "false") === "true";
    const q = String(req.query.q || "").trim();
    const creator = String(req.query.creator || "").trim();
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    const query = buildBaseQuery(archived);

    if (creator && mongoose.isValidObjectId(creator)) query.user = creator;
    if (from || to) {
      query.released_at = {};
      if (from) query.released_at.$gte = new Date(`${from}T00:00:00.000Z`);
      if (to) query.released_at.$lte = new Date(`${to}T23:59:59.999Z`);
    }
    if (q) {
      const regex = new RegExp(escapeRegex(q), "i");
      const userIds = await User.find({ $or: [{ email: regex }, { username: regex }, { name: regex }] }).distinct("_id");
      query.$and = [
        { $or: query.$or },
        {
          $or: [
            { contract_no: regex },
            { client_name: regex },
            { prepared_for: regex },
            { "lots.title": regex },
            { "preview_data.lots.title": regex },
            { user: { $in: userIds } },
          ],
        },
      ];
      delete query.$or;
    }

    const reports = await AssetReport.find(query)
      .populate("user", "username name email profilePictureUrl profile_picture_url")
      .lean();
    const ids = reports.map((report: any) => String(report._id));
    const legacyMap = await loadLegacyArtifactMap(ids);
    let rows = reports.map((report: any) => buildReleasedRow(report, legacyMap.get(String(report._id)) || []));
    rows = rows.filter((row) => matchesIssue(row, String(req.query.issue || "all")));
    sortRows(rows, String(req.query.sort || "released_desc"));
    const total = rows.length;
    const start = (page - 1) * limit;

    return res.json({
      items: rows.slice(start, start + limit),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    console.error("listReleasedAppraisals error", error);
    return res.status(500).json({ message: "Unable to load released appraisals." });
  }
}

function contentType(kind: ReleasedArtifactKind) {
  if (kind === "cr-pdf") return "application/pdf";
  if (kind === "excel") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (kind === "images") return "application/zip";
  return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
}

async function firstExistingPath(value: string) {
  for (const candidate of getLegacyFilesystemCandidates(value)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Legacy deployments used several roots; continue until one resolves.
    }
  }
  return null;
}

export async function downloadReleasedAppraisalArtifact(req: AdminAuthRequest, res: Response) {
  try {
    const kind = String(req.params.kind) as ReleasedArtifactKind;
    if (!RELEASED_ARTIFACT_KINDS.includes(kind)) {
      return res.status(400).json({ message: "Unsupported artifact type." });
    }
    const report = await getReleasedAssetReport(String(req.params.id));
    if (!report) return res.status(404).json({ message: "Released appraisal not found." });
    const legacyMap = await loadLegacyArtifactMap([String(report._id)]);
    const legacyRows = legacyMap.get(String(report._id)) || [];
    const manifest = buildReleasedArtifactManifest(report, legacyRows);
    const artifact = manifest[kind];
    const source = resolveReleasedArtifactSource(report, legacyRows, kind);
    if (!artifact.available || !source) {
      return res.status(404).json({ code: artifact.reasonCode, message: artifact.reason });
    }

    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Type", contentType(kind));
    res.setHeader("Content-Disposition", `attachment; filename="${artifact.filename.replace(/[\r\n"]/g, "")}"`);

    if (/^https?:\/\//i.test(source.value)) {
      // Large image packages can take longer to begin streaming from object
      // storage. Keep the request bounded, but do not fail valid ZIP downloads
      // on the short timeout used for ordinary JSON requests.
      const upstream = await axios.get(source.value, { responseType: "stream", timeout: 300_000 });
      const upstreamLength = upstream.headers["content-length"];
      if (typeof upstreamLength === "string" || typeof upstreamLength === "number") {
        res.setHeader("Content-Length", upstreamLength);
      }
      upstream.data.on("error", (error: Error) => res.destroy(error));
      return upstream.data.pipe(res);
    }

    const localPath = await firstExistingPath(source.value);
    if (!localPath) return res.status(404).end();
    const info = await stat(localPath);
    if (info.isDirectory()) {
      const zip = archiver("zip", { zlib: { level: 6 } });
      zip.on("error", (error) => res.destroy(error));
      zip.pipe(res);
      zip.directory(localPath, false);
      await zip.finalize();
      return;
    }
    res.setHeader("Content-Length", info.size);
    return createReadStream(localPath).pipe(res);
  } catch (error: any) {
    console.error("downloadReleasedAppraisalArtifact error", error);
    if (!res.headersSent) return res.status(502).json({ message: "The stored artifact could not be downloaded." });
    return res.destroy(error);
  }
}

async function analysisContext(reportId: string) {
  const report = await getReleasedAssetReport(reportId);
  if (!report) return null;
  const legacyMap = await loadLegacyArtifactMap([reportId]);
  const artifacts = buildReleasedArtifactManifest(report, legacyMap.get(reportId) || []);
  const quality = buildReleasedQuality(report, artifacts);
  const insights = buildReleasedInsights(report, quality);
  const fingerprint = buildReleasedAppraisalFingerprint(report, quality);
  return { report, artifacts, quality, insights, fingerprint };
}

export async function getReleasedAppraisalAnalysis(req: AdminAuthRequest, res: Response) {
  try {
    noStore(res);
    const context = await analysisContext(String(req.params.id));
    if (!context) return res.status(404).json({ message: "Released appraisal not found." });
    const current = await ReleasedAppraisalAnalysis.findOne({ reportId: req.params.id, fingerprint: context.fingerprint }).lean();
    const latest = current || await ReleasedAppraisalAnalysis.findOne({ reportId: req.params.id }).sort({ createdAt: -1 }).lean();
    return res.json({
      fingerprint: context.fingerprint,
      staticInsights: context.insights,
      qualitySummary: context.quality.summary,
      findings: context.quality.findings,
      analysis: latest ? {
        id: String(latest._id), status: latest.status, result: latest.result || null,
        error: latest.error || null, model: latest.modelName || null,
        updatedAt: latest.updatedAt, stale: latest.fingerprint !== context.fingerprint,
      } : null,
    });
  } catch (error) {
    console.error("getReleasedAppraisalAnalysis error", error);
    return res.status(500).json({ message: "Unable to load appraisal insights." });
  }
}

export async function requestReleasedAppraisalAnalysis(req: AdminAuthRequest, res: Response) {
  try {
    noStore(res);
    const reportId = String(req.params.id);
    const context = await analysisContext(reportId);
    if (!context) return res.status(404).json({ message: "Released appraisal not found." });
    const refresh = req.body?.refresh === true;
    let cache = await ReleasedAppraisalAnalysis.findOne({ reportId, fingerprint: context.fingerprint });
    if (cache?.status === "completed" && !refresh) {
      return res.json({ status: cache.status, analysisId: String(cache._id), cached: true });
    }
    // An explicit refresh may replace completed data, but it must never create
    // a second live research job for the same report snapshot.
    if (cache && ["queued", "processing"].includes(cache.status)) {
      return res.status(202).json({ status: cache.status, analysisId: String(cache._id), cached: true });
    }
    cache = cache || new ReleasedAppraisalAnalysis({ reportId, fingerprint: context.fingerprint });
    cache.status = "queued";
    cache.result = undefined;
    cache.error = null;
    cache.requestedBy = req.userId as any;
    cache.startedAt = null;
    cache.completedAt = null;
    await cache.save();

    const job = await createMongoReportJob({
      type: "released-appraisal-analysis",
      reportId,
      payload: { reportId, fingerprint: context.fingerprint, notifyOwnerOnFailure: false },
      maxAttempts: 3,
      priority: -5,
      idempotencyKey: refresh
        ? `released-analysis:${reportId}:${context.fingerprint}:refresh:${Date.now()}`
        : `released-analysis:${reportId}:${context.fingerprint}`,
    });
    if (!job) {
      throw new Error("The analysis job could not be queued.");
    }
    cache.jobId = job._id as any;
    await cache.save();
    return res.status(202).json({ status: "queued", analysisId: String(cache._id), jobId: String(job._id), cached: false });
  } catch (error) {
    console.error("requestReleasedAppraisalAnalysis error", error);
    return res.status(500).json({ message: "Unable to queue appraisal analysis." });
  }
}
