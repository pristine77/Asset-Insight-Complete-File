import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { loadSalvageAppendixImage, loadSalvageAppendixPdf, SALVAGE_APPENDIX_LIMITS } from "./salvageAppendixPages.js";
import { SALVAGE_UNIT_APPRAISAL_FIELDS } from "./salvageAppraisalFields.js";

type Json = Record<string, any>;
export type SalvageExportPage = { buffer: Buffer; width: number; height: number; type?: "png" | "jpg" };
export type SalvageExportAttachment = { title: string; url: string; note: string; pages: SalvageExportPage[] };
export type SalvageExportAttachments = { signature?: SalvageExportPage; cv?: SalvageExportAttachment; appendices: SalvageExportAttachment[] };
const exec = promisify(execFile);

/** Old single-unit files keep their established editable layout and worksheets. */
export function hasSalvageAppraisalFields(report: Json): boolean {
  return Boolean(report.additional_units?.length || report.appendices?.length || report.appraiser_profile
    || ["report_number", "cause_of_loss_comments", "follow_up", ...SALVAGE_UNIT_APPRAISAL_FIELDS]
      .some((key) => Object.prototype.hasOwnProperty.call(report, key)));
}

async function imagePage(dataUri: string): Promise<SalvageExportPage> {
  const buffer = Buffer.from(dataUri.slice(dataUri.indexOf(",") + 1), "base64");
  const { width, height } = await sharp(buffer).metadata();
  if (!width || !height) throw new Error("An attached image has no dimensions.");
  return { buffer, width, height, type: "png" };
}

/**
 * Word and Excel cannot display embedded PDF pages. Rasterize only uploaded
 * attachments with Poppler, preserving every source page and its own rotation.
 * The appraisal itself is always native editable text, tables and numbers.
 * Inputs come from the bounded, validated server-owned attachment loader.
 */
export async function rasterSalvageAttachmentPdf(bytes: Buffer, pageCount: number): Promise<SalvageExportPage[]> {
  if (bytes.length > SALVAGE_APPENDIX_LIMITS.bytes || !Number.isInteger(pageCount) || pageCount < 1 || pageCount > SALVAGE_APPENDIX_LIMITS.pagesPerDocument) {
    throw new Error("An attached PDF exceeds the supported document limits.");
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "salvage-attachment-pages-"));
  try {
    const source = path.join(dir, "source.pdf");
    await fs.writeFile(source, bytes);
    try {
      await exec("pdftoppm", ["-png", "-scale-to", "1600", "-f", "1", "-l", String(pageCount), source, path.join(dir, "page")], {
        timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true,
      });
    } catch {
      throw new Error("An attached PDF could not be prepared for Word and Excel. Retry report generation; the original is retained.");
    }
    const files = (await fs.readdir(dir)).filter((name) => /^page-\d+\.png$/.test(name))
      .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
    if (files.length !== pageCount) throw new Error("An attached PDF did not produce all its pages; no partial document was generated.");
    const pages: SalvageExportPage[] = [];
    for (const file of files) {
      if ((await fs.stat(path.join(dir, file))).size > 16 * 1024 * 1024) throw new Error("An attached PDF page is too large.");
      const sourceBuffer = await fs.readFile(path.join(dir, file));
      const { width, height } = await sharp(sourceBuffer, { limitInputPixels: 1600 * 1600 }).metadata();
      if (!width || !height || width > 1600 || height > 1600) throw new Error("An attached PDF page could not be prepared.");
      const buffer = await sharp(sourceBuffer, { limitInputPixels: 1600 * 1600 }).jpeg({ quality: 85 }).toBuffer();
      pages.push({ buffer, width, height, type: "jpg" });
    }
    return pages;
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

export async function prepareSalvageExportAttachments(report: Json): Promise<SalvageExportAttachments> {
  const profile = report.appraiser_profile || {};
  const result: SalvageExportAttachments = { appendices: [] };
  let totalBytes = 0;
  const retain = (pages: SalvageExportPage[]) => {
    totalBytes += pages.reduce((total, page) => total + page.buffer.length, 0);
    if (totalBytes > 256 * 1024 * 1024) throw new Error("Prepared report attachments exceed 256 MB. The originals are retained; reduce the attached documents before retrying.");
    return pages;
  };
  if (profile.signatureUrl) result.signature = await imagePage(await loadSalvageAppendixImage(profile.signatureUrl, "The appraiser's signature", { png: true, maxSide: 900 }));
  if (profile.cvUrl) {
    const loaded = await loadSalvageAppendixPdf(profile.cvUrl, "The appraiser's CV");
    result.cv = { title: "Appraiser Profile", url: profile.cvUrl, note: "", pages: retain(await rasterSalvageAttachmentPdf(loaded.bytes, loaded.pageCount)) };
  }
  let totalPages = 0;
  for (const [index, attachment] of (report.appendices || []).entries()) {
    const title = `Appendix ${String.fromCharCode(65 + index)} — ${String(attachment.title || "Attachment")}`;
    let pages: SalvageExportPage[];
    if (attachment.kind === "image") pages = [await imagePage(await loadSalvageAppendixImage(attachment.url, title, { png: true }))];
    else {
      const loaded = await loadSalvageAppendixPdf(attachment.url, title);
      totalPages += loaded.pageCount;
      if (totalPages > SALVAGE_APPENDIX_LIMITS.totalPages) throw new Error(`The appendices exceed ${SALVAGE_APPENDIX_LIMITS.totalPages} pages.`);
      pages = await rasterSalvageAttachmentPdf(loaded.bytes, loaded.pageCount);
    }
    if (attachment.kind === "image") totalPages++;
    if (totalPages > SALVAGE_APPENDIX_LIMITS.totalPages) throw new Error(`The appendices exceed ${SALVAGE_APPENDIX_LIMITS.totalPages} pages.`);
    result.appendices.push({ title, url: attachment.url, note: String(attachment.note || ""), pages: retain(pages) });
  }
  return result;
}
