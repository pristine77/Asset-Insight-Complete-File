import axios from "axios";
import { Jimp } from "jimp";
import { getPositiveIntEnv } from "../../../utils/concurrency.js";
import {
  Paragraph,
  BorderStyle,
  Table,
  TableRow,
  TableCell,
  WidthType,
  ShadingType,
  TextRun,
  Document,
  Packer,
  HeadingLevel,
  AlignmentType,
  TableLayoutType,
} from "docx";

// Max image size for DOCX embedding (500KB per image to keep total size manageable)
const MAX_IMAGE_SIZE = 500 * 1024;
const MAX_IMAGE_DIMENSION = 1400; // Max width/height in pixels

// Concurrency limit for parallel image processing.
const PARALLEL_CONCURRENCY = getPositiveIntEnv("REPORT_IMAGE_FETCH_CONCURRENCY", 8);

// Image cache for pre-fetched images (cleared after each report generation)
const imageCache = new Map<string, Buffer | null>();

/**
 * Clear the image cache (call after report generation completes)
 */
export function clearImageCache(): void {
  imageCache.clear();
  console.log('[DOCX] Image cache cleared');
}

/**
 * Get cached image count
 */
export function getImageCacheSize(): number {
  return imageCache.size;
}

export function formatDateUS(dateString?: string): string {
  if (!dateString) return "";
  const d = new Date(dateString);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function formatMonthYear(dateString?: string): string {
  if (!dateString) return "";
  const d = new Date(dateString);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export function toTitleCaseWords(input: any): string {
  const text = String(input ?? "").trim();
  if (!text) return "";

  return text.replace(/([A-Za-zÀ-ÖØ-öø-ÿ]+(?:['’-][A-Za-zÀ-ÖØ-öø-ÿ]+)*)/g, (word) => {
    const formatPart = (part: string): string => {
      if (!part) return part;
      if (/\d/.test(part)) return part;
      if (part === part.toUpperCase() && part.length <= 5) return part;

      const hasLower = /[a-zà-öø-ÿ]/.test(part);
      const hasInnerUpper = /[A-ZÀ-ÖØ-Þ]/.test(part.slice(1));
      if (hasLower && hasInnerUpper) return part;

      const first = part.charAt(0).toUpperCase();
      const rest = part.slice(1).toLowerCase();
      return `${first}${rest}`;
    };

    return word
      .split(/(['’-])/)
      .map((segment) => (segment === "'" || segment === "’" || segment === "-" ? segment : formatPart(segment)))
      .join("");
  });
}

export async function dataUrlToBuffer(dataUrl: string): Promise<Buffer> {
  const m = dataUrl.match(/^data:(.*?);base64,(.*)$/);
  if (!m) throw new Error("Invalid data URL");
  return Buffer.from(m[2], "base64");
}

/**
 * Compress image buffer to reduce DOCX size (using Jimp)
 * This is ONLY for DOCX embedding - ZIP images remain uncompressed
 */
async function compressImageForDocx(buffer: Buffer): Promise<Buffer> {
  try {
    const image = await Jimp.read(buffer);
    const width = image.width;
    const height = image.height;
    
    const needsResize = width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION;
    const needsCompress = buffer.length > MAX_IMAGE_SIZE;
    
    if (!needsResize && !needsCompress) {
      return buffer; // Already small enough
    }
    
    // Resize if too large (maintain aspect ratio)
    if (needsResize) {
      if (width > height) {
        image.resize({ w: MAX_IMAGE_DIMENSION });
      } else {
        image.resize({ h: MAX_IMAGE_DIMENSION });
      }
    }
    
    // Compress as JPEG with reduced quality for smaller file size
    let quality = 72;
    let compressed = await image.getBuffer("image/jpeg", { quality });
    
    // Progressive quality reduction if still too large
    while (compressed.length > MAX_IMAGE_SIZE && quality > 40) {
      quality -= 10;
      compressed = await image.getBuffer("image/jpeg", { quality });
    }
    
    // Verbose logging disabled for performance (uncomment for debugging)
    // console.log(`[DOCX] Image compressed: ${buffer.length} → ${compressed.length} bytes (${Math.round(compressed.length / buffer.length * 100)}%)`);
    return compressed;
  } catch (err) {
    console.warn('[DOCX] Image compression failed, using original:', err);
    return buffer; // Return original if compression fails
  }
}

/**
 * Fetch and compress a single image (internal, no caching)
 */
async function fetchAndCompressSingle(url: string): Promise<Buffer | null> {
  try {
    let rawBuffer: Buffer;
    
    if (url.startsWith("data:")) {
      rawBuffer = await dataUrlToBuffer(url);
    } else {
      const maxAttempts = 2; // Reduced retries for speed
      let lastErr: any = null;
      let fetched: Buffer | null = null;
      
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const resp = await axios.get<ArrayBuffer>(url, {
            responseType: "arraybuffer",
            timeout: 10000, // Reduced timeout
            headers: { Accept: "image/*" },
            maxContentLength: 40 * 1024 * 1024,
            maxBodyLength: 40 * 1024 * 1024,
          });
          fetched = Buffer.from(resp.data);
          break;
        } catch (e) {
          lastErr = e;
          if (attempt < maxAttempts) {
            await new Promise((r) => setTimeout(r, 200));
          }
        }
      }
      
      if (!fetched) {
        return null;
      }
      rawBuffer = fetched;
    }
    
    return await compressImageForDocx(rawBuffer);
  } catch {
    return null;
  }
}

/**
 * Pre-fetch and compress all images in parallel batches
 * Call this BEFORE generating DOCX to avoid sequential processing
 */
export async function prefetchImages(urls: string[]): Promise<void> {
  const uniqueUrls = [...new Set(urls.filter(u => u && !imageCache.has(u)))];
  if (uniqueUrls.length === 0) {
    console.log('[DOCX] All images already cached');
    return;
  }
  
  console.log(`[DOCX] Pre-fetching ${uniqueUrls.length} images in parallel (concurrency: ${PARALLEL_CONCURRENCY})...`);
  const startTime = Date.now();
  
  // Process in batches with concurrency limit
  let processed = 0;
  let failed = 0;
  
  for (let i = 0; i < uniqueUrls.length; i += PARALLEL_CONCURRENCY) {
    const batch = uniqueUrls.slice(i, i + PARALLEL_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (url) => {
        const buffer = await fetchAndCompressSingle(url);
        imageCache.set(url, buffer);
        return buffer !== null;
      })
    );
    
    processed += batch.length;
    failed += results.filter(r => !r).length;
    
    // Progress log every 100 images
    if (processed % 100 === 0 || processed === uniqueUrls.length) {
      console.log(`[DOCX] Pre-fetched ${processed}/${uniqueUrls.length} images...`);
    }
  }
  
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[DOCX] ✅ Pre-fetch complete: ${processed - failed} success, ${failed} failed, ${duration}s`);
}

/**
 * Fetch image buffer (uses cache if available)
 */
export async function fetchImageBuffer(url?: string | null): Promise<Buffer | null> {
  if (!url) return null;
  
  // Check cache first
  if (imageCache.has(url)) {
    return imageCache.get(url) || null;
  }
  
  // Fallback to single fetch if not cached
  const buffer = await fetchAndCompressSingle(url);
  imageCache.set(url, buffer);
  return buffer;
}

export function goldDivider(color = "DC2626", compact = false): Paragraph {
  return new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: compact ? 8 : 24, color } },
    spacing: compact ? { before: 30, after: 70 } : { before: 100, after: 140 },
  });
}

export interface KeyValueTableOptions {
  monochrome?: boolean;
  compact?: boolean;
  font?: string;
}

export function buildKeyValueTable(
  rows: Array<{ label: string; value?: string }>,
  options: KeyValueTableOptions = {}
): Table {
  const font = options.font || "Calibri";
  const labelFill = options.monochrome ? "F3F4F6" : "FEE2E2";
  const labelColor = options.monochrome ? "000000" : "991B1B";
  const valueColor = options.monochrome ? "000000" : "374151";
  const cellMargins = options.compact
    ? { top: 55, bottom: 55, left: 90, right: 90 }
    : { top: 100, bottom: 100, left: 140, right: 140 };

  return new Table({
    width: { size: 9360, type: WidthType.DXA }, // ~6.5"
    layout: TableLayoutType.FIXED,
    columnWidths: [
      Math.round(9360 * 0.35),
      Math.round(9360 * 0.65),
    ],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 6, color: "E5E7EB" },
      bottom: { style: BorderStyle.SINGLE, size: 6, color: "E5E7EB" },
      left: { style: BorderStyle.SINGLE, size: 6, color: "E5E7EB" },
      right: { style: BorderStyle.SINGLE, size: 6, color: "E5E7EB" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "E5E7EB" },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: "F3F4F6" },
    },
    rows: rows.map(
      (r, idx) =>
        new TableRow({
          children: [
            new TableCell({
              margins: cellMargins,
              shading: { type: ShadingType.CLEAR, fill: labelFill, color: "auto" },
              children: [
                new Paragraph({ 
                  children: [
                    new TextRun({ 
                      text: r.label, 
                      bold: true, 
                      color: labelColor,
                      font,
                      size: 22
                    })
                  ] 
                })
              ],
            }),
            new TableCell({
              margins: cellMargins,
              shading: { type: ShadingType.CLEAR, fill: idx % 2 === 0 ? "FFFFFF" : "F9FAFB", color: "auto" },
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: r.value && r.value.trim() ? r.value : "—",
                      color: valueColor,
                      font,
                      size: 22
                    })
                  ]
                })
              ],
            }),
          ],
        })
    ),
  });
}

/**
 * Create a simple one-page DOCX buffer with a centered heading
 */
export async function createSimpleHeadingDocx(heading: string): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            text: heading,
            heading: HeadingLevel.HEADING_1,
            alignment: AlignmentType.CENTER,
            spacing: { before: 400, after: 200 },
          }),
        ],
      },
    ],
  });
  return await Packer.toBuffer(doc);
}
