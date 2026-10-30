/**
 * Orchestrates asset DOCX assembly across local builders, optional CV content, and the
 * document-merging provider. Temporary provider uploads are intermediate artifacts;
 * callers receive a single buffer and cleanup/error wrapping is kept inside this
 * boundary so report workflows do not depend on GroupDocs mechanics.
 */
import { generateMixedDocx } from "./docx/mixedDocxBuilder.js";
import { projectAssetAppraisalValues } from "./assetAppraisalValueProjectionService.js";
import { createSimpleHeadingDocx, prefetchImages, clearImageCache } from "./docx/builders/utils.js";
import {
  buildNeutralCoverPhoto,
  COVER_TEMPLATE_PHOTO_SLOTS,
  hasExplicitCoverPhotoSelection,
  loadCoverPhotoBuffers,
  prepareCoverPhoto,
  resolveCoverPhotoSlotSources,
} from "./docx/builders/coverPhotos.js";
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
import { randomUUID } from "crypto";
import {
  DocumentApi,
  FileApi,
  JoinItem,
  JoinOptions,
  JoinRequest,
  FileInfo,
  UploadFileRequest,
  DownloadFileRequest,
  DeleteFileRequest,
} from "groupdocs-merger-cloud";

/**
 * Production-ready DOCX generation service
 *
 * Flow:
 * 1. Generate custom cover page from template (public/coverPage.docx)
 * 2. Generate main report content (using mixedDocxBuilder)
 * 3. Fetch appraiser CV (if available)
 * 4. Merge all documents: Cover -> Main Report -> CV Divider -> CV
 *
 * Features:
 * - Always merges custom cover page
 * - Preserves headers/footers in main document
 * - Appends appraiser CV at the end
 * - Uses GroupDocs cloud merge for reliable merging
 */

/**
 * Collect all image URLs from report data for pre-fetching
 */
function collectAllImageUrls(reportData: any): string[] {
  const urls = new Set<string>();
  
  // Root image URLs
  if (Array.isArray(reportData?.imageUrls)) {
    for (const url of reportData.imageUrls) {
      if (typeof url === 'string' && url) urls.add(url);
    }
  }
  
  // Lot images
  const lots: any[] = Array.isArray(reportData?.lots) ? reportData.lots : [];
  for (const lot of lots) {
    // Main image
    if (typeof lot?.image_url === 'string' && lot.image_url) {
      urls.add(lot.image_url);
    }
    
    // Image URLs array
    if (Array.isArray(lot?.image_urls)) {
      for (const url of lot.image_urls) {
        if (typeof url === 'string' && url) urls.add(url);
      }
    }
    
    // Extra image URLs
    if (Array.isArray(lot?.extra_image_urls)) {
      for (const url of lot.extra_image_urls) {
        if (typeof url === 'string' && url) urls.add(url);
      }
    }
    
    // Items within lot
    if (Array.isArray(lot?.items)) {
      for (const item of lot.items) {
        if (typeof item?.image_url === 'string' && item.image_url) {
          urls.add(item.image_url);
        }
      }
    }
  }
  
  return [...urls];
}

export async function generateAssetDocxFromReport(
  reportData: any
): Promise<Buffer> {
  reportData = projectAssetAppraisalValues(reportData);
  try {
    console.log("[AssetDOCX] Starting report generation");

    // Step 0: Pre-fetch all images in parallel (major speed improvement for large reports)
    console.log("[AssetDOCX] Pre-fetching images");
    const allImageUrls = collectAllImageUrls(reportData);
    if (allImageUrls.length > 0) {
      await prefetchImages(allImageUrls);
      console.log(`[AssetDOCX] Pre-fetched ${allImageUrls.length} images`);
    }

    if (shouldUseGroupDocsMerge()) {
      try {
        return await generateAssetDocxWithGroupDocs(reportData);
      } catch (cloudError) {
        console.warn(
          "[AssetDOCX] Cloud merge unavailable; using local single-document fallback",
          summarizeError(cloudError)
        );
      }
    }

    const localBuffer = await generateMixedDocx({
      ...reportData,
      custom_cover: false,
    });
    console.log(
      `[AssetDOCX] Local document generated (${localBuffer.length} bytes)`
    );
    return localBuffer;
  } catch (error) {
    console.error(
      "[AssetDOCX] Report generation failed",
      summarizeError(error)
    );
    throw createErrorWithCause("Failed to generate Asset DOCX report", error);
  } finally {
    clearImageCache();
  }
}

async function generateAssetDocxWithGroupDocs(reportData: any): Promise<Buffer> {
  console.log("[AssetDOCX] Generating custom cover for cloud merge");
  const coverBuffer = await generateCoverPage(reportData);
  const mainBuffer = await generateMixedDocx({
    ...reportData,
    custom_cover: true,
  });
  const cvBuffer = await fetchAppraiserCV(reportData.user_cv_url);
  const finalBuffer = await mergeDocuments(coverBuffer, mainBuffer, cvBuffer);
  console.log(
    `[AssetDOCX] Cloud-merged document generated (${finalBuffer.length} bytes)`
  );
  return finalBuffer;
}

/**
 * Generate custom cover page from template
 */
export async function generateCoverPage(reportData: any): Promise<Buffer> {
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

    // Prepare template data
    // Company Name (Mapped to Client Name per user request)
    const companyName =
      reportData.client_name ||
      reportData.prepared_for ||
      reportData.company_name ||
      reportData.customer_name ||
      "Client";

    // Client Name (Prepared For)
    const clientName = companyName;
    const preparedBy =
      reportData.prepared_by ||
      reportData.preparedBy ||
      reportData.appraisal_company ||
      "McDougall Auctioneers";

    const effectiveDate = formatReportDate(reportData.effective_date);
    const reportDate = formatReportDate(
      reportData.createdAt ||
        reportData.report_date ||
        reportData.effective_date
    );
    const userEmail = reportData.user_email || "";

    // Render template with data
    // {CompanyName}, {EffectiveDate}, {ReportDate}
    doc.render({
      CompanyName: companyName,
      EffectiveDate: effectiveDate,
      ReportDate: reportDate,
      // Legacy/Fallback fields
      preparedFor: clientName,
      clientName: clientName,
      reportDate,
      userEmail,
      preparedBy,
      PreparedBy: preparedBy,
    });

    const renderedZip = doc.getZip();
    applyCoverPageLiteralTextFallbacks(renderedZip, {
      companyName,
      effectiveDate,
      preparedBy,
    });
    const coverPhotos = await loadCoverPhotoBuffers(reportData);
    const coverPhotoSources = resolveCoverPhotoSlotSources(
      coverPhotos,
      COVER_TEMPLATE_PHOTO_SLOTS.length,
      !hasExplicitCoverPhotoSelection(reportData)
    );
    for (let index = 0; index < COVER_TEMPLATE_PHOTO_SLOTS.length; index += 1) {
      const slot = COVER_TEMPLATE_PHOTO_SLOTS[index];
      const source =
        coverPhotoSources[index] ??
        (await buildNeutralCoverPhoto(slot.width, slot.height));
      renderedZip.file(
        slot.path,
        await prepareCoverPhoto(source, slot.width, slot.height)
      );
    }

    // Generate buffer
    const buffer = Buffer.from(renderedZip.generate({ type: "nodebuffer" }));

    console.log("✅ Custom cover page generated");
    return buffer;
  } catch (error) {
    console.error("❌ Cover page generation failed:", error);
    throw new Error(
      "Failed to generate cover page. Ensure public/coverPage.docx exists."
    );
  }
}

function escapeXmlText(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function decodeXmlText(value: string): string {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function replacePlainTextAcrossWordRuns(xml: string, search: string, replacement: string): string {
  if (!search || !xml.includes("<w:t")) return xml;

  const textNodeRegex = /<w:t([^>]*)>([\s\S]*?)<\/w:t>/g;
  const nodes: Array<{
    start: number;
    end: number;
    attrs: string;
    text: string;
    plainStart: number;
    plainEnd: number;
  }> = [];
  let plain = "";
  let match: RegExpExecArray | null;

  while ((match = textNodeRegex.exec(xml))) {
    const text = decodeXmlText(match[2]);
    nodes.push({
      start: match.index,
      end: match.index + match[0].length,
      attrs: match[1],
      text,
      plainStart: plain.length,
      plainEnd: plain.length + text.length,
    });
    plain += text;
  }

  const matchStart = plain.indexOf(search);
  if (matchStart < 0) return xml;
  const matchEnd = matchStart + search.length;
  const affected = nodes.filter((node) => node.plainEnd > matchStart && node.plainStart < matchEnd);
  if (!affected.length) return xml;

  const updates = new Map<number, string>();
  for (let i = 0; i < affected.length; i += 1) {
    const node = affected[i];
    const localStart = Math.max(0, matchStart - node.plainStart);
    const localEnd = Math.min(node.text.length, matchEnd - node.plainStart);
    const prefix = node.text.slice(0, localStart);
    const suffix = node.text.slice(localEnd);
    const nextText = i === 0 ? `${prefix}${replacement}${suffix}` : `${prefix}${suffix}`;
    updates.set(node.start, `<w:t${node.attrs}>${escapeXmlText(nextText)}</w:t>`);
  }

  let nextXml = "";
  let cursor = 0;
  for (const node of nodes) {
    nextXml += xml.slice(cursor, node.start);
    nextXml += updates.get(node.start) || xml.slice(node.start, node.end);
    cursor = node.end;
  }
  nextXml += xml.slice(cursor);
  return nextXml;
}

function applyCoverPageLiteralTextFallbacks(
  zip: PizZip,
  data: { companyName: string; effectiveDate: string; preparedBy: string }
) {
  const documentPath = "word/document.xml";
  const documentFile = zip.file(documentPath);
  if (!documentFile) return;

  let xml = documentFile.asText();
  const replacements = [
    {
      search: "Effective Date: Day, Month, Year",
      value: `Effective Date: ${data.effectiveDate}`,
    },
    {
      search: "Prepared for XYZ Corp",
      value: `Prepared for ${data.companyName}`,
    },
    {
      search: "By McDougall Auctioneers",
      value: `By ${data.preparedBy}`,
    },
  ];

  for (const replacement of replacements) {
    xml = replacePlainTextAcrossWordRuns(xml, replacement.search, replacement.value);
  }
  zip.file(documentPath, xml);
}

/**
 * Fetch appraiser CV from URL updates
 */
async function fetchAppraiserCV(cvUrl?: string): Promise<Buffer | null> {
  if (!cvUrl || typeof cvUrl !== "string") {
    return null;
  }

  try {
    const response = await axios.get<ArrayBuffer>(cvUrl, {
      responseType: "arraybuffer",
      timeout: 10000, // 10 second timeout
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
 * Upload Buffer to Cloud storage
 */
async function upload(fileApi: FileApi, buffer: Buffer, name: string) {
  const req = new UploadFileRequest(name, buffer, undefined);
  await fileApi.uploadFile(req);
}

export async function mergeDocuments(
  coverBuffer: Buffer,
  mainBuffer: Buffer,
  cvBuffer: Buffer | null
): Promise<Buffer> {
  const appSid = process.env.GROUPDOCS_CLIENT_ID;
  const appKey = process.env.GROUPDOCS_CLIENT_SECRET;
  if (!appSid || !appKey) {
    throw new Error("GroupDocs credentials are not configured");
  }

  const documentApi = DocumentApi.fromKeys(appSid, appKey);
  const fileApi = FileApi.fromKeys(appSid, appKey);
  const prefix = `report-merge-${randomUUID()}`;
  const paths = {
    cover: `${prefix}-cover.docx`,
    main: `${prefix}-main.docx`,
    divider: `${prefix}-divider.docx`,
    cv: `${prefix}-cv.docx`,
    merged: `${prefix}-merged.docx`,
  };
  const uploadedPaths: string[] = [];

  try {
    await upload(fileApi, coverBuffer, paths.cover);
    uploadedPaths.push(paths.cover);
    await upload(fileApi, mainBuffer, paths.main);
    uploadedPaths.push(paths.main);

    const joinItems: JoinItem[] = [
      new JoinItem({ fileInfo: new FileInfo({ filePath: paths.cover }) }),
      new JoinItem({ fileInfo: new FileInfo({ filePath: paths.main }) }),
    ];

    if (cvBuffer) {
      const divider = await createSimpleHeadingDocx("Appraiser CV");
      await upload(fileApi, divider, paths.divider);
      uploadedPaths.push(paths.divider);
      await upload(fileApi, cvBuffer, paths.cv);
      uploadedPaths.push(paths.cv);

      joinItems.push(
        new JoinItem({ fileInfo: new FileInfo({ filePath: paths.divider }) }),
        new JoinItem({ fileInfo: new FileInfo({ filePath: paths.cv }) })
      );
    }

    const joinOptions = new JoinOptions({
      joinItems,
      outputPath: paths.merged,
    });
    await documentApi.join(new JoinRequest(joinOptions));
    uploadedPaths.push(paths.merged);

    return await fileApi.downloadFile(new DownloadFileRequest(paths.merged));
  } finally {
    const cleanupResults = await Promise.allSettled(
      uploadedPaths.map((filePath) =>
        fileApi.deleteFile(new DeleteFileRequest(filePath))
      )
    );
    const failedCleanupCount = cleanupResults.filter(
      (result) => result.status === "rejected"
    ).length;
    if (failedCleanupCount > 0) {
      console.warn(
        `[AssetDOCX] Could not remove ${failedCleanupCount} temporary cloud file(s)`
      );
    }
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
