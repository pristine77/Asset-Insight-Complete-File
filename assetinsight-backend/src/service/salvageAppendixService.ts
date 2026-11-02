import { createHash, randomUUID } from "node:crypto";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import SalvageReport from "../models/salvage.model.js";
import { getCurrentR2StorageTarget, uploadBufferToR2 } from "../utils/r2Storage/r2Upload.js";
import { normalizeHeicToJpegBuffer } from "../utils/imageProcessing.js";
import { SALVAGE_APPENDIX_LIMITS } from "./salvageAppendixPages.js";
import { SalvageWorkflowError } from "./salvageWorkflowService.js";

/**
 * Uploaded documents printed as the Salvage report's appendices (owner,
 * 2026-11-01: "There are invoice pages. That can add additional upload page
 * in the software so that the invoices form appendixes"; PDF and photos).
 *
 * The server owns every appendix's file address: an upload stores the file
 * under the report's own storage folder and records it; the browser may then
 * rename, annotate, reorder or remove appendices, but never supply an address
 * (the PDF builder downloads each one). Appendix changes are their own
 * requests, guarded by appendices_version rather than the preview revision, so
 * they never collide with a preview save or a running report job; they mark the
 * report's files out of date, and are refused while files are being generated.
 */

export const SALVAGE_MAX_APPENDICES = 20;
const TITLE_LIMIT = 120;
const NOTE_LIMIT = 300;
const IMAGE_TYPES: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/heic": ".heic", "image/heif": ".heif" };

export type SalvageAppendix = {
  id: string; title: string; note: string; kind: "pdf" | "image"; url: string; key: string;
  pageCount: number; filename: string; bytes: number; uploadedAt: Date;
};

function appendixText(value: unknown, field: string, limit: number, required: boolean): string {
  if (value !== undefined && value !== null && typeof value !== "string") throw new SalvageWorkflowError(400, `Invalid appendix ${field}.`);
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (required && !text) throw new SalvageWorkflowError(400, `Give the appendix a ${field}.`);
  if (text.length > limit) throw new SalvageWorkflowError(400, `The appendix ${field} can be at most ${limit} characters.`);
  return text;
}

function versionOf(value: unknown): number {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 0) throw new SalvageWorkflowError(400, "A current appendices version is required.");
  return version;
}

const pagesIn = (appendices: any[]) => appendices.reduce((sum, appendix) => sum + (Number(appendix.pageCount) || 1), 0);

/** Check one uploaded file: a readable, unprotected PDF or a real image. */
export async function inspectSalvageAppendixFile(file: { buffer?: Buffer; mimetype?: string; originalname?: string }): Promise<{ kind: "pdf" | "image"; pageCount: number; contentType: string; extension: string }> {
  const buffer = file.buffer;
  if (!buffer?.length) throw new SalvageWorkflowError(400, "Choose a PDF or photo to attach.");
  if (buffer.length > SALVAGE_APPENDIX_LIMITS.bytes) throw new SalvageWorkflowError(400, "An appendix can be at most 30 MB.");
  if (buffer.subarray(0, 1024).indexOf("%PDF-") >= 0) {
    // pdf-lib parses leniently: a damaged file can load and fail only when its pages are read.
    let pageCount: number;
    try { pageCount = (await PDFDocument.load(buffer)).getPageCount(); } catch {
      throw new SalvageWorkflowError(400, "This PDF could not be read. It may be password-protected or damaged; save an unprotected copy and try again.");
    }
    if (!pageCount) throw new SalvageWorkflowError(400, "This PDF has no pages.");
    if (pageCount > SALVAGE_APPENDIX_LIMITS.pagesPerDocument) {
      throw new SalvageWorkflowError(400, `This PDF has ${pageCount} pages; an appendix can have at most ${SALVAGE_APPENDIX_LIMITS.pagesPerDocument}.`);
    }
    return { kind: "pdf", pageCount, contentType: "application/pdf", extension: ".pdf" };
  }
  const mimetype = String(file.mimetype || "").toLowerCase();
  const extension = IMAGE_TYPES[mimetype];
  if (!extension) throw new SalvageWorkflowError(400, "Attach a PDF, or a JPEG, PNG, WebP or HEIC photo.");
  try {
    const decodable = await normalizeHeicToJpegBuffer(buffer, { maxInputPixels: 40_000_000 });
    const meta = await sharp(decodable, { limitInputPixels: 40_000_000 }).metadata();
    if (!meta.width || !meta.height) throw new Error("no size");
  } catch {
    throw new SalvageWorkflowError(400, "This photo could not be read. Try a JPEG or PNG copy.");
  }
  return { kind: "image", pageCount: 1, contentType: mimetype, extension };
}

/** Upload one appendix and add it at the end of the report's list. */
export async function addSalvageAppendix(report: any, file: { buffer?: Buffer; mimetype?: string; originalname?: string; size?: number }, body: any): Promise<any> {
  const version = versionOf(body?.version);
  if (version !== Number(report.appendices_version || 0)) {
    throw new SalvageWorkflowError(409, "The appendices changed in another window. Reload the report and try again.", "SALVAGE_APPENDICES_CONFLICT");
  }
  if (report.files_generating) throw new SalvageWorkflowError(409, "Wait for the report files to finish generating before changing appendices.");
  const current: any[] = Array.isArray(report.appendices) ? report.appendices : [];
  if (current.length >= SALVAGE_MAX_APPENDICES) throw new SalvageWorkflowError(400, `A report can have at most ${SALVAGE_MAX_APPENDICES} appendices.`);
  const title = appendixText(body?.title, "title", TITLE_LIMIT, true);
  const note = appendixText(body?.note, "note", NOTE_LIMIT, false);
  const inspected = await inspectSalvageAppendixFile(file);
  if (pagesIn(current) + inspected.pageCount > SALVAGE_APPENDIX_LIMITS.totalPages) {
    throw new SalvageWorkflowError(400, `The appendices can have at most ${SALVAGE_APPENDIX_LIMITS.totalPages} pages together.`);
  }
  const hash = createHash("sha256").update(file.buffer!).digest("hex");
  const target = getCurrentR2StorageTarget();
  // Content-addressed: re-uploading the same file reuses its stored copy.
  const key = `salvage/${report._id}/appendices/${hash}${inspected.extension}`;
  const url = await uploadBufferToR2(file.buffer!, inspected.contentType, target.bucketName, key);
  const appendix: SalvageAppendix = {
    id: `a-${randomUUID().slice(0, 12)}`, title, note, kind: inspected.kind, url, key, pageCount: inspected.pageCount,
    filename: String(file.originalname || "").slice(0, 200), bytes: file.buffer!.length, uploadedAt: new Date(),
  };
  const updated = await SalvageReport.findOneAndUpdate(
    { _id: report._id, user: report.user, files_generating: { $ne: true },
      $or: version === 0 ? [{ appendices_version: 0 }, { appendices_version: { $exists: false } }] : [{ appendices_version: version }] },
    { $push: { appendices: appendix }, $inc: { appendices_version: 1 }, $set: { files_stale: true } },
    { new: true }).lean();
  if (!updated) throw new SalvageWorkflowError(409, "The appendices changed in another window. Reload the report and try again.", "SALVAGE_APPENDICES_CONFLICT");
  return updated;
}

/**
 * Rename, annotate, reorder or remove appendices: the browser sends the list
 * it wants, by id, in order. Only appendices already on the report can appear.
 */
export async function updateSalvageAppendices(report: any, body: any): Promise<any> {
  const version = versionOf(body?.version);
  if (version !== Number(report.appendices_version || 0)) {
    throw new SalvageWorkflowError(409, "The appendices changed in another window. Reload the report and try again.", "SALVAGE_APPENDICES_CONFLICT");
  }
  if (report.files_generating) throw new SalvageWorkflowError(409, "Wait for the report files to finish generating before changing appendices.");
  if (!Array.isArray(body?.appendices) || body.appendices.length > SALVAGE_MAX_APPENDICES) throw new SalvageWorkflowError(400, "Invalid appendices list.");
  const saved = new Map<string, any>((Array.isArray(report.appendices) ? report.appendices : []).map((a: any) => [a.id, a]));
  const seen = new Set<string>();
  const next = body.appendices.map((entry: any) => {
    const existing = entry && typeof entry.id === "string" ? saved.get(entry.id) : undefined;
    if (!existing || seen.has(entry.id)) throw new SalvageWorkflowError(400, "An appendix in the list is not on this report. Reload and try again.");
    seen.add(entry.id);
    return { ...existing, title: appendixText(entry.title ?? existing.title, "title", TITLE_LIMIT, true), note: appendixText(entry.note ?? existing.note, "note", NOTE_LIMIT, false) };
  });
  const updated = await SalvageReport.findOneAndUpdate(
    { _id: report._id, user: report.user, files_generating: { $ne: true },
      $or: version === 0 ? [{ appendices_version: 0 }, { appendices_version: { $exists: false } }] : [{ appendices_version: version }] },
    { $set: { appendices: next, files_stale: true }, $inc: { appendices_version: 1 } },
    { new: true }).lean();
  if (!updated) throw new SalvageWorkflowError(409, "The appendices changed in another window. Reload the report and try again.", "SALVAGE_APPENDICES_CONFLICT");
  return updated;
}
