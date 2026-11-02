/**
 * The appraiser profile (owner, 2026-11-01: "Profile, set once"): designation,
 * title, signature image and CV as PDF, printed on the Salvage appraisal
 * reports the appraiser signs (service/salvageUnitResearch.ts decides when).
 *
 * As with profile pictures, a new file is stored first and the profile updated
 * second, so the previous file stays valid if either step fails; the replaced
 * file is cleaned up afterwards. The actor always comes from the session.
 */
import type { Response } from "express";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import User from "../models/user.model.js";
import type { AuthRequest } from "../middleware/auth.middleware.js";
import { attachUserCapabilities } from "../utils/userCapabilities.js";
import {
  deleteFromR2, getCurrentR2StorageTarget, isCurrentR2StorageTarget, resolvePersistedR2StorageTarget, uploadBufferToR2,
} from "../utils/r2Storage/r2Upload.js";

const CV_MAX_PAGES = 10;
const PROFILE_FIELDS = { designation: 40, title: 120 } as const;

function cleanup(bucket: unknown, publicBase: unknown, key: unknown) {
  const storage = resolvePersistedR2StorageTarget({ r2Bucket: bucket as string, r2PublicBaseUrl: publicBase as string });
  if (key && isCurrentR2StorageTarget(storage)) {
    void deleteFromR2(storage.bucketName, String(key)).catch((error) => console.warn("[AppraiserProfile] file cleanup failed:", error?.name || "Error"));
  }
}
async function respond(res: Response, userId: unknown) {
  const user = await User.findById(userId).select("-password -refreshTokens");
  if (!user) return res.status(404).json({ message: "User not found" });
  return res.json(await attachUserCapabilities(user));
}

/** Designation and title (text only). */
export const updateAppraiserProfile = async (req: AuthRequest, res: Response) => {
  try {
    const set: Record<string, unknown> = { "appraiserProfile.updatedAt": new Date() };
    for (const [field, limit] of Object.entries(PROFILE_FIELDS)) {
      if (!Object.prototype.hasOwnProperty.call(req.body || {}, field)) continue;
      const value = req.body[field];
      if (value !== null && value !== undefined && typeof value !== "string") return res.status(400).json({ message: `Invalid ${field}.` });
      const text = String(value ?? "").replace(/\s+/g, " ").trim();
      if (text.length > limit) return res.status(400).json({ message: `The ${field} can be at most ${limit} characters.` });
      set[`appraiserProfile.${field}`] = text;
    }
    await User.updateOne({ _id: req.userId }, { $set: set });
    return respond(res, req.userId);
  } catch {
    return res.status(500).json({ message: "Failed to save the appraiser profile" });
  }
};

/** A signature image: trimmed of its blank margin, at most 900 px wide, kept as PNG. */
export const uploadAppraiserSignature = async (req: AuthRequest, res: Response) => {
  try {
    const file = (req as any)?.file as Express.Multer.File | undefined;
    if (!file?.buffer) return res.status(400).json({ message: "Choose a signature image to upload" });
    let png: Buffer;
    try {
      png = await sharp(file.buffer, { limitInputPixels: 25_000_000 }).rotate()
        .flatten({ background: "#ffffff" }).trim({ threshold: 20 })
        .resize({ width: 900, height: 300, fit: "inside", withoutEnlargement: true }).png().toBuffer();
    } catch {
      return res.status(400).json({ message: "The signature is not a valid image" });
    }
    const user = await User.findById(req.userId).select("appraiserProfile");
    if (!user) return res.status(404).json({ message: "User not found" });
    const storage = getCurrentR2StorageTarget();
    if (!storage.bucketName) throw new Error("R2 bucket is not configured");
    const key = `appraisers/${req.userId}/signature-${Date.now()}-${randomUUID()}.png`;
    const url = await uploadBufferToR2(png, "image/png", storage.bucketName, key);
    const previous = (user as any).appraiserProfile || {};
    await User.updateOne({ _id: req.userId }, { $set: {
      "appraiserProfile.signatureUrl": url, "appraiserProfile.signatureKey": key, "appraiserProfile.signatureBucket": storage.bucketName,
      "appraiserProfile.signaturePublicBaseUrl": storage.publicBaseUrl, "appraiserProfile.updatedAt": new Date(),
    } });
    cleanup(previous.signatureBucket, previous.signaturePublicBaseUrl, previous.signatureKey);
    return respond(res, req.userId);
  } catch {
    return res.status(500).json({ message: "Failed to upload the signature" });
  }
};

export const deleteAppraiserSignature = async (req: AuthRequest, res: Response) => {
  try {
    const user = await User.findById(req.userId).select("appraiserProfile");
    if (!user) return res.status(404).json({ message: "User not found" });
    const previous = (user as any).appraiserProfile || {};
    await User.updateOne({ _id: req.userId }, { $unset: { "appraiserProfile.signatureUrl": 1, "appraiserProfile.signatureKey": 1,
      "appraiserProfile.signatureBucket": 1, "appraiserProfile.signaturePublicBaseUrl": 1 } });
    cleanup(previous.signatureBucket, previous.signaturePublicBaseUrl, previous.signatureKey);
    return respond(res, req.userId);
  } catch {
    return res.status(500).json({ message: "Failed to remove the signature" });
  }
};

/** A CV as PDF: readable, unprotected, at most 10 pages. */
export const uploadAppraiserCvPdf = async (req: AuthRequest, res: Response) => {
  try {
    const file = (req as any)?.file as Express.Multer.File | undefined;
    if (!file?.buffer?.length) return res.status(400).json({ message: "Choose a CV PDF to upload" });
    let pages = 0;
    try { pages = (await PDFDocument.load(file.buffer)).getPageCount(); } catch {
      return res.status(400).json({ message: "This PDF could not be read. It may be password-protected or damaged." });
    }
    if (!pages || pages > CV_MAX_PAGES) return res.status(400).json({ message: `The CV can have at most ${CV_MAX_PAGES} pages.` });
    const user = await User.findById(req.userId).select("appraiserProfile");
    if (!user) return res.status(404).json({ message: "User not found" });
    const storage = getCurrentR2StorageTarget();
    if (!storage.bucketName) throw new Error("R2 bucket is not configured");
    const key = `appraisers/${req.userId}/cv-${Date.now()}-${randomUUID()}.pdf`;
    const url = await uploadBufferToR2(file.buffer, "application/pdf", storage.bucketName, key);
    const previous = (user as any).appraiserProfile || {};
    await User.updateOne({ _id: req.userId }, { $set: {
      "appraiserProfile.cvPdfUrl": url, "appraiserProfile.cvPdfKey": key, "appraiserProfile.cvPdfBucket": storage.bucketName,
      "appraiserProfile.cvPdfPublicBaseUrl": storage.publicBaseUrl, "appraiserProfile.cvPdfFilename": String(file.originalname || "").slice(0, 200),
      "appraiserProfile.cvPdfPages": pages, "appraiserProfile.updatedAt": new Date(),
    } });
    cleanup(previous.cvPdfBucket, previous.cvPdfPublicBaseUrl, previous.cvPdfKey);
    return respond(res, req.userId);
  } catch {
    return res.status(500).json({ message: "Failed to upload the CV" });
  }
};

export const deleteAppraiserCvPdf = async (req: AuthRequest, res: Response) => {
  try {
    const user = await User.findById(req.userId).select("appraiserProfile");
    if (!user) return res.status(404).json({ message: "User not found" });
    const previous = (user as any).appraiserProfile || {};
    await User.updateOne({ _id: req.userId }, { $unset: { "appraiserProfile.cvPdfUrl": 1, "appraiserProfile.cvPdfKey": 1,
      "appraiserProfile.cvPdfBucket": 1, "appraiserProfile.cvPdfPublicBaseUrl": 1, "appraiserProfile.cvPdfFilename": 1, "appraiserProfile.cvPdfPages": 1 } });
    cleanup(previous.cvPdfBucket, previous.cvPdfPublicBaseUrl, previous.cvPdfKey);
    return respond(res, req.userId);
  } catch {
    return res.status(500).json({ message: "Failed to remove the CV" });
  }
};
