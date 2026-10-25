/**
 * Real Estate DOCX Generation Service
 *
 * Flow (matches Asset DOCX flow):
 * 1. Generate custom cover page from template (public/CoverPage.docx)
 * 2. Generate main report content (TOC, transmittal, certificate, 60+ pages)
 * 3. Fetch appraiser CV (if available)
 * 4. Merge all documents: Cover -> Main Report -> CV Divider -> CV
 *
 * Features:
 * - Same cover page template as Asset reports
 * - Clean page breaks throughout
 * - Red + light professional theme
 * - All CUSPAP-compliant sections
 * - Uses GroupDocs Merger API for reliable document merging
 */
import { generateRealEstateDocx } from "./docx/realEstateDocxBuilder.js";
import { clearImageCache } from "./docx/builders/utils.js";
import { mergeDocuments } from "./assetDocxService.js";
import {
  createErrorWithCause,
  summarizeError,
} from "../utils/errorSummary.js";
import { shouldUseGroupDocsMerge } from "../utils/docxMergeMode.js";
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";
import axios from "axios";
import fs from "fs/promises";
import path from "path";

/**
 * Generate complete Real Estate DOCX report
 * Uses same cover template and merge flow as Asset reports
 */
export async function generateRealEstateDocxFromReport(
  reportData: any
): Promise<Buffer> {
  try {
    console.log("[RealEstateDOCX] Starting report generation");

    if (shouldUseGroupDocsMerge()) {
      try {
        return await generateRealEstateDocxWithGroupDocs(reportData);
      } catch (cloudError) {
        console.warn(
          "[RealEstateDOCX] Cloud merge unavailable; using local single-document fallback",
          summarizeError(cloudError)
        );
      }
    }

    const localBuffer = await generateRealEstateDocx({
      ...reportData,
      custom_cover: false,
    });
    console.log(
      `[RealEstateDOCX] Local document generated (${localBuffer.length} bytes)`
    );
    return localBuffer;
  } catch (error) {
    console.error(
      "[RealEstateDOCX] Report generation failed",
      summarizeError(error)
    );
    throw createErrorWithCause(
      "Failed to generate Real Estate DOCX report",
      error
    );
  } finally {
    clearImageCache();
  }
}

async function generateRealEstateDocxWithGroupDocs(
  reportData: any
): Promise<Buffer> {
  const coverBuffer = await generateCoverPage(reportData);
  const mainBuffer = await generateRealEstateDocx({
    ...reportData,
    custom_cover: true,
  });
  const cvBuffer = await fetchAppraiserCV(reportData.user_cv_url);
  const finalBuffer = await mergeDocuments(coverBuffer, mainBuffer, cvBuffer);
  console.log(
    `[RealEstateDOCX] Cloud-merged document generated (${finalBuffer.length} bytes)`
  );
  return finalBuffer;
}

/**
 * Generate custom cover page from template (same as Asset service)
 */
async function generateCoverPage(reportData: any): Promise<Buffer> {
  try {
    const candidates = [
      path.resolve(process.cwd(), "public/CoverPage.docx"),
      path.resolve(process.cwd(), "server/public/CoverPage.docx"),
    ];

    let templatePath: string | null = null;
    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        templatePath = candidate;
        break;
      } catch {}
    }

    if (!templatePath) {
      throw new Error(
        `CoverPage.docx not found. Checked paths: ${candidates.join(", ")}`
      );
    }

    const templateBuffer = await fs.readFile(templatePath);

    const zip = new PizZip(templateBuffer);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
    });

    // Prepare template data for Real Estate
    const clientName =
      reportData.owner_name ||
      reportData.client_name ||
      reportData.prepared_for ||
      "";
    const propertyAddress =
      reportData.address ||
      reportData.property_address ||
      reportData.property_details?.address ||
      "";

    const effectiveDate = formatReportDate(
      reportData.effective_date || reportData.report_dates?.effective_date
    );
    const reportDate = formatReportDate(
      reportData.createdAt ||
        reportData.report_date ||
        reportData.report_dates?.report_date ||
        reportData.effective_date
    );
    const userEmail = reportData.user_email || "";

    // Render template with data
    doc.render({
      CompanyName: clientName,
      EffectiveDate: effectiveDate,
      ReportDate: reportDate,
      PropertyAddress: propertyAddress,
      // Legacy/Fallback fields
      preparedFor: clientName,
      clientName: clientName,
      reportDate,
      userEmail,
    });

    // Generate buffer
    const buffer = doc.toBuffer
      ? doc.toBuffer()
      : Buffer.from(doc.getZip().generate({ type: "nodebuffer" }));

    console.log("✅ Custom cover page generated for Real Estate report");
    return buffer;
  } catch (error) {
    console.error("❌ Cover page generation failed:", error);
    throw new Error(
      "Failed to generate cover page. Ensure public/CoverPage.docx exists."
    );
  }
}

/**
 * Fetch appraiser CV from URL
 */
async function fetchAppraiserCV(cvUrl?: string): Promise<Buffer | null> {
  if (!cvUrl || typeof cvUrl !== "string") {
    return null;
  }

  try {
    const response = await axios.get<ArrayBuffer>(cvUrl, {
      responseType: "arraybuffer",
      timeout: 10000,
    });

    const cvBuffer = Buffer.from(response.data);
    if (cvBuffer.length === 0) {
      console.warn("⚠️  CV file is empty");
      return null;
    }

    console.log("✅ Appraiser CV fetched successfully");
    return cvBuffer;
  } catch (error) {
    console.warn("⚠️  Failed to fetch appraiser CV:", error);
    return null;
  }
}

/**
 * Format report date for cover page
 */
function formatReportDate(date?: string | Date): string {
  try {
    const dt = date ? new Date(date) : new Date();
    return dt.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
