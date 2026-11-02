import axios from "axios";
import sharp from "sharp";
import { degrees, PDFDocument } from "pdf-lib";
import { normalizeHeicToJpegBuffer } from "../utils/imageProcessing.js";

/**
 * Uploaded documents in the Salvage appraisal report (owner, 2026-11-01:
 * "There are invoice pages ... the invoices form appendixes"; "all pages in
 * a4"). The report reserves one blank A4 page per uploaded PDF page; after
 * pagination, each source page is drawn onto its reserved page, fitted inside
 * the report margins so the stamped header and footer never cover it. Pages
 * are embedded as PDF content (text stays text), never flattened to images.
 * A landscape page is turned a quarter turn when that prints it larger, as a
 * printer would; a page's own /Rotate is honoured so it reads upright.
 */

const MM = 72 / 25.4;
/** A4 in points and the report's margins (templates/salvage-appraisal.html @page). */
const A4 = { width: 210 * MM, height: 297 * MM };
const MARGIN = { top: 28 * MM, bottom: 22 * MM, left: 18 * MM, right: 18 * MM };
/** Room left for the section heading printed at the top of a slot's first page. */
const HEADING_SPACE = 13 * MM;

export const SALVAGE_APPENDIX_LIMITS = { bytes: 30 * 1024 * 1024, pagesPerDocument: 60, totalPages: 200 } as const;

async function download(url: string): Promise<Buffer> {
  const response = await axios.get(url, {
    responseType: "arraybuffer", timeout: 30_000, maxRedirects: 3,
    maxContentLength: SALVAGE_APPENDIX_LIMITS.bytes, maxBodyLength: SALVAGE_APPENDIX_LIMITS.bytes,
  });
  return Buffer.from(response.data as ArrayBuffer);
}

/** Download an uploaded PDF and check it can be embedded. */
export async function loadSalvageAppendixPdf(url: string, name: string): Promise<{ bytes: Buffer; pageCount: number }> {
  let bytes: Buffer;
  try { bytes = await download(url); } catch {
    // URLs may carry signed-access tokens; never echo them.
    throw new Error(`${name} could not be downloaded.`);
  }
  if (bytes.subarray(0, 1024).indexOf("%PDF-") < 0) throw new Error(`${name} is not a PDF file.`);
  // pdf-lib parses leniently: a damaged file can load and fail only when its pages are read.
  let pageCount: number;
  try { pageCount = (await PDFDocument.load(bytes)).getPageCount(); } catch {
    throw new Error(`${name} could not be read; it may be password-protected or damaged.`);
  }
  if (!pageCount) throw new Error(`${name} has no pages.`);
  if (pageCount > SALVAGE_APPENDIX_LIMITS.pagesPerDocument) {
    throw new Error(`${name} has ${pageCount} pages; at most ${SALVAGE_APPENDIX_LIMITS.pagesPerDocument} can be attached.`);
  }
  return { bytes, pageCount };
}

/** Download an uploaded photo (or signature) as an upright JPEG/PNG data URI. */
export async function loadSalvageAppendixImage(url: string, name: string, options: { png?: boolean; maxSide?: number } = {}): Promise<string> {
  try {
    const normalized = await normalizeHeicToJpegBuffer(await download(url), { maxInputPixels: 40_000_000 });
    const image = sharp(normalized, { limitInputPixels: 40_000_000 }).rotate()
      .resize({ width: options.maxSide ?? 2000, height: options.maxSide ?? 2000, fit: "inside", withoutEnlargement: true });
    const buffer = options.png ? await image.png().toBuffer() : await image.jpeg({ quality: 85 }).toBuffer();
    return `data:image/${options.png ? "png" : "jpeg"};base64,${buffer.toString("base64")}`;
  } catch {
    throw new Error(`${name} could not be prepared.`);
  }
}

/**
 * Draw every page of `source` onto the report's reserved pages, starting at
 * 1-based page `startPage`. The first page leaves room for the heading.
 */
export async function drawSalvageAppendixPages(target: PDFDocument, source: Uint8Array, startPage: number): Promise<void> {
  const sourceDocument = await PDFDocument.load(source);
  const sourcePages = sourceDocument.getPages();
  const targetPages = target.getPages();
  if (startPage < 1 || startPage - 1 + sourcePages.length > targetPages.length) {
    throw new Error("Appendix pages do not match the pages reserved for them.");
  }
  // A truly blank page has no content stream and cannot be embedded; its
  // reserved page simply stays blank (with the header and footer).
  const drawable = sourcePages.map((page, index) => (page.node.Contents() ? index : -1)).filter((index) => index >= 0);
  const embeddedPages = await target.embedPdf(sourceDocument, drawable);
  const embedded = new Map(drawable.map((sourceIndex, i) => [sourceIndex, embeddedPages[i]]));
  sourcePages.forEach((_source, index) => {
    const page = embedded.get(index);
    if (!page) return;
    const top = A4.height - MARGIN.top - (index === 0 ? HEADING_SPACE : 0);
    const box = { x: MARGIN.left, y: MARGIN.bottom, width: A4.width - MARGIN.left - MARGIN.right, height: top - MARGIN.bottom };
    // The source's own rotation (clockwise for viewers) undone as a CCW turn.
    const own = ((sourcePages[index].getRotation().angle % 360) + 360) % 360;
    const upright = (360 - own) % 360;
    const [w, h] = [page.width, page.height];
    const [shownW, shownH] = upright % 180 ? [h, w] : [w, h];
    const plain = Math.min(box.width / shownW, box.height / shownH);
    const turned = Math.min(box.width / shownH, box.height / shownW);
    const turn = shownW > shownH && turned > plain * 1.15 ? 90 : 0;
    const angle = (upright + turn) % 360;
    const scale = Math.min(1, turn ? turned : plain);
    // Rotate about the origin, then shift so the page's centre lands on the box's centre.
    const radians = (angle * Math.PI) / 180;
    const cx = (w * scale) / 2, cy = (h * scale) / 2;
    const centre = { x: cx * Math.cos(radians) - cy * Math.sin(radians), y: cx * Math.sin(radians) + cy * Math.cos(radians) };
    targetPages[startPage - 1 + index].drawPage(page, {
      x: box.x + box.width / 2 - centre.x, y: box.y + box.height / 2 - centre.y,
      xScale: scale, yScale: scale, rotate: degrees(angle),
    });
  });
}
