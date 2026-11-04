import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import {
  AUCTIONEER2_PHOTO_MAX_FILES_PER_REQUEST,
  AUCTIONEER2_PHOTO_MAX_FILE_BYTES,
  AUCTIONEER2_PHOTO_MAX_BATCH_BYTES,
  Auctioneer2ClientError,
  listArrivalPhotoRequests,
  uploadArrivalPhotos,
  type ArrivalPhotoRequestRecord,
  type Auctioneer2Photo,
} from "./auctioneer2Client.js";
import { processImageWithLogo } from "../utils/imageProcessing.js";
import ArrivalPhotoTransfer from "../models/arrivalPhotoTransfer.model.js";

const ARRIVAL_PHOTO_LOGO = "public/logoNobg.png";
export const MAX_ARRIVAL_PHOTOS_PER_SEND = 60;
export const MAX_ARRIVAL_PHOTO_SEND_BYTES = 120 * 1024 * 1024;

export class ArrivalPhotoError extends Error {
  constructor(message: string, readonly statusCode: number, readonly code: string) { super(message); }
}
export type ArrivalPhotoFile = { buffer?: Buffer; path?: string; size?: number; originalname?: string; mimetype?: string };
const bytes = (file: ArrivalPhotoFile) => file.buffer ? Promise.resolve(file.buffer) : readFile(file.path!);
const pendingError = () => new ArrivalPhotoError(
  "Auctioneer has not confirmed the previous arrival photo upload. Keep these photos and ask the auction team to check the request before sending again.",
  409, "arrival_photos_unconfirmed",
);

export async function listMyArrivalPhotoRequests(userId: string): Promise<ArrivalPhotoRequestRecord[]> {
  return listArrivalPhotoRequests(userId);
}

/** Direct, watermarked file transfer. Receipts only; no analysis, report or background job. */
export async function sendArrivalPhotos(userId: string, requestId: string, files: ArrivalPhotoFile[]): Promise<{ sent: number; stored: number; skipped: number; photoCount: number }> {
  if (!userId.trim() || !requestId.trim()) throw new ArrivalPhotoError("An assigned arrival photo request is required.", 400, "arrival_request_required");
  if (!files.length) throw new ArrivalPhotoError("Add at least one photo before sending.", 400, "arrival_photos_required");
  if (files.length > MAX_ARRIVAL_PHOTOS_PER_SEND) throw new ArrivalPhotoError(`Send at most ${MAX_ARRIVAL_PHOTOS_PER_SEND} photos at a time.`, 400, "arrival_photos_too_many");
  const manifest = createHash("sha256");
  let totalBytes = 0;
  // Validate the complete original selection before any external write. Only a
  // single original is read at a time, including the initial content fingerprint.
  for (const file of files) {
    if (!file || !/^image\//i.test(String(file.mimetype || "")) || (!file.buffer && !file.path)) throw new ArrivalPhotoError("Arrival requests accept photos only. Remove other files before sending.", 400, "arrival_photos_invalid_type");
    const size = file.buffer?.length ?? (await stat(file.path!)).size;
    totalBytes += size;
    if (!size || size > AUCTIONEER2_PHOTO_MAX_FILE_BYTES || totalBytes > MAX_ARRIVAL_PHOTO_SEND_BYTES) throw new ArrivalPhotoError("Use photos below 20 MB each and keep the selected upload below 120 MB.", 413, "arrival_photos_too_large");
    manifest.update(createHash("sha256").update(await bytes(file)).digest("hex"));
  }
  const manifestHash = manifest.digest("hex");
  const key = createHash("sha256").update(JSON.stringify([userId, requestId])).digest("hex");
  try {
    await ArrivalPhotoTransfer.updateOne({ _id: key }, { $setOnInsert: { userId, requestId, manifest: manifestHash, state: "ready", nextIndex: 0, stored: 0, skipped: 0, photoCount: 0 } }, { upsert: true });
  } catch (error: any) { if (Number(error?.code) !== 11000) throw error; }
  let receipt: any = await ArrivalPhotoTransfer.findById(key).lean();
  if (!receipt || receipt.manifest !== manifestHash) throw new ArrivalPhotoError("This arrival request already has a different photo selection in progress. Retry with the original selection or ask the auction team to check it.", 409, "arrival_photos_selection_changed");
  if (receipt.state === "complete") return { sent: files.length, stored: receipt.stored, skipped: receipt.skipped, photoCount: receipt.photoCount };
  if (receipt.state !== "ready") throw pendingError();
  const attempt = randomUUID();
  receipt = await ArrivalPhotoTransfer.findOneAndUpdate({ _id: key, manifest: manifestHash, state: "ready" }, { $set: { state: "sending", attempt } }, { returnDocument: "after" }).lean();
  if (!receipt) throw pendingError();
  let externalWritePending = false;
  let externalWriteAttempted = false;
  try {
    let start = receipt.nextIndex;
    let pending: Auctioneer2Photo | undefined;
    while (start < files.length) {
      const batch: Auctioneer2Photo[] = [];
      let batchBytes = 0;
      for (let index = start; index < files.length && batch.length < AUCTIONEER2_PHOTO_MAX_FILES_PER_REQUEST; index++) {
        const file = files[index]!;
        let photo = pending;
        pending = undefined;
        if (!photo) {
          const { buffer } = await processImageWithLogo(await bytes(file), ARRIVAL_PHOTO_LOGO);
          if (!buffer.length || buffer.length > AUCTIONEER2_PHOTO_MAX_FILE_BYTES) throw new ArrivalPhotoError("A watermarked photo exceeds the 20 MB limit. Keep the photos and reduce its size before sending.", 413, "arrival_photo_too_large");
          const base = String(file.originalname || "").replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 60);
          photo = { buffer, contentType: "image/jpeg", filename: `${base || `arrival-photo-${index + 1}`}.jpg`, order: index };
        }
        if (batch.length && batchBytes + photo.buffer.length > AUCTIONEER2_PHOTO_MAX_BATCH_BYTES) { pending = photo; break; }
        batch.push(photo);
        batchBytes += photo.buffer.length;
      }
      externalWritePending = true;
      externalWriteAttempted = true;
      const result = await uploadArrivalPhotos(requestId, userId, batch);
      if (result.photoCount < receipt.stored + result.stored) throw new Auctioneer2ClientError("Auctioneer did not confirm the complete arrival photo count.", { statusCode: 502, upstreamStatus: 201, code: "auctioneer2_invalid_arrival_receipt", ambiguousWrite: true });
      const nextIndex = start + batch.length;
      // Do not admit another batch until its predecessor's receipt is durable.
      receipt = await ArrivalPhotoTransfer.findOneAndUpdate({ _id: key, attempt, state: "sending", nextIndex: start }, {
        $set: { nextIndex, photoCount: result.photoCount, ...(nextIndex === files.length ? { state: "complete" } : {}) },
        $inc: { stored: result.stored, skipped: result.skipped },
      }, { returnDocument: "after" }).lean();
      if (!receipt) throw pendingError();
      externalWritePending = false;
      start = nextIndex;
    }
    return { sent: files.length, stored: receipt.stored, skipped: receipt.skipped, photoCount: receipt.photoCount };
  } catch (error) {
    // A definitive refusal can retry from the last confirmed batch. Network
    // failures, invalid receipts and crashes must not blindly replay bytes.
    const definitiveRefusal = error instanceof Auctioneer2ClientError && error.upstreamStatus != null && error.upstreamStatus >= 400 && error.upstreamStatus < 500 && !error.ambiguousWrite;
    const uncertain = externalWritePending && !definitiveRefusal;
    // Local preparation can fail before a single byte is sent. Release only
    // this untouched claim so the user can correct the image/selection.
    if (!externalWriteAttempted && receipt.nextIndex === 0) {
      await ArrivalPhotoTransfer.deleteOne({ _id: key, attempt, state: "sending", nextIndex: 0 });
      throw error;
    }
    await ArrivalPhotoTransfer.updateOne({ _id: key, attempt, state: "sending" }, { $set: { state: uncertain ? "uncertain" : "ready" } }).catch(() => undefined);
    if (uncertain) throw pendingError();
    throw error;
  }
}
