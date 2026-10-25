/**
 * Image replacement and remote-image ingestion boundary for report galleries.
 *
 * Replacements update the top-level image list and selected nested asset references.
 * Remote ingestion uses protocol validation plus a DNS lookup guard so user-provided
 * URLs cannot reach loopback, link-local, or private network services.
 */
import { Request, Response } from "express";
import axios from "axios";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import AssetReport from "../models/asset.model.js";
import RealEstateReport from "../models/realEstate.model.js";
import { uploadToCloudinary } from "../utils/cloudinary.js";

class UnsafeRemoteUrlError extends Error {}

function isPrivateAddress(address: string) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIP(address) === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) {
      return isPrivateAddress(normalized.slice(7));
    }
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("ff")
    );
  }
  return true;
}

function validatedRemoteUrl(value: unknown) {
  let target: URL;
  try {
    target = new URL(String(value || ""));
  } catch {
    throw new UnsafeRemoteUrlError("A valid HTTPS image URL is required.");
  }
  if (!/^https?:$/.test(target.protocol) || target.username || target.password) {
    throw new UnsafeRemoteUrlError("Only credential-free HTTP or HTTPS image URLs are allowed.");
  }
  return target;
}

const safeLookup = (hostname: string, options: any, callback: any) => {
  dns.lookup(hostname, options, (error: NodeJS.ErrnoException | null, address: any, family: any) => {
    if (error) return callback(error);
    const results = Array.isArray(address) ? address : [{ address, family }];
    if (!results.length || results.some((result) => isPrivateAddress(result.address))) {
      const blocked = new Error("Private and local network addresses are not allowed.") as NodeJS.ErrnoException;
      blocked.code = "EACCES";
      return callback(blocked);
    }
    return Array.isArray(address)
      ? callback(null, address)
      : callback(null, address, family);
  });
};

/**
 * Update a specific image URL in a report
 * POST /api/gallery/update-image
 * Body: { reportId: string, reportType: string, oldUrl: string, newUrl: string }
 */
export const updateReportImage = async (req: Request, res: Response) => {
  try {
    const { reportId, reportType, oldUrl, newUrl } = req.body;

    if (!reportId || !reportType || !oldUrl || !newUrl) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    console.log(`[ImageEnhance] Updating image in ${reportType} report ${reportId}`);
    console.log(`[ImageEnhance] Old URL: ${oldUrl.substring(0, 80)}...`);
    console.log(`[ImageEnhance] New URL: ${newUrl.substring(0, 80)}...`);

    let report;
    if (reportType === "asset") {
      report = await AssetReport.findById(reportId);
    } else if (reportType === "realEstate") {
      report = await RealEstateReport.findById(reportId);
    } else {
      return res.status(400).json({ message: "Invalid report type" });
    }

    if (!report) {
      return res.status(404).json({ message: "Report not found" });
    }

    if ((req as any).user?.isReviewAccount === true && String(report.user) !== String((req as any).userId)) {
      return res.status(404).json({ message: "Report not found" });
    }

    // Find and replace the old URL with the new URL
    const imageIndex = report.imageUrls.indexOf(oldUrl);
    if (imageIndex === -1) {
      return res.status(404).json({ message: "Image URL not found in report" });
    }

    report.imageUrls[imageIndex] = newUrl;

    // Also update any lot references if they exist (asset reports only)
    if (reportType === "asset") {
      const assetReport = report as any;
      if (assetReport.lots && Array.isArray(assetReport.lots)) {
        for (const lot of assetReport.lots) {
          // Update image_url if it matches
          if (lot.image_url === oldUrl) {
            lot.image_url = newUrl;
          }
          // Update image_urls array if it exists
          if (lot.image_urls && Array.isArray(lot.image_urls)) {
            const lotImgIndex = lot.image_urls.indexOf(oldUrl);
            if (lotImgIndex !== -1) {
              lot.image_urls[lotImgIndex] = newUrl;
            }
          }
          // Update items if they exist (for catalogue mode)
          if (lot.items && Array.isArray(lot.items)) {
            for (const item of lot.items) {
              if (item.image_url === oldUrl) {
                item.image_url = newUrl;
              }
            }
          }
        }
      }
    }

    await report.save();
    console.log(`[ImageEnhance] Successfully updated image at index ${imageIndex}`);

    return res.json({
      success: true,
      message: "Image URL updated",
      imageIndex,
    });
  } catch (e: any) {
    console.error("[ImageEnhance] Update error:", e);
    return res.status(500).json({ message: "Failed to update image", error: e.message });
  }
};

/**
 * Upload an image from URL to Cloudinary
 * POST /api/gallery/upload-from-url
 * Body: { imageUrl: string, folder?: string }
 */
export const uploadImageFromUrl = async (req: Request, res: Response) => {
  try {
    const { imageUrl, folder } = req.body;

    if (!imageUrl) {
      return res.status(400).json({ message: "Image URL required" });
    }

    const target = validatedRemoteUrl(imageUrl);
    console.log(`[ImageEnhance] Downloading image from: ${target.origin}${target.pathname.slice(0, 80)}...`);

    // Download the image
    const imgRes = await axios.get<ArrayBuffer>(target.toString(), {
      responseType: "arraybuffer",
      timeout: 120000, // 2 minutes for large enhanced images
      maxRedirects: 3,
      maxContentLength: 25 * 1024 * 1024,
      maxBodyLength: 25 * 1024 * 1024,
      httpAgent: new http.Agent({ lookup: safeLookup }),
      httpsAgent: new https.Agent({ lookup: safeLookup }),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    const buffer = Buffer.from(imgRes.data);
    console.log(`[ImageEnhance] Downloaded: ${(buffer.length / 1024 / 1024).toFixed(2)} MB`);

    // Upload to Cloudinary
    const result = await uploadToCloudinary(buffer, {
      folder: folder || "enhanced",
      tags: ["hitpaw-enhanced"],
    });

    console.log(`[ImageEnhance] Uploaded to Cloudinary: ${result.url}`);

    return res.json({
      success: true,
      url: result.url,
      publicId: result.publicId,
      bytes: result.bytes,
    });
  } catch (e: any) {
    console.error("[ImageEnhance] Upload error:", e);
    if (e instanceof UnsafeRemoteUrlError) {
      return res.status(400).json({ message: e.message });
    }
    return res.status(500).json({ message: "Failed to upload image", error: e.message });
  }
};
