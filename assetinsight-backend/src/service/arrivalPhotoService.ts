/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Arrival photos
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * OWNER, 2026-11-03: Auctioneer 2.0's Awaiting Arrival board gets a "Request
 * Arrival Photos" button that sends a request to a chosen Asset Insight user
 * (Incoming → Arrival Photo Requests), and Lot Listing gets an "Arrival
 * Photos" switch: "the images taken are watermarked and not processed by
 * Asset Insight. They are just images that are sent to Auctioneer and saved
 * in the 'Office Only' section."
 *
 * So this path never creates a work item, a report or a job, and never calls
 * the AI. It lists the signed-in user's open requests from Auctioneer, and
 * for one of them takes the photos, puts the company logo on each (the same
 * processImageWithLogo the reports use; a photo already carrying our logo is
 * left as it is, one logo per photo), and sends them to Auctioneer in batches
 * of five. Auctioneer stores them on the lot as Office Only and marks the
 * request Received, which takes it off the user's list.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import {
  AUCTIONEER2_PHOTO_MAX_FILES_PER_REQUEST,
  listArrivalPhotoRequests,
  uploadArrivalPhotos,
  type ArrivalPhotoRequestRecord,
  type Auctioneer2Photo,
} from "./auctioneer2Client.js";
import { processImageWithLogo } from "../utils/imageProcessing.js";

/** The logo the reports use. */
const ARRIVAL_PHOTO_LOGO = "public/logoNobg.png";

/** The most photos one request takes at a time, so one upload stays a sensible size. */
export const MAX_ARRIVAL_PHOTOS_PER_SEND = 60;

export class ArrivalPhotoError extends Error {
  constructor(message: string, readonly statusCode: number, readonly code: string) {
    super(message);
  }
}

export type ArrivalPhotoFile = { buffer: Buffer; originalname?: string; mimetype?: string };

export async function listMyArrivalPhotoRequests(userId: string): Promise<ArrivalPhotoRequestRecord[]> {
  return listArrivalPhotoRequests(userId);
}

/** Watermark a request's photos and send them to Auctioneer. Nothing is analysed. */
export async function sendArrivalPhotos(
  userId: string,
  requestId: string,
  files: ArrivalPhotoFile[],
): Promise<{ sent: number; stored: number; skipped: number; photoCount: number }> {
  const images = files.filter(file => file?.buffer?.length && String(file.mimetype || "image/").startsWith("image/"));
  if (images.length === 0) {
    throw new ArrivalPhotoError("Add at least one photo before sending.", 400, "arrival_photos_required");
  }
  if (images.length > MAX_ARRIVAL_PHOTOS_PER_SEND) {
    throw new ArrivalPhotoError(`Send at most ${MAX_ARRIVAL_PHOTOS_PER_SEND} photos at a time.`, 400, "arrival_photos_too_many");
  }

  const watermarked: Auctioneer2Photo[] = [];
  for (const [index, file] of images.entries()) {
    const { buffer } = await processImageWithLogo(file.buffer, ARRIVAL_PHOTO_LOGO);
    const base = String(file.originalname || "").replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 60);
    watermarked.push({
      buffer,
      contentType: "image/jpeg",
      filename: `${base || `arrival-photo-${index + 1}`}.jpg`,
      order: index,
    });
  }

  let stored = 0;
  let skipped = 0;
  let photoCount = 0;
  for (let start = 0; start < watermarked.length; start += AUCTIONEER2_PHOTO_MAX_FILES_PER_REQUEST) {
    const result = await uploadArrivalPhotos(requestId, userId, watermarked.slice(start, start + AUCTIONEER2_PHOTO_MAX_FILES_PER_REQUEST));
    stored += result.stored;
    skipped += result.skipped;
    photoCount = result.photoCount;
  }
  return { sent: watermarked.length, stored, skipped, photoCount };
}
