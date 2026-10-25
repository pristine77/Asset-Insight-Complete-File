/**
 * Android application release and download HTTP boundary.
 *
 * Admin upload tokens are short-lived capabilities: issuance, protected transfer and
 * completion are separate steps so large APK uploads do not pass through an ordinary
 * authenticated request. Completion verifies staged artifact metadata before making a
 * release discoverable through the public latest-version contract.
 */
import crypto from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import ApkRelease from "../models/apkRelease.model.js";
import { AdminAuthRequest } from "../middleware/admin.middleware.js";
import {
  createR2PresignedPutUrl,
  getCurrentR2StorageTarget,
  getR2PublicUrl,
  headR2Object,
  resolvePersistedR2StorageTarget,
  sha256R2Object,
  uploadBufferToR2,
  uploadFilePathToR2,
} from "../utils/r2Storage/r2Upload.js";
import User from "../models/user.model.js";

const APK_CONTENT_TYPE = "application/vnd.android.package-archive";
const APK_UPLOAD_TOKEN_TTL_SECONDS = 60 * 60;

interface ApkR2UploadTokenPayload extends jwt.JwtPayload {
  id: string;
  purpose: "apk-release-r2-upload";
  apkKey: string;
  r2Bucket?: string;
  r2PublicBaseUrl?: string;
  versionName: string;
  versionCode: number;
  releaseNotes: string;
  mandatory: boolean;
  originalName: string;
  sizeBytes: number;
}

function parseVersionCode(value: any): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function sanitizeFilePart(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/--+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

async function sha256ForUpload(file: Express.Multer.File): Promise<string> {
  const diskPath = (file as any).path as string | undefined;
  if (diskPath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      const stream = fs.createReadStream(diskPath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  }
  return crypto.createHash("sha256").update(file.buffer).digest("hex");
}

async function cleanupTempUpload(file?: Express.Multer.File) {
  const diskPath = (file as any)?.path as string | undefined;
  if (!diskPath) return;
  try {
    await fsp.unlink(diskPath);
  } catch {}
}

export const createAdminApkUploadToken = async (req: AdminAuthRequest, res: Response) => {
  try {
    if (!req.user?._id) {
      return res.status(401).json({ message: "Not authorized" });
    }

    const versionName = String(req.body?.versionName || "").trim();
    const versionCode = parseVersionCode(req.body?.versionCode);
    const originalName = String(req.body?.originalName || "").trim();
    const sizeBytes = Number(req.body?.sizeBytes);
    if (!versionName) {
      return res.status(400).json({ message: "Version name is required" });
    }
    if (!versionCode) {
      return res.status(400).json({ message: "Version code must be a positive whole number" });
    }
    if (!/\.apk$/i.test(originalName)) {
      return res.status(400).json({ message: "Only Android .apk files are allowed" });
    }
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
      return res.status(400).json({ message: "APK file size is invalid" });
    }

    const existing = await ApkRelease.findOne({ platform: "android", versionCode }).lean();
    if (existing) {
      return res.status(409).json({ message: `Version code ${versionCode} already exists` });
    }
    const latest = await ApkRelease.findOne({ platform: "android" })
      .sort({ versionCode: -1 })
      .lean();
    if (latest && Number(latest.versionCode) >= versionCode) {
      return res.status(400).json({
        message: `Version code must be higher than the latest uploaded version (${latest.versionCode})`,
      });
    }

    const storage = getCurrentR2StorageTarget();
    if (!storage.bucketName) {
      return res.status(500).json({ message: "R2_BUCKET_NAME is required to upload APK releases" });
    }
    const safeVersion = sanitizeFilePart(versionName) || "version";
    const safeName = sanitizeFilePart(originalName.replace(/\.apk$/i, "")) || "asset-insight";
    const apkKey = `apk/android/${versionCode}-${safeVersion}-${safeName}.apk`;
    const uploadUrl = await createR2PresignedPutUrl(
      storage.bucketName,
      apkKey,
      APK_CONTENT_TYPE,
      APK_UPLOAD_TOKEN_TTL_SECONDS
    );

    // Bind the object key and immutable release metadata into the signed capability;
    // completion does not trust a second, potentially altered copy from the client.
    const token = jwt.sign(
      {
        id: String(req.user._id),
        purpose: "apk-release-r2-upload",
        apkKey,
        r2Bucket: storage.bucketName,
        r2PublicBaseUrl: storage.publicBaseUrl,
        versionName,
        versionCode,
        releaseNotes: String(req.body?.releaseNotes || "").trim().slice(0, 5000),
        mandatory: req.body?.mandatory === true || req.body?.mandatory === "true",
        originalName,
        sizeBytes,
      },
      process.env.JWT_SECRET as string,
      { expiresIn: APK_UPLOAD_TOKEN_TTL_SECONDS }
    );
    return res.status(200).json({
      token,
      uploadUrl,
      method: "PUT",
      contentType: APK_CONTENT_TYPE,
      expiresInSeconds: APK_UPLOAD_TOKEN_TTL_SECONDS,
    });
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || "Failed to create APK upload token" });
  }
};

/**
 * Finalize an APK that the browser uploaded directly to R2. The signed token
 * binds all release metadata to the object key, while HEAD and streaming SHA
 * verification ensure the database never publishes an incomplete upload.
 */
export const completeAdminApkRelease = async (req: AdminAuthRequest, res: Response) => {
  try {
    if (!req.user?._id) {
      return res.status(401).json({ message: "Not authorized" });
    }
    const uploadToken = String(req.body?.uploadToken || "");
    if (!uploadToken) {
      return res.status(400).json({ message: "APK upload token is required" });
    }

    let payload: ApkR2UploadTokenPayload;
    try {
      payload = jwt.verify(
        uploadToken,
        process.env.JWT_SECRET as string
      ) as ApkR2UploadTokenPayload;
    } catch {
      return res.status(401).json({ message: "APK upload token expired or invalid" });
    }
    if (
      payload.purpose !== "apk-release-r2-upload" ||
      payload.id !== String(req.user._id) ||
      !payload.apkKey
    ) {
      return res.status(401).json({ message: "Invalid APK upload token" });
    }

    const versionCode = parseVersionCode(payload.versionCode);
    const sizeBytes = Number(payload.sizeBytes);
    if (!versionCode || !payload.versionName || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
      return res.status(400).json({ message: "APK upload metadata is invalid" });
    }

    // Completion is retry-safe: if the same token/object already produced this version,
    // return the published release rather than creating a duplicate record.
    const existing = await ApkRelease.findOne({ platform: "android", versionCode })
      .populate("uploadedBy", "username email")
      .lean();
    if (existing) {
      if (existing.apkKey !== payload.apkKey) {
        return res.status(409).json({ message: `Version code ${versionCode} already exists` });
      }
      return res.status(200).json({
        message: "APK release was already published",
        data: serializeRelease(existing),
      });
    }

    const latest = await ApkRelease.findOne({ platform: "android" })
      .sort({ versionCode: -1 })
      .lean();
    if (latest && Number(latest.versionCode) >= versionCode) {
      return res.status(400).json({
        message: `Version code must be higher than the latest uploaded version (${latest.versionCode})`,
      });
    }

    const storage = resolvePersistedR2StorageTarget({
      r2Bucket: payload.r2Bucket,
      r2PublicBaseUrl: payload.r2PublicBaseUrl,
    });
    let objectMetadata: Awaited<ReturnType<typeof headR2Object>>;
    try {
      objectMetadata = await headR2Object(storage.bucketName, payload.apkKey);
    } catch {
      return res.status(409).json({
        message: "The uploaded APK was not found in storage. Please upload it again.",
      });
    }
    // A successful presigned PUT response is not proof available here. Verify the final
    // object size before hashing and publishing it to update clients.
    if (Number(objectMetadata.size || 0) !== sizeBytes) {
      return res.status(409).json({
        message: "The APK upload is incomplete. Please upload the file again.",
      });
    }

    const sha256 = await sha256R2Object(storage.bucketName, payload.apkKey);
    const release = await ApkRelease.create({
      platform: "android",
      versionName: payload.versionName,
      versionCode,
      releaseNotes: payload.releaseNotes || "",
      mandatory: Boolean(payload.mandatory),
      apkUrl: getR2PublicUrl(payload.apkKey, storage),
      apkKey: payload.apkKey,
      r2Bucket: storage.bucketName,
      r2PublicBaseUrl: storage.publicBaseUrl,
      sha256,
      sizeBytes,
      originalName: payload.originalName,
      uploadedBy: req.user._id,
      isActive: false,
    });

    // Clients discover only the active row. Activate the fully verified release after
    // its record exists so an incomplete upload is never advertised as latest.
    await ApkRelease.updateMany(
      { platform: "android", isActive: true, _id: { $ne: release._id } },
      { $set: { isActive: false } }
    );
    await ApkRelease.updateOne({ _id: release._id }, { $set: { isActive: true } });

    const populated = await ApkRelease.findById(release._id)
      .populate("uploadedBy", "username email")
      .lean();
    return res.status(201).json({
      message: "APK release uploaded",
      data: serializeRelease(populated),
    });
  } catch (error: any) {
    if (error?.code === 11000) {
      return res.status(409).json({ message: "This APK version was already published" });
    }
    return res.status(500).json({ message: error?.message || "Failed to publish APK release" });
  }
};

export const apkUploadTokenProtect = async (
  req: AdminAuthRequest,
  res: Response,
  next: NextFunction
) => {
  const token =
    String(req.headers["x-apk-upload-token"] || "") ||
    String(req.query?.uploadToken || "");
  if (!token) {
    return res.status(401).json({ message: "APK upload token is required" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as {
      id?: string;
      purpose?: string;
    };
    if (decoded.purpose !== "apk-release-upload" || !decoded.id) {
      return res.status(401).json({ message: "Invalid APK upload token" });
    }
    const user = await User.findById(decoded.id).select("-password");
    if (!user || (user as any).isBlocked) {
      return res.status(401).json({ message: "APK upload token user is not available" });
    }
    if (user.role !== "admin" && user.role !== "superadmin") {
      return res.status(403).json({ message: "Admin privileges required" });
    }
    req.user = user;
    req.userId = String(user._id);
    return next();
  } catch {
    return res.status(401).json({ message: "APK upload token expired or invalid" });
  }
};

function serializeRelease(release: any, currentVersionCode?: number | null) {
  // Keep both latestVersion* and version* names for compatibility with different app
  // generations consuming the same version endpoint.
  const latestVersionCode = Number(release?.versionCode || 0);
  const updateAvailable =
    typeof currentVersionCode === "number" && currentVersionCode > 0
      ? latestVersionCode > currentVersionCode
      : false;

  return {
    id: String(release?._id || ""),
    platform: release?.platform || "android",
    latestVersionName: release?.versionName || "",
    latestVersionCode,
    versionName: release?.versionName || "",
    versionCode: latestVersionCode,
    releaseNotes: release?.releaseNotes || "",
    mandatory: Boolean(release?.mandatory),
    downloadUrl: release?.apkUrl || "",
    apkUrl: release?.apkUrl || "",
    sha256: release?.sha256 || "",
    sizeBytes: Number(release?.sizeBytes || 0),
    originalName: release?.originalName || "",
    isActive: Boolean(release?.isActive),
    uploadedBy: release?.uploadedBy
      ? {
          id: String(release.uploadedBy?._id || release.uploadedBy),
          username: release.uploadedBy?.username,
          email: release.uploadedBy?.email,
        }
      : null,
    createdAt: release?.createdAt,
    updatedAt: release?.updatedAt,
    updateAvailable,
  };
}

async function getLatestAndroidRelease() {
  return ApkRelease.findOne({ platform: "android", isActive: true })
    .sort({ versionCode: -1, createdAt: -1 })
    .populate("uploadedBy", "username email")
    .lean();
}

export const listAdminApkReleases = async (_req: Request, res: Response) => {
  try {
    const releases = await ApkRelease.find({ platform: "android" })
      .sort({ versionCode: -1, createdAt: -1 })
      .populate("uploadedBy", "username email")
      .lean();
    return res.status(200).json({ data: releases.map((release) => serializeRelease(release)) });
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || "Failed to load APK releases" });
  }
};

export const uploadAdminApkRelease = async (req: AdminAuthRequest, res: Response) => {
  // Retained for clients that stream the APK through this server instead of using the
  // newer presigned R2 flow; both paths publish the same release representation.
  const file = req.file as Express.Multer.File | undefined;
  try {
    const diskPath = (file as any)?.path as string | undefined;
    const hasDiskFile = Boolean(diskPath && fs.existsSync(diskPath));
    if (!file || (!file.buffer?.length && !hasDiskFile)) {
      return res.status(400).json({ message: "APK file is required" });
    }

    const originalName = file.originalname || "";
    const hasApkExtension = /\.apk$/i.test(originalName);
    if (!hasApkExtension) {
      return res.status(400).json({ message: "Only Android .apk files are allowed" });
    }

    const versionName = String(req.body?.versionName || "").trim();
    const versionCode = parseVersionCode(req.body?.versionCode);
    if (!versionName) {
      return res.status(400).json({ message: "Version name is required" });
    }
    if (!versionCode) {
      return res.status(400).json({ message: "Version code must be a positive whole number" });
    }

    const existing = await ApkRelease.findOne({ platform: "android", versionCode }).lean();
    if (existing) {
      return res.status(409).json({ message: `Version code ${versionCode} already exists` });
    }

    const latest = await ApkRelease.findOne({ platform: "android" }).sort({ versionCode: -1 }).lean();
    if (latest && Number(latest.versionCode) >= versionCode) {
      return res.status(400).json({
        message: `Version code must be higher than the latest uploaded version (${latest.versionCode})`,
      });
    }

    const storage = getCurrentR2StorageTarget();
    if (!storage.bucketName) {
      return res.status(500).json({ message: "R2_BUCKET_NAME is required to upload APK releases" });
    }

    const sha256 = await sha256ForUpload(file);
    const safeVersion = sanitizeFilePart(versionName);
    const safeName = sanitizeFilePart(originalName.replace(/\.apk$/i, "")) || "asset-insight";
    const apkKey = `apk/android/${versionCode}-${safeVersion || "version"}-${safeName}.apk`;
    const apkUrl = diskPath
      ? await uploadFilePathToR2(
          diskPath,
          APK_CONTENT_TYPE,
          storage.bucketName,
          apkKey,
          file.size
        )
      : await uploadBufferToR2(file.buffer, APK_CONTENT_TYPE, storage.bucketName, apkKey);

    await ApkRelease.updateMany({ platform: "android", isActive: true }, { $set: { isActive: false } });

    const release = await ApkRelease.create({
      platform: "android",
      versionName,
      versionCode,
      releaseNotes: String(req.body?.releaseNotes || "").trim(),
      mandatory: req.body?.mandatory === "true" || req.body?.mandatory === true,
      apkUrl,
      apkKey,
      r2Bucket: storage.bucketName,
      r2PublicBaseUrl: storage.publicBaseUrl,
      sha256,
      sizeBytes: file.size || file.buffer.length,
      originalName,
      uploadedBy: req.user?._id,
      isActive: true,
    });

    const populated = await ApkRelease.findById(release._id)
      .populate("uploadedBy", "username email")
      .lean();
    return res.status(201).json({
      message: "APK release uploaded",
      data: serializeRelease(populated),
    });
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || "Failed to upload APK release" });
  } finally {
    // Multer may spool large APKs to disk; cleanup must run on validation, storage and
    // database failures as well as success.
    await cleanupTempUpload(file);
  }
};

export const getLatestAndroidAppVersion = async (req: Request, res: Response) => {
  try {
    const currentVersionCode = parseVersionCode(req.query?.currentVersionCode);
    const release = await getLatestAndroidRelease();
    if (!release) {
      return res.status(200).json({
        available: false,
        updateAvailable: false,
        message: "No Android APK release is available",
      });
    }
    return res.status(200).json({
      available: true,
      ...serializeRelease(release, currentVersionCode),
    });
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || "Failed to load latest APK version" });
  }
};

export const downloadLatestAndroidApk = async (_req: Request, res: Response) => {
  try {
    const release = await getLatestAndroidRelease();
    if (!release?.apkUrl) {
      return res.status(404).json({ message: "No Android APK release is available" });
    }
    // Do not let intermediaries pin the redirect to an older active release.
    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, release.apkUrl);
  } catch (error: any) {
    return res.status(500).json({ message: error?.message || "Failed to download latest APK" });
  }
};
