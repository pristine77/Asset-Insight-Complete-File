import { cleanupArrivalPhotoUpload } from "../middleware/arrivalPhotoUpload.js";
import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware.js";
import { Auctioneer2ClientError } from "../service/auctioneer2Client.js";
import { ArrivalPhotoError, listMyArrivalPhotoRequests, sendArrivalPhotos } from "../service/arrivalPhotoService.js";

/*
 * Arrival photo requests (owner, 2026-11-03; service/arrivalPhotoService.ts):
 * the signed-in user's open requests, and sending one request's photos.
 */

function sendArrivalError(res: Response, error: unknown) {
  if (error instanceof ArrivalPhotoError || error instanceof Auctioneer2ClientError) {
    return res.status(error.statusCode).json({ success: false, message: error.message, code: error.code });
  }
  return res.status(500).json({ success: false, message: "The arrival photos could not be sent. Try again.", code: "arrival_photos_failed" });
}

export async function listArrivalPhotoRequestsController(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) return res.status(401).json({ success: false, message: "Not authorized." });
    return res.json({ success: true, data: await listMyArrivalPhotoRequests(req.userId) });
  } catch (error) {
    return sendArrivalError(res, error);
  }
}

export async function sendArrivalPhotosController(req: AuthRequest, res: Response) {
  try {
    if (!req.userId) return res.status(401).json({ success: false, message: "Not authorized." });
    const files = (req.files ?? []) as Express.Multer.File[];
    const result = await sendArrivalPhotos(req.userId, String(req.params.requestId), files);
    return res.status(201).json({ success: true, data: result });
  } catch (error) {
    return sendArrivalError(res, error);
  } finally {
    await cleanupArrivalPhotoUpload(req);
  }
}
