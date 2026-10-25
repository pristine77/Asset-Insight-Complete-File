/**
 * Gallery delivery helpers for transformed images, Cloudinary URLs and downloads.
 *
 * Local transformation returns the image bytes directly, URL generation delegates
 * optimization to Cloudinary, and ZIP responses stream archive output to avoid holding
 * the complete bundle in memory. Response headers are part of the gallery client
 * contract and describe the produced artifact.
 */
import { Request, Response } from "express";
import { Jimp } from "jimp";
import axios from "axios";
import archiver from "archiver";
import { 
  cloudinary, 
  getCloudinaryFetchUrl, 
  getCloudinaryCustomUrl,
  CLOUDINARY_PRESETS 
} from "../utils/cloudinary.js";

/**
 * Simple and effective image compression
 * Resize + JPEG quality reduction = small file + good quality
 */
async function compressImage(
  buffer: Buffer,
  maxWidth: number,
  maxHeight: number,
  quality: number
): Promise<{ buffer: Buffer; width: number; height: number; originalKB: number; finalKB: number }> {
  const originalKB = buffer.length / 1024;
  const image = await Jimp.read(buffer);
  
  // Resize if larger than max dimensions (maintain aspect ratio)
  if (maxWidth > 0 && maxHeight > 0) {
    if (image.width > maxWidth || image.height > maxHeight) {
      const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
      image.resize({ w: Math.round(image.width * scale) });
    }
  } else if (maxWidth > 0 && image.width > maxWidth) {
    image.resize({ w: maxWidth });
  } else if (maxHeight > 0 && image.height > maxHeight) {
    image.resize({ h: maxHeight });
  }
  
  // Compress as JPEG
  const outputBuffer = await image.getBuffer("image/jpeg", { quality });
  
  return {
    buffer: outputBuffer,
    width: image.width,
    height: image.height,
    originalKB,
    finalKB: outputBuffer.length / 1024,
  };
}

/**
 * Transform image with given settings (local Jimp processing)
 * GET /api/gallery/transform?url=...&width=...&height=...&quality=...
 */
export const transformImage = async (req: Request, res: Response) => {
  try {
    const { url, width, height, quality } = req.query;
    
    if (!url || typeof url !== "string") {
      return res.status(400).json({ message: "URL required" });
    }

    // Fetch original image
    const imgRes = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      timeout: 30000,
    });
    
    const buffer = Buffer.from(imgRes.data);
    
    // Parse settings with good defaults for small file size
    const maxWidth = parseInt(String(width)) || 1200;
    const maxHeight = parseInt(String(height)) || 900;
    const jpegQuality = Math.min(100, Math.max(10, parseInt(String(quality)) || 75));

    const result = await compressImage(buffer, maxWidth, maxHeight, jpegQuality);
    
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Content-Length", result.buffer.length);
    res.setHeader("X-Original-KB", result.originalKB.toFixed(1));
    res.setHeader("X-Final-KB", result.finalKB.toFixed(1));
    res.setHeader("X-Dimensions", `${result.width}x${result.height}`);
    return res.send(result.buffer);
  } catch (e) {
    console.error("Transform image error:", e);
    return res.status(500).json({ message: "Failed to transform image" });
  }
};

/**
 * Get Cloudinary-optimized URL for an image
 * GET /api/gallery/cloudinary-url?url=...&preset=...
 * 
 * Presets: webOptimized, highQuality, thumbnail, document, aiEnhanced
 */
export const getCloudinaryUrl = async (req: Request, res: Response) => {
  try {
    const { url, preset, width, height, quality, format, enhance } = req.query;
    
    if (!url || typeof url !== "string") {
      return res.status(400).json({ message: "URL required" });
    }

    let cloudinaryUrl: string;

    if (preset && typeof preset === "string" && preset in CLOUDINARY_PRESETS) {
      // Use preset
      cloudinaryUrl = getCloudinaryFetchUrl(url, preset as keyof typeof CLOUDINARY_PRESETS);
    } else {
      // Custom settings
      cloudinaryUrl = getCloudinaryCustomUrl(url, {
        width: width ? parseInt(String(width)) : undefined,
        height: height ? parseInt(String(height)) : undefined,
        quality: quality as any || "auto:good",
        format: format as any || "auto",
        enhance: enhance !== "false",
      });
    }

    return res.json({ 
      url: cloudinaryUrl,
      preset: preset || "custom",
    });
  } catch (e) {
    console.error("Cloudinary URL error:", e);
    return res.status(500).json({ message: "Failed to generate Cloudinary URL" });
  }
};

/**
 * Get available Cloudinary presets
 * GET /api/gallery/cloudinary-presets
 */
export const getCloudinaryPresets = async (_req: Request, res: Response) => {
  return res.json({
    presets: Object.keys(CLOUDINARY_PRESETS).map((key) => ({
      id: key,
      settings: CLOUDINARY_PRESETS[key as keyof typeof CLOUDINARY_PRESETS],
    })),
  });
};

/**
 * Download a single image (proxy to avoid CORS)
 * POST /api/gallery/download-single
 * Body: { url: string }
 */
export const downloadSingle = async (req: Request, res: Response) => {
  try {
    const { url } = req.body;
    
    if (!url || typeof url !== "string") {
      return res.status(400).json({ message: "URL required" });
    }

    console.log("[Gallery] Downloading single image:", url.substring(0, 100) + "...");

    // Fetch the image from Cloudinary (or any URL)
    const imgRes = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      timeout: 60000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });
    
    const buffer = Buffer.from(imgRes.data);
    const upstreamContentType = imgRes.headers["content-type"];
    const contentType =
      typeof upstreamContentType === "string"
        ? upstreamContentType
        : "image/jpeg";
    
    console.log("[Gallery] Downloaded:", (buffer.length / 1024).toFixed(1), "KB");

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", buffer.length);
    res.setHeader("Content-Disposition", 'attachment; filename="image.jpg"');
    return res.send(buffer);
  } catch (e: any) {
    console.error("Download single error:", e.message);
    return res.status(500).json({ message: "Failed to download image", error: e.message });
  }
};

/**
 * Create zip with transformed images
 * POST /api/gallery/download-zip
 * Body: { urls: string[], useCloudinary?: boolean, settings?: { width, height, quality } }
 * 
 * If useCloudinary=true, URLs are already Cloudinary-transformed, just fetch and zip
 * Otherwise, apply server-side compression with settings
 */
export const downloadZip = async (req: Request, res: Response) => {
  try {
    const { urls, useCloudinary, settings } = req.body;
    
    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ message: "URLs required" });
    }

    // Set response headers for zip download
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", 'attachment; filename="images.zip"');

    // Create archiver
    const archive = archiver("zip", { zlib: { level: 5 } });
    archive.pipe(res);

    // Process images in parallel batches
    const BATCH_SIZE = 10;
    let processed = 0;
    let totalKB = 0;

    for (let i = 0; i < urls.length; i += BATCH_SIZE) {
      const batch = urls.slice(i, i + BATCH_SIZE);
      
      await Promise.all(
        batch.map(async (url: string, idx: number) => {
          try {
            const imgRes = await axios.get<ArrayBuffer>(url, {
              responseType: "arraybuffer",
              timeout: 60000, // Longer timeout for Cloudinary transforms
            });
            
            let buffer: Buffer = Buffer.from(imgRes.data);
            
            // If NOT using Cloudinary, apply server-side compression
            if (!useCloudinary && settings) {
              const maxWidth = parseInt(String(settings?.width)) || 1200;
              const maxHeight = parseInt(String(settings?.height)) || 900;
              const quality = Math.min(100, Math.max(10, parseInt(String(settings?.quality)) || 75));
              const result = await compressImage(buffer, maxWidth, maxHeight, quality);
              buffer = result.buffer as Buffer;
            }
            
            totalKB += buffer.length / 1024;

            // Determine file extension from URL or default to jpg
            const isWebP = url.includes("f_webp") || url.includes("f_auto");
            const ext = isWebP ? "webp" : "jpg";
            const filename = `image_${String(i + idx + 1).padStart(4, "0")}.${ext}`;
            archive.append(buffer, { name: filename });
            processed++;
          } catch (err) {
            console.warn(`Failed to fetch image ${i + idx + 1}:`, err);
          }
        })
      );
      
      console.log(`[Gallery] Downloaded ${processed}/${urls.length} images | Total: ${totalKB.toFixed(0)}KB`);
    }

    await archive.finalize();
  } catch (e) {
    console.error("Download zip error:", e);
    if (!res.headersSent) {
      return res.status(500).json({ message: "Failed to create zip" });
    }
  }
};
