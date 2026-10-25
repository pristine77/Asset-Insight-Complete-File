import multer from "multer";
import fs from "fs";
import path from "path";
import type { NextFunction, Request, Response } from "express";
import ReportUploadSession, {
  type ReportUploadSessionType,
} from "../models/reportUploadSession.model.js";
import {
  getUploadSessionFallbackFileLimit,
  getUploadSessionFallbackParserLimit,
  REPORT_UPLOAD_FALLBACK_DEFAULT_MAX_FILE_BYTES,
} from "./uploadSessionFileValidation.js";

const storage = multer.memoryStorage();

const upload = multer({ storage });

const reportJobUploadDir = path.resolve(process.cwd(), "uploads", "report-jobs");
const apkReleaseUploadDir = path.resolve(process.cwd(), "uploads", "apk-releases");
const reportDraftUploadDir = path.resolve(process.cwd(), "uploads", "report-drafts");

const reportJobStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      fs.mkdirSync(reportJobUploadDir, { recursive: true });
      cb(null, reportJobUploadDir);
    } catch (error: any) {
      cb(error, reportJobUploadDir);
    }
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const base = path
      .basename(file.originalname || "upload", ext)
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/--+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80);
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    cb(null, `${unique}-${base || "upload"}${ext}`);
  },
});

export const reportJobUpload = multer({ storage: reportJobStorage });

export const salvageReportUpload = multer({
  storage: reportJobStorage,
  limits: { files: 50, fileSize: 25 * 1024 * 1024, fieldSize: 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpeg|png|webp|heic|heif|tiff|bmp|gif)$/i.test(file.mimetype)) return cb(null, true);
    cb(new Error("Salvage photos must be supported image files."));
  },
});

// The authenticated upload-session fallback accepts one manifest-bound file.
// Keep this separate from reportJobUpload: legacy direct report routes share
// that middleware and may legitimately include larger video attachments.
export const uploadSessionFallbackMiddleware = (
  type: ReportUploadSessionType
) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const session = await ReportUploadSession.findOne({
      _id: req.params.sessionId as any,
      type,
      user: (req as any).userId as any,
    }).select("smartUpload smartGrouping.status status cleanupStartedAt files");
    if (!session) {
      return res.status(404).json({ message: "Upload session not found." });
    }
    if (["completed", "queued", "processed"].includes(session.status)) {
      return res.status(409).json({
        message: "This upload session has already been queued.",
      });
    }
    if (session.cleanupStartedAt) {
      return res.status(409).json({
        code: "UPLOAD_SESSION_CLEANUP_STARTED",
        message: "This expired upload session is being cleaned up and cannot be resumed.",
      });
    }
    if (
      session.smartUpload &&
      String(session.smartGrouping?.status || "uploading") !== "uploading"
    ) {
      return res.status(409).json({
        code: "SMART_UPLOAD_FILES_LOCKED",
        message:
          "Uploaded files cannot be changed after divider detection starts.",
      });
    }
    const manifestFile = session.files.find(
      (entry: any) => String(entry.fileId) === String(req.params.fileId)
    );
    if (!manifestFile) {
      return res.status(404).json({
        message: "Upload file was not found in this session.",
      });
    }

    const maxFileBytes = getUploadSessionFallbackFileLimit({
      smartUpload: session.smartUpload === true,
      declaredBytes: manifestFile.size,
      ordinaryGlobalMaxBytes:
        process.env.REPORT_UPLOAD_FALLBACK_MAX_FILE_BYTES,
    });
    const parserFileSizeLimit =
      getUploadSessionFallbackParserLimit(maxFileBytes);
    const receiveFile = multer({
      storage: reportJobStorage,
      // Busboy's limit event is inclusive. The extra sentinel byte lets a file
      // exactly equal to its allowed manifest size finish parsing; the upload
      // controller then enforces exact equality before writing to R2.
      limits: { fileSize: parserFileSizeLimit, files: 1 },
    }).single("file");

    receiveFile(req, res, (error: any) => {
      if (!error) return next();

      const diskPath =
        typeof (req.file as any)?.path === "string"
          ? String((req.file as any).path)
          : undefined;
      if (diskPath) {
        try {
          fs.unlinkSync(diskPath);
        } catch {
          // Multer normally removes partial disk files itself. Cleanup is best
          // effort here for storage engines/proxies that still expose a path.
        }
      }

      if (error?.code === "LIMIT_FILE_SIZE") {
        const smartUpload = session.smartUpload === true;
        return res.status(413).json({
          code: smartUpload
            ? "SMART_UPLOAD_FILE_SIZE_LIMIT"
            : "UPLOAD_FILE_SIZE_LIMIT",
          message: smartUpload
            ? "Smart Upload fallback images must be 50 MiB or smaller."
            : "The fallback upload is larger than the file declared for this session.",
          data: { maxFileBytes },
        });
      }
      return res.status(400).json({
        code: "INVALID_UPLOAD_SESSION_FILE",
        message: error?.message || "Unable to receive the fallback upload.",
      });
    });
  } catch (error) {
    console.error("[UploadSession] fallback admission failed:", error);
    return res.status(500).json({
      message: "Unable to authorize the fallback upload.",
      data: { maxFileBytes: REPORT_UPLOAD_FALLBACK_DEFAULT_MAX_FILE_BYTES },
    });
  }
};

const reportDraftStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      fs.mkdirSync(reportDraftUploadDir, { recursive: true });
      cb(null, reportDraftUploadDir);
    } catch (error: any) {
      cb(error, reportDraftUploadDir);
    }
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    cb(null, `${unique}${ext.slice(0, 16)}`);
  },
});

// Disk-backed multipart is retained for older mobile clients. New clients use
// presigned R2 targets, so Node never buffers a large draft in memory.
export const reportDraftUpload = multer({
  storage: reportDraftStorage,
  limits: { files: 5000 },
});

const apkReleaseStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      fs.mkdirSync(apkReleaseUploadDir, { recursive: true });
      cb(null, apkReleaseUploadDir);
    } catch (error: any) {
      cb(error, apkReleaseUploadDir);
    }
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || ".apk") || ".apk";
    const base = path
      .basename(file.originalname || "android-release", ext)
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/--+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80);
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    cb(null, `${unique}-${base || "android-release"}${ext}`);
  },
});

export const apkReleaseUpload = multer({
  storage: apkReleaseStorage,
  fileFilter: (_req, file, cb) => {
    const hasApkExtension = /\.apk$/i.test(file.originalname || "");
    // Browsers and proxies report APK MIME types inconsistently, so the
    // upload gate relies on the .apk extension and the controller stores
    // the file with the canonical Android package content type.
    if (hasApkExtension) return cb(null, true);
    return cb(new Error("Only Android .apk files are allowed"));
  },
});

export const uploadDocxOnly = multer({
  storage,
  fileFilter: (req, file, cb) => {
    try {
      const okMime = file.mimetype ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      const okExt = /\.docx$/i.test(file.originalname || "");
      if (okMime && okExt) return cb(null, true);
      return cb(new Error("Only .docx files are allowed"));
    } catch (e) {
      return cb(new Error("Invalid file"));
    }
  },
});

export const uploadAvatarImage = multer({
  storage,
  limits: { files: 1, fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const supported = new Set(["image/jpeg", "image/png", "image/webp"]);
    if (supported.has(String(file.mimetype || "").toLowerCase())) {
      return cb(null, true);
    }
    return cb(new Error("Profile pictures must be JPEG, PNG, or WebP images"));
  },
});

export default upload;
