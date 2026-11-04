import multer from "multer";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Request, RequestHandler } from "express";
import { MAX_ARRIVAL_PHOTO_SEND_BYTES, MAX_ARRIVAL_PHOTOS_PER_SEND } from "../service/arrivalPhotoService.js";
import { AUCTIONEER2_PHOTO_MAX_FILE_BYTES } from "../service/auctioneer2Client.js";

type StagedRequest = Request & { arrivalDirectory?: string; arrivalBytes?: number; arrivalCleanup?: () => Promise<void> };
let activeUploads = 0;
const MAX_ACTIVE_ARRIVAL_TRANSFERS = 2;

export async function cleanupArrivalPhotoUpload(req: Request) {
  await (req as StagedRequest).arrivalCleanup?.();
}

const storage: multer.StorageEngine = {
  _handleFile(req, file, callback) {
    const request = req as StagedRequest;
    const path = join(request.arrivalDirectory!, randomUUID());
    let size = 0;
    const limit = new Transform({ transform(chunk, _encoding, done) {
      size += chunk.length;
      request.arrivalBytes = (request.arrivalBytes || 0) + chunk.length;
      if ((request.arrivalBytes || 0) > MAX_ARRIVAL_PHOTO_SEND_BYTES) return done(new Error("ARRIVAL_TOTAL_SIZE"));
      done(null, chunk);
    } });
    pipeline(file.stream, limit, createWriteStream(path, { flags: "wx", mode: 0o600 }))
      .then(() => callback(null, { path, size, filename: path.split("/").pop()!, destination: request.arrivalDirectory! }))
      .catch(async error => { await unlink(path).catch(() => undefined); callback(error); });
  },
  _removeFile(_req, file, callback) { unlink(file.path).then(() => callback(null)).catch(error => callback(error)); },
};
const parse = multer({
  storage,
  limits: { files: MAX_ARRIVAL_PHOTOS_PER_SEND, fileSize: AUCTIONEER2_PHOTO_MAX_FILE_BYTES, fields: 4, parts: MAX_ARRIVAL_PHOTOS_PER_SEND + 4 },
  fileFilter: (_req, file, callback) => /^image\//i.test(file.mimetype) ? callback(null, true) : callback(new Error("ARRIVAL_PHOTOS_ONLY")),
}).array("photos", MAX_ARRIVAL_PHOTOS_PER_SEND);

/** Disk-backed, bounded staging; never hold 60 originals in the API heap. */
export const arrivalPhotoUpload: RequestHandler = async (req, res, next) => {
  if (activeUploads >= MAX_ACTIVE_ARRIVAL_TRANSFERS) {
    res.status(429).json({ success: false, code: "arrival_photos_busy", message: "Photo transfers are busy. Keep your photos and retry shortly." });
    return;
  }
  activeUploads++;
  const request = req as StagedRequest;
  let cleaned = false;
  request.arrivalCleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    activeUploads--;
    if (request.arrivalDirectory) await rm(request.arrivalDirectory, { recursive: true, force: true });
  };
  try {
    request.arrivalDirectory = await mkdtemp(join(tmpdir(), "asset-arrival-"));
    req.once("aborted", () => { void cleanupArrivalPhotoUpload(req); });
    if (req.destroyed) { await cleanupArrivalPhotoUpload(req); return; }
    parse(req, res, async error => {
      if (!error) { next(); return; }
      await cleanupArrivalPhotoUpload(req);
      const typeError = error.message === "ARRIVAL_PHOTOS_ONLY";
      res.status(typeError ? 400 : 413).json({ success: false, code: typeError ? "arrival_photos_invalid_type" : "arrival_photos_upload_limit", message: typeError ? "Arrival requests accept photos only." : "Send up to 60 photos, below 20 MB each and 120 MB total. Keep the photos and retry with a smaller selection." });
    });
  } catch (error) {
    await cleanupArrivalPhotoUpload(req);
    next(error);
  }
};
