/**
 * Authenticated Real Estate report lifecycle controller.
 *
 * It preserves the established create/progress/preview/approval API while long-running
 * document work runs in queued jobs. User ownership and workflow status constrain every
 * mutation; release and download policy are derived from server state, not client input.
 */
import { Request, Response } from "express";
import { productionReportOwnerFilter } from "../service/reviewReportPolicy.js";
import { previewQueueSummary } from "../utils/previewQueueSummary.js";
import upload from "../utils/multerStorage.js";
import { getR2PublicUrl, uploadToR2 } from "../utils/r2Storage/r2Upload.js";
import { analyzeRealEstateImages } from "../service/openAIService.js";
import {
  findComparableProperties,
  SearchResult,
} from "../service/webSearchService.js";
import { calculateFairMarketValue } from "../service/valuationService.js";
import RealEstateReport from "../models/realEstate.model.js";
import { generatePdfFromReport } from "../service/pdfService.js";
import PdfReport from "../models/pdfReport.model.js";
import fs from "fs/promises";
import path from "path";
import { AuthRequest } from "../middleware/auth.middleware.js";
import { endProgress, getProgress } from "../utils/progressStore.js";
import { 
  queueRealEstateReportJob,
  queueRealEstatePreviewJob,
  queueRealEstateFilesJob,
} from "../jobs/realEstateReportJob.js";
import {
  MarketTrend,
  marketTrendSearch,
  PropertyDetails,
} from "../service/marketTrendSebSearch.js";
import { generateRealEstateDocxFromReport } from "../service/realEstateDocxService.js";
import { generateRealEstateXlsx } from "../service/xlsx/realEstateXlsxService.js";
import { sendEmail } from "../utils/sendVerificationEmail.js";
import { notifyUser } from "../service/notificationService.js";
import {
  assignReportApprover,
  approvalAssignedPopulatePath,
  assignedApprovalDeniedMessage,
  canProcessAssignedApproval,
  mergeApprovalScope,
  sendAssignedApprovalEmail,
} from "../service/approvalAssignmentService.js";
import {
  assertReportFilesReadyForWorkflow,
  markReportAutoReleased,
  getReportDownloadAccessForGeneration,
  releaseStatusForPayload,
} from "../service/reportReleaseService.js";
import {
  claimReportApprovalDecision,
  releaseFieldsForApprovalDecision,
} from "../service/reportApprovalDecisionService.js";
import { resolveReportGenerationStateForProfile } from "../utils/reportFileState.js";

export const createRealEstate = async (req: AuthRequest, res: Response) => {
  try {
    const details = JSON.parse(req.body.details);
    const images = req.files as Express.Multer.File[];
    console.log(JSON.stringify(req.body, null, 2));

    const imageUrls: string[] = [];
    if (images?.length) {
      for (const file of images) {
        const timestamp = Date.now();
        const fileName = `uploads/real-estate/${timestamp}-${file.originalname}`;
        await uploadToR2(file, process.env.R2_BUCKET_NAME!, fileName);
        const fileUrl = getR2PublicUrl(fileName);
        imageUrls.push(fileUrl);
      }
    }

    let aiExtractedData = {};
    if (imageUrls.length > 0) {
      try {
        aiExtractedData = await analyzeRealEstateImages(imageUrls);
        console.log(
          "AI Extracted Data:",
          JSON.stringify(aiExtractedData, null, 2)
        );
      } catch (aiError) {
        console.error("Error during AI image analysis:", aiError);
        // Decide if you want to fail the request or proceed without AI data
        // For now, we'll proceed without it
      }
    }

    const finalData = {
      ...details,
      owner_name: details.property_details?.owner_name || "",
      house_details: {
        ...details.house_details,
        ...aiExtractedData,
      },
      imageUrls,
    };

    console.log("Final Combined Data:", JSON.stringify(finalData, null, 2));

    let comparableProperties: any = {};
    if (finalData.property_details.address) {
      try {
        comparableProperties = await findComparableProperties(
          finalData.property_details,
          finalData.house_details
        );
        console.log("Found Comparable Properties:", comparableProperties);
      } catch (searchError) {
        console.error(
          "Error during web search for comparable properties:",
          searchError
        );
      }
    }

    let valuation = {};
    const comparablePropertiesForValuation = Array.isArray(comparableProperties)
      ? comparableProperties
      : [];
    if (comparablePropertiesForValuation.length > 0) {
      try {
        valuation = await calculateFairMarketValue(
          finalData,
          comparablePropertiesForValuation
        );
        console.log("Calculated Valuation:", valuation);
      } catch (valuationError) {
        console.error("Error during valuation:", valuationError);
      }
    }

    // Fetch market trend data
    let marketTrendData: MarketTrend[] = [];
    if (
      finalData.property_details.address &&
      finalData.property_details.municipality
    ) {
      try {
        const propertyDetails: PropertyDetails = {
          address: finalData.property_details.address,
          municipality: finalData.property_details.municipality,
        };
        marketTrendData = await marketTrendSearch(propertyDetails);
        console.log("Market Trend Data:", marketTrendData);
      } catch (marketTrendError) {
        console.error("Error during market trend search:", marketTrendError);
      }
    }

    // Save the final report to the database
    const comparablePropertiesMap = new Map();
    if (Array.isArray(comparablePropertiesForValuation)) {
      comparablePropertiesForValuation.forEach((comp: any) => {
        const { name, ...details } = comp;
        comparablePropertiesMap.set(name, details);
      });
    }

    const newReport = new RealEstateReport({
      ...finalData,
      user: (req as any).user._id, // Authenticated ownership overrides submitted details.
      comparableProperties: comparablePropertiesMap,
      valuation,
      marketTrend: marketTrendData,
    });

    await newReport.save();

    console.log("New Report:", newReport);

    // Generate the PDF
    // Manually construct the object for the PDF to ensure Map is converted correctly
    const reportObjectForPdf = newReport.toObject();
    reportObjectForPdf.comparableProperties = Object.fromEntries(
      comparablePropertiesMap
    );

    const pdfBuffer = await generatePdfFromReport(reportObjectForPdf);

    // Ensure the reports directory exists
    const reportsDir = path.resolve(process.cwd(), "reports");
    await fs.mkdir(reportsDir, { recursive: true });

    // Save the PDF to the reports folder
    const timestamp = Date.now();
    const pdfFilename = `real-estate-report-${newReport._id}-${timestamp}.pdf`;
    const pdfFilePath = path.join(reportsDir, pdfFilename);
    await fs.writeFile(pdfFilePath, pdfBuffer);

    // Generate DOCX
    let docxPublicPath = "";
    try {
      const docxBuffer = await generateRealEstateDocxFromReport(reportObjectForPdf);
      const docxFilename = `real-estate-report-${newReport._id}-${timestamp}.docx`;
      const docxFilePath = path.join(reportsDir, docxFilename);
      await fs.writeFile(docxFilePath, docxBuffer);
      docxPublicPath = `/reports/${docxFilename}`;

      // Save record for DOCX
      const docxReport = new PdfReport({
        filename: docxFilename,
        fileType: "docx",
        filePath: `reports/${docxFilename}`,
        user: req.userId,
        report: newReport._id,
        reportType: "RealEstate",
        reportModel: "RealEstateReport",
        address: newReport.property_details?.address || "",
        fairMarketValue: newReport.valuation?.fair_market_value || "",
      });
      await assignReportApprover(docxReport, { userId: req.userId });
      await docxReport.save();
    } catch (e) {
      console.error("Failed to generate DOCX for real estate:", e);
    }

    // Generate XLSX
    let xlsxPublicPath = "";
    try {
      const xlsxBuffer = await generateRealEstateXlsx(reportObjectForPdf);
      const xlsxFilename = `real-estate-report-${newReport._id}-${timestamp}.xlsx`;
      const xlsxFilePath = path.join(reportsDir, xlsxFilename);
      await fs.writeFile(xlsxFilePath, xlsxBuffer);
      xlsxPublicPath = `/reports/${xlsxFilename}`;

      // Save record for XLSX
      const xlsxReport = new PdfReport({
        filename: xlsxFilename,
        fileType: "xlsx",
        filePath: `reports/${xlsxFilename}`,
        user: req.userId,
        report: newReport._id,
        reportType: "RealEstate",
        reportModel: "RealEstateReport",
        address: newReport.property_details?.address || "",
        fairMarketValue: newReport.valuation?.fair_market_value || "",
      });
      await assignReportApprover(xlsxReport, { userId: req.userId });
      await xlsxReport.save();
    } catch (e) {
      console.error("Failed to generate XLSX for real estate:", e);
    }

    // Create a record for the saved PDF
    const newPdfReport = new PdfReport({
      filename: pdfFilename,
      user: req.userId,
      report: newReport._id,
      reportType: "RealEstate",
      reportModel: "RealEstateReport",
      address: newReport.property_details?.address || "",
      fairMarketValue: newReport.valuation?.fair_market_value || "",
      fileType: "pdf",
      filePath: `reports/${pdfFilename}`,
    });
    await assignReportApprover(newPdfReport, { userId: req.userId });
    await sendAssignedApprovalEmail(newPdfReport, {
      reportType: "Real Estate",
      creatorUserId: req.userId,
      title: newReport.property_details?.address || "Real Estate Report",
      summary: newReport.valuation?.fair_market_value || "",
    });
    await newPdfReport.save();

    res.status(201).json({
      message: "Report generated and saved successfully!",
      filePath: `/reports/${pdfFilename}`,
      docxPath: docxPublicPath,
      xlsxPath: xlsxPublicPath,
    });
  } catch (error) {
    console.error("Error processing real estate data:", error);
    res.status(500).json({ message: "Error processing request", error });
  }
};

/**
 * Resubmit report - allows regenerating files for approved/pending reports
 */
export const resubmitReport = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { preview_data } = req.body;

    const report = await RealEstateReport.findOne({
      _id: id,
      user: req.userId,
    }).populate('user');

    if (!report) {
      return res.status(404).json({ message: "Report not found" });
    }

    // Allow resubmit for pending_approval or approved status
    if ((report as any).status !== 'pending_approval' && (report as any).status !== 'approved') {
      return res.status(400).json({
        message: `Cannot resubmit report with status: ${(report as any).status}. Only pending or approved reports can be resubmitted.`,
      });
    }

    // Update preview data if provided
    if (preview_data) {
      (report as any).preview_data = preview_data;
    }

    // Reset workflow state for resubmission
    (report as any).status = 'pending_approval';
    (report as any).preview_submitted_at = new Date();
    (report as any).approval_requested_at = new Date();
    (report as any).approval_processed_at = undefined;
    await assignReportApprover(report, { userId: (report as any).user });
    (report as any).approval_assignment_email_sent_at = undefined;
    await sendAssignedApprovalEmail(report, {
      reportType: "Real Estate",
      creatorUserId: (report as any).user,
      title: (report as any).preview_data?.property_details?.address || (report as any).property_details?.address,
    });
    (report as any).files_regenerating = true;
    await report.save();

    console.log(`[RealEstate Resubmit] Report ${String((report as any)._id)} resubmitted, queuing file regeneration...`);
    queueRealEstateFilesJob(String((report as any)._id));

    res.status(202).json({
      message: "Report resubmitted successfully! Files are being regenerated.",
      data: {
        reportId: (report as any)._id,
        status: (report as any).status,
        message: "Your report is being processed. You'll receive an email when the admin reviews it.",
      },
    });
  } catch (error) {
    console.error("Error resubmitting report:", error);
    res.status(500).json({ message: "Error resubmitting report", error });
  }
};

/**
 * Get preview data for submitted reports (pending/approved) for editing
 */
export const getSubmittedPreviewData = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const report = await RealEstateReport.findOne({
      _id: id,
      user: req.userId,
    });

    if (!report) {
      return res.status(404).json({ message: "Report not found" });
    }

    if ((report as any).status !== 'pending_approval' && (report as any).status !== 'approved') {
      return res.status(400).json({
        message: `Cannot get preview data for report with status: ${(report as any).status}`,
      });
    }

    const generation = resolveReportGenerationStateForProfile(
      "realEstate",
      report,
      (report as any).preview_files,
      (report as any).files
    );
    const downloadAccess = getReportDownloadAccessForGeneration(report, generation);
    const downloadable = downloadAccess.allowed;

    res.status(200).json({
      message: "Submitted preview data fetched successfully",
      data: {
        status: (report as any).status,
        preview_data: (report as any).preview_data,
        preview_files: downloadable ? (report as any).preview_files : {},
        release_status: releaseStatusForPayload(report),
        release_assigned_to: (report as any).release_assigned_to,
        released_at: (report as any).released_at,
        downloadable,
        download_access: downloadAccess,
        ...generation,
        language: (report as any).language,
        property_type: (report as any).preview_data?.property_type || (report as any).property_type || report.property_details?.property_type || "residential",
        files_generating: Boolean((report as any).files_generating),
        files_regenerating: Boolean((report as any).files_regenerating),
        image_count: Array.isArray((report as any).imageUrls) ? (report as any).imageUrls.length : 0,
        imageUrls: (report as any).imageUrls || [],
        extraImageUrls: (report as any).extraImageUrls || [],
        extra_image_count: Array.isArray((report as any).extraImageUrls) ? (report as any).extraImageUrls.length : 0,
        reportId: (report as any)._id,
        createdAt: (report as any).createdAt,
        preview_submitted_at: (report as any).preview_submitted_at,
        approval_requested_at: (report as any).approval_requested_at,
      },
    });
  } catch (error) {
    console.error("Error fetching submitted preview data:", error);
    res.status(500).json({ message: "Error fetching submitted preview data", error });
  }
};

export const getRealEstateReports = async (req: AuthRequest, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store, private");
    const reports = await RealEstateReport.find({
      user: req.userId,
    }).sort({ createdAt: -1 }).lean();
    const data = reports.map((report: any) => {
      const generation = resolveReportGenerationStateForProfile(
        "realEstate",
        report,
        report.preview_files,
        report.files
      );
      const downloadAccess = getReportDownloadAccessForGeneration(report, generation);
      const downloadable = downloadAccess.allowed;
      return {
        ...report,
        release_status: releaseStatusForPayload(report),
        downloadable,
        download_access: downloadAccess,
        preview_files: downloadable ? report.preview_files : {},
        ...generation,
      };
    });
    res.status(200).json({
      message: "Reports fetched successfully!",
      data: req.query.view === "previews" ? data.map(report => previewQueueSummary(report, "realEstate")) : data,
    });
  } catch (error) {
    console.error("Error fetching real estate reports:", error);
    res.status(500).json({ message: "Error fetching reports", error });
  }
};

/**
 * Get submitted reports (pending_approval and approved) for the user
 */
export const getSubmittedReports = async (req: AuthRequest, res: Response) => {
  try {
    const reports = await RealEstateReport.find({
      user: req.userId,
      status: { $in: ['pending_approval', 'approved'] },
    }).sort({ createdAt: -1 }).lean();
    const data = reports.map((report: any) => {
      const generation = resolveReportGenerationStateForProfile(
        "realEstate",
        report,
        report.preview_files,
        report.files
      );
      const downloadAccess = getReportDownloadAccessForGeneration(report, generation);
      const downloadable = downloadAccess.allowed;
      return {
        ...report,
        release_status: releaseStatusForPayload(report),
        downloadable,
        download_access: downloadAccess,
        preview_files: downloadable ? report.preview_files : {},
        ...generation,
      };
    });

    res.status(200).json({
      message: "Submitted reports fetched successfully",
      data,
    });
  } catch (error) {
    console.error("Error fetching submitted reports:", error);
    res.status(500).json({ message: "Error fetching submitted reports", error });
  }
};

// Multer middleware for handling multiple file fields
export const uploadMiddleware = upload.fields([
  { name: "images", maxCount: 50 },      // Main images for AI analysis
  { name: "extraImages", maxCount: 100 }, // Extra images for report only
  { name: "videos", maxCount: 20 },       // Videos for ZIP only
]);

// Background job variant - NEW PREVIEW WORKFLOW
// Creates report with status='preview' and preview_data for user editing
export const createRealEstateQueued = async (req: AuthRequest, res: Response) => {
  try {
    const details = JSON.parse((req.body as any)?.details || "{}");
    
    // Handle both array and fields format from multer
    const files = req.files as Express.Multer.File[] | { [fieldname: string]: Express.Multer.File[] };
    let images: Express.Multer.File[] = [];
    let extraImages: Express.Multer.File[] = [];
    let videos: Express.Multer.File[] = [];
    
    if (Array.isArray(files)) {
      // Legacy: all files come as single array
      images = files;
    } else if (files && typeof files === "object") {
      // Multer fields format: { images: [...], extraImages: [...], videos: [...] }
      images = files.images || [];
      extraImages = files.extraImages || [];
      videos = files.videos || [];
    }

    const providedId: string | undefined =
      (typeof details?.progress_id === "string" && details.progress_id) ||
      (typeof details?.progressId === "string" && details.progressId) ||
      (typeof details?.job_id === "string" && details.job_id) ||
      undefined;
    const jobId =
      providedId || `cv-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const user = (req as any)?.user;
    
    // Use NEW PREVIEW WORKFLOW - creates report with status='preview'
    queueRealEstatePreviewJob({
      user: { id: String(user?._id), email: String(user?.email || ""), name: (user as any)?.name || (user as any)?.username || undefined },
      images,
      extraImages,
      videos,
      details,
      progressId: jobId,
    });

    res.status(202).json({
      message: "Your real estate report is being processed. You will receive an email when the preview is ready.",
      jobId,
      phase: (getProgress(jobId)?.phase) || "processing",
    });
  } catch (error) {
    console.error("Error queueing real estate job:", error);
    try {
      const details = JSON.parse((req.body as any)?.details || "{}");
      const progressId: string | undefined =
        (typeof details?.progress_id === "string" && details.progress_id) ||
        (typeof details?.progressId === "string" && details.progressId) ||
        (typeof details?.job_id === "string" && details.job_id) ||
        undefined;
      if (progressId) endProgress(progressId, false, "Error processing request");
    } catch {}
    res.status(500).json({ message: "Error processing request", error });
  }
};

/**
 * Get preview data for editing
 */
export const getPreviewData = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    
    const report = await RealEstateReport.findOne({
      _id: id,
      user: req.userId,
    });

    if (!report) {
      return res.status(404).json({ message: "Report not found" });
    }

    // Allow preview for: preview, declined, pending_approval, and approved
    const allowedStatuses = ['preview', 'declined', 'pending_approval', 'approved'];
    if (!allowedStatuses.includes((report as any).status)) {
      return res.status(400).json({
        message: `Cannot preview report with status: ${(report as any).status}`,
      });
    }

    res.status(200).json({
      message: "Preview data fetched successfully",
      data: {
        status: (report as any).status,
        preview_data: (report as any).preview_data,
        language: (report as any).language,
        property_type: (report as any).preview_data?.property_type || (report as any).property_type || report.property_details?.property_type || "residential",
        files_generating: Boolean((report as any).files_generating),
        files_regenerating: Boolean((report as any).files_regenerating),
        image_count: Array.isArray(report.imageUrls) ? report.imageUrls.length : 0,
        imageUrls: report.imageUrls || [],
        extraImageUrls: (report as any).extraImageUrls || [],
        extra_image_count: Array.isArray((report as any).extraImageUrls) ? (report as any).extraImageUrls.length : 0,
        decline_reason: (report as any).decline_reason,
        reportId: report._id,
      },
    });
  } catch (error) {
    console.error("Error fetching preview data:", error);
    res.status(500).json({ message: "Error fetching preview data", error });
  }
};

/**
 * Update preview data with user edits
 */
export const updatePreviewData = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { preview_data } = req.body;

    if (!preview_data) {
      return res.status(400).json({ message: "preview_data is required" });
    }

    const report = await RealEstateReport.findOne({
      _id: id,
      user: req.userId,
    });

    if (!report) {
      return res.status(404).json({ message: "Report not found" });
    }

    // Allow updates for: preview, declined, pending_approval, and approved
    const allowedStatuses = ['preview', 'declined', 'pending_approval', 'approved'];
    if (!allowedStatuses.includes((report as any).status)) {
      return res.status(400).json({
        message: `Cannot update report with status: ${(report as any).status}`,
      });
    }

    // Update preview data
    (report as any).preview_data = preview_data;
    await report.save();

    res.status(200).json({
      message: "Preview data updated successfully",
      data: (report as any).preview_data,
    });
  } catch (error) {
    console.error("Error updating preview data:", error);
    res.status(500).json({ message: "Error updating preview data", error });
  }
};

/**
 * Submit report for admin approval
 */
export const submitForApproval = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const report = await RealEstateReport.findOne({
      _id: id,
      user: req.userId,
    }).populate('user');

    if (!report) {
      return res.status(404).json({ message: "Report not found" });
    }

    // Only allow submission from preview or declined status
    if ((report as any).status !== 'preview' && (report as any).status !== 'declined') {
      return res.status(400).json({ 
        message: `Cannot submit report with status: ${(report as any).status}` 
      });
    }

    // Validate preview_data exists
    if (!(report as any).preview_data) {
      return res.status(400).json({ 
        message: "Preview data is missing. Please review the report first." 
      });
    }

    // Mark that files are being generated, but keep status as 'preview'
    // Status will only change to 'pending_approval' AFTER all files are generated
    // This ensures admin approval page only shows reports with ready files
    (report as any).files_generating = true;
    (report as any).preview_submitted_at = new Date();
    await report.save();

    // Queue background job to generate preview files
    // Job will set status='pending_approval' and send emails ONLY after all files are ready
    queueRealEstateFilesJob(String(report._id));

    res.status(202).json({
      message: "Report submitted for approval successfully! Files are being generated.",
      data: {
        reportId: report._id,
        status: (report as any).status,
        message: "Your report is being processed. You'll receive an email when the admin reviews it."
      },
    });
  } catch (error) {
    console.error("Error submitting for approval:", error);
    res.status(500).json({ message: "Error submitting for approval", error });
  }
};

/**
 * Approve report (Admin only)
 */
export const approveReport = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    // Check admin role
    const user = (req as any).user;
    if (user.role !== 'admin' && user.role !== 'superadmin' && !user.isAdmin) {
      return res.status(403).json({ message: "Access denied. Admin only." });
    }

    let report = await RealEstateReport.findById(id).populate('user');

    if (!report) {
      return res.status(404).json({ message: "Report not found" });
    }

    if (!canProcessAssignedApproval(report, user)) {
      return res.status(403).json({ message: assignedApprovalDeniedMessage() });
    }
    if (report.status === "approved") {
      return res.status(200).json({
        message: "Report was already approved",
        already_processed: true,
        data: { reportId: report._id, status: report.status, already_processed: true },
      });
    }
    if (report.status !== "pending_approval") {
      return res.status(409).json({
        code: "REPORT_APPROVAL_DECISION_CONFLICT",
        message: `Cannot approve report with status: ${report.status}`,
      });
    }
    assertReportFilesReadyForWorkflow("realEstate", report);

    // Both Real Estate approval routes claim the same transition. Release fields
    // are persisted atomically with approval, before any external notification.
    markReportAutoReleased(report, { releasedBy: user._id });
    const decision = await claimReportApprovalDecision({
      model: RealEstateReport,
      report,
      pendingStatus: "pending_approval",
      targetStatus: "approved",
      set: { approval_processed_at: new Date(), ...releaseFieldsForApprovalDecision(report) },
      unset: { decline_reason: 1 },
      populate: "user",
    });
    report = decision.report as NonNullable<typeof report>;
    if (!decision.claimed) {
      return res.status(200).json({
        message: "Report was already approved",
        already_processed: true,
        data: { reportId: report._id, status: report.status, already_processed: true },
      });
    }
    const reportUser = report.user as any;

    // Send approval email
    const webUrl = process.env.WEB_APP_URL || "http://localhost:3000";
    const subject = "Your Real Estate Report Has Been Approved";
    const html = `
      <div style="font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;line-height:1.6;color:#111">
        <h2 style="margin:0 0 12px;color:#059669">Report Approved!</h2>
        <p>Hello${reportUser?.name ? ` ${reportUser.name}` : ""},</p>
        <p>Your real estate report has been approved and is now ready to download.</p>
        <p><a href="${webUrl}/reports" style="display:inline-block;background:#059669;color:#fff;padding:10px 14px;border-radius:6px;text-decoration:none">Download Reports</a></p>
        <hr style="border:none;border-top:1px solid #eee;margin:16px 0" />
        <p style="font-size:12px;color:#777">Asset Insight</p>
      </div>
    `;
    if (reportUser?.email) {
      try {
        await sendEmail(reportUser.email, subject, html);
      } catch (emailError) {
        console.error("realEstate approveReport email error", emailError);
      }
    }

    await notifyUser({
      userId: String(reportUser?._id || report?.user || ""),
      category: "report",
      type: "report_approved",
      title: "Report Approved",
      body: "Your real estate report has been approved and is ready for download.",
      data: {
        type: "report_approved",
        reportId: String(report._id),
        reportType: "RealEstate",
      },
    }).catch((pushErr) => {
      console.error("realEstate approveReport notification error", pushErr);
    });

    res.status(200).json({
      message: "Report approved successfully.",
      data: {
        reportId: report._id,
        status: (report as any).status,
      },
    });
  } catch (error: any) {
    if (Number(error?.statusCode) === 409) {
      return res.status(409).json({
        code: error?.code,
        message: error?.message || "Report files are not ready for approval",
      });
    }
    console.error("Error approving report:", error);
    res.status(500).json({ message: "Error approving report", error });
  }
};

/**
 * Decline report (Admin only)
 */
export const declineReport = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    // Check admin role
    const user = (req as any).user;
    if (user.role !== 'admin' && user.role !== 'superadmin' && !user.isAdmin) {
      return res.status(403).json({ message: "Access denied. Admin only." });
    }

    if (typeof reason !== "string" || reason.trim().length < 10) {
      return res.status(400).json({ 
        message: "Decline reason is required (minimum 10 characters)" 
      });
    }

    let report = await RealEstateReport.findById(id).populate('user');

    if (!report) {
      return res.status(404).json({ message: "Report not found" });
    }

    if (!canProcessAssignedApproval(report, user)) {
      return res.status(403).json({ message: assignedApprovalDeniedMessage() });
    }
    if (report.status === "declined") {
      return res.status(200).json({
        message: "Report was already declined",
        already_processed: true,
        data: {
          reportId: report._id,
          status: report.status,
          decline_reason: report.decline_reason,
          already_processed: true,
        },
      });
    }
    if (report.status !== "pending_approval") {
      return res.status(409).json({
        code: "REPORT_APPROVAL_DECISION_CONFLICT",
        message: `Cannot decline report with status: ${report.status}`,
      });
    }

    // Share the same atomic decision gate with both approval routes. Only the
    // winner sends notifications; a stale decline cannot overwrite approval.
    const decision = await claimReportApprovalDecision({
      model: RealEstateReport,
      report,
      pendingStatus: "pending_approval",
      targetStatus: "declined",
      set: { decline_reason: reason.trim(), approval_processed_at: new Date() },
      populate: "user",
    });
    report = decision.report as NonNullable<typeof report>;
    if (!decision.claimed) {
      return res.status(200).json({
        message: "Report was already declined",
        already_processed: true,
        data: {
          reportId: report._id,
          status: report.status,
          decline_reason: report.decline_reason,
          already_processed: true,
        },
      });
    }

    // Send decline email
    const reportUser = report.user as any;
    const webUrl = process.env.WEB_APP_URL || "http://localhost:3000";
    const subject = "Your Real Estate Report Requires Revision";
    const html = `
      <div style="font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;line-height:1.6;color:#111">
        <h2 style="margin:0 0 12px;color:#e11d48">Report Requires Revision</h2>
        <p>Hello${reportUser?.name ? ` ${reportUser.name}` : ""},</p>
        <p>Your real estate report has been reviewed and requires some revisions before approval.</p>
        <p><strong>Reason:</strong></p>
        <blockquote style="border-left:3px solid #e11d48;padding-left:12px;margin:12px 0;color:#555">${reason}</blockquote>
        <p>Please review and update your report, then resubmit for approval.</p>
        <p><a href="${webUrl}/real-estate/preview/${report._id}" style="display:inline-block;background:#e11d48;color:#fff;padding:10px 14px;border-radius:6px;text-decoration:none">Edit & Resubmit</a></p>
        <hr style="border:none;border-top:1px solid #eee;margin:16px 0" />
        <p style="font-size:12px;color:#777">Asset Insight</p>
      </div>
    `;
    if (reportUser?.email) {
      try {
        await sendEmail(reportUser.email, subject, html);
      } catch (emailError) {
        console.error("realEstate declineReport email error", emailError);
      }
    }

    await notifyUser({
      userId: String(reportUser?._id || report?.user || ""),
      category: "report",
      type: "report_declined",
      title: "Report Requires Revision",
      body: "Your real estate report was declined. Review the notes and resubmit it.",
      data: {
        type: "report_declined",
        reportId: String(report._id),
        reportType: "RealEstate",
      },
    }).catch((pushErr) => {
      console.error("realEstate declineReport notification error", pushErr);
    });

    res.status(200).json({
      message: "Report declined successfully",
      data: {
        reportId: report._id,
        status: (report as any).status,
        decline_reason: (report as any).decline_reason,
      },
    });
  } catch (error: any) {
    if (Number(error?.statusCode) === 409) {
      return res.status(409).json({
        code: error?.code,
        message: error?.message || "Report changed before the decline was saved",
      });
    }
    console.error("Error declining report:", error);
    res.status(500).json({ message: "Error declining report", error });
  }
};

/**
 * Get reports pending approval (Admin only)
 */
export const getPendingReports = async (req: AuthRequest, res: Response) => {
  try {
    const user = (req as any).user;
    if (user.role !== 'admin' && user.role !== 'superadmin' && !user.isAdmin) {
      return res.status(403).json({ message: "Access denied. Admin only." });
    }

    const reports = await RealEstateReport.find(
      mergeApprovalScope({ status: 'pending_approval' }, user)
    )
      .populate('user', 'name email username')
      .populate(approvalAssignedPopulatePath())
      .sort({ approval_requested_at: -1 });

    res.status(200).json({
      message: "Pending reports fetched successfully",
      data: reports.map((r: any) => ({
        _id: r._id,
        property_address: r.property_details?.address,
        property_type: r.property_type,
        language: r.language,
        user: {
          name: r.user?.name || r.user?.username,
          email: r.user?.email,
        },
        approval_requested_at: r.approval_requested_at,
        approval_assigned_to: r.approval_assigned_to || null,
        preview_files: r.preview_files,
      })),
    });
  } catch (error) {
    console.error("Error fetching pending reports:", error);
    res.status(500).json({ message: "Error fetching pending reports", error });
  }
};

export const getRealEstateProgress = async (req: AuthRequest, res: Response) => {
  try {
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ message: "Missing progress id" });
    }
    const rec = getProgress(id);
    if (!rec) {
      return res.status(404).json({ message: "Not found" });
    }
    res.status(200).json({
      id: rec.id,
      phase: rec.phase,
      serverProgress01: rec.serverProgress01,
      steps: rec.steps,
      message: rec.message,
    });
  } catch (error) {
    res.status(500).json({ message: "Error fetching progress", error });
  }
};

/**
 * Get all approved real estate reports with images (for gallery)
 */
export const getAllApprovedReports = async (req: AuthRequest, res: Response) => {
  try {
    const reports = await RealEstateReport.find({ status: 'approved', ...(req.user?.isReviewAccount === true ? { user: req.userId } : await productionReportOwnerFilter()) })
      .populate("user", "email username name")
      .select("_id property_details preview_data imageUrls createdAt user property_type")
      .sort({ createdAt: -1 })
      .limit(500);

    res.status(200).json({
      reports: reports.map((r: any) => ({
        _id: r._id,
        address: r.preview_data?.property_details?.address || r.property_details?.address,
        property_type: r.property_type,
        imageUrls: r.imageUrls || [],
        createdAt: r.createdAt,
        user: r.user,
      })),
    });
  } catch (error) {
    console.error("Error fetching approved reports:", error);
    res.status(500).json({ message: "Error fetching approved reports", error });
  }
};

/**
 * Delete a real estate report (user can only delete their own reports)
 */
export const deleteRealEstateReport = async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;

    const report = await RealEstateReport.findOne({
      _id: id,
      user: req.userId,
    });

    if (!report) {
      return res.status(404).json({ message: "Report not found" });
    }

    // Delete the report
    await RealEstateReport.deleteOne({ _id: id });

    res.status(200).json({
      message: "Report deleted successfully",
      data: { reportId: id },
    });
  } catch (error) {
    console.error("Error deleting real estate report:", error);
    res.status(500).json({ message: "Error deleting report", error });
  }
};
