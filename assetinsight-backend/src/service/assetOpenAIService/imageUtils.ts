/**
 * Prepares images for multimodal provider requests. Download and conversion limits guard
 * memory, MIME normalization removes storage-specific details, and compact data URLs
 * give all analysis modes the same validated image contract.
 */
import axios from "axios";
import { Jimp } from "jimp";
import { normalizeHeicToJpegBuffer } from "../../utils/imageProcessing.js";

// Keep OCR-readable lot cards/stickers intact for AI analysis.
const AI_MAX_IMAGE_SIZE = 900 * 1024;
const AI_MAX_DIMENSION = 1600;
const AI_QUALITY = 82;

// ---------------------------------------------------------------------------
// Focus-box registry: maps image URL → normalized box {x, y, w, h} (0-1).
// The job registers entries before AI analysis; imageUrlToBase64WithMime reads
// them and draws a red rectangle so the AI can see the focus region.
// ---------------------------------------------------------------------------
export type FocusBoxRect = { x: number; y: number; w: number; h: number };
const _focusBoxRegistry = new Map<string, FocusBoxRect>();

export function registerFocusBoxes(
  entries: Array<{ url: string; box: FocusBoxRect }>
): void {
  for (const e of entries) _focusBoxRegistry.set(e.url, e.box);
}

export function clearFocusBoxes(): void {
  _focusBoxRegistry.clear();
}

/**
 * Draw a red rectangle border on the image at the given normalised coords.
 */
async function drawFocusBoxOnImage(
  buffer: Buffer,
  box: FocusBoxRect
): Promise<Buffer> {
  try {
    const normalizedBuffer = await normalizeHeicToJpegBuffer(buffer);
    const image = await Jimp.read(normalizedBuffer);
    const imgW = image.width;
    const imgH = image.height;

    const bx = Math.max(0, Math.round(box.x * imgW));
    const by = Math.max(0, Math.round(box.y * imgH));
    const bw = Math.min(imgW - bx, Math.round(box.w * imgW));
    const bh = Math.min(imgH - by, Math.round(box.h * imgH));
    if (bw < 4 || bh < 4) return buffer;

    const lw = Math.max(3, Math.round(Math.min(imgW, imgH) * 0.006));
    const R = 0xEF, G = 0x44, B = 0x44;
    const data = image.bitmap.data;
    const stride = imgW * 4;

    const setPixel = (px: number, py: number) => {
      if (px < 0 || py < 0 || px >= imgW || py >= imgH) return;
      const idx = py * stride + px * 4;
      data[idx] = R; data[idx + 1] = G; data[idx + 2] = B; data[idx + 3] = 255;
    };

    // Top & bottom edges
    for (let px = bx; px < bx + bw; px++) {
      for (let t = 0; t < lw; t++) { setPixel(px, by + t); setPixel(px, by + bh - 1 - t); }
    }
    // Left & right edges
    for (let py = by; py < by + bh; py++) {
      for (let t = 0; t < lw; t++) { setPixel(bx + t, py); setPixel(bx + bw - 1 - t, py); }
    }

    return await image.getBuffer("image/jpeg", { quality: 95 });
  } catch (err) {
    console.warn("[AI] Failed to draw focus box:", err);
    return buffer;
  }
}

/**
 * Compress image buffer for AI analysis (lower quality = lower tokens)
 */
async function compressImageForAI(buffer: Buffer): Promise<Buffer> {
  try {
    const normalizedBuffer = await normalizeHeicToJpegBuffer(buffer);
    const image = await Jimp.read(normalizedBuffer);
    const width = image.width;
    const height = image.height;
    
    // Resize only enough to keep requests practical while preserving small text.
    if (width > height) {
      if (width > AI_MAX_DIMENSION) {
        image.resize({ w: AI_MAX_DIMENSION });
      }
    } else {
      if (height > AI_MAX_DIMENSION) {
        image.resize({ h: AI_MAX_DIMENSION });
      }
    }
    
    // Compress as JPEG
    let quality = AI_QUALITY;
    let compressed = await image.getBuffer("image/jpeg", { quality });
    
    // Further reduce quality if still too large.
    while (compressed.length > AI_MAX_IMAGE_SIZE && quality > 50) {
      quality -= 8;
      compressed = await image.getBuffer("image/jpeg", { quality });
    }
    
    console.log(`[AI] Image compressed: ${buffer.length} → ${compressed.length} bytes (${Math.round(compressed.length / buffer.length * 100)}%)`);
    return compressed;
  } catch (err) {
    console.warn('[AI] Image compression failed, using original:', err);
    return buffer;
  }
}

/**
 * Download image from URL and compress for AI analysis
 * Returns base64 string and mime type
 */
export async function imageUrlToBase64WithMime(
  url: string
): Promise<{ base64: string; mime: string }> {
  const response = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 30000,
  });
  let buffer: Buffer = Buffer.from(response.data as ArrayBuffer);

  // Draw red focus box onto AI copy if registered for this URL
  const focusBox = _focusBoxRegistry.get(url);
  if (focusBox) {
    buffer = await drawFocusBoxOnImage(buffer, focusBox) as Buffer;
  }
  
  // Compress image for AI
  const compressed = await compressImageForAI(buffer);
  
  // Always return as JPEG after compression
  return { 
    base64: compressed.toString("base64"), 
    mime: "image/jpeg" 
  };
}
