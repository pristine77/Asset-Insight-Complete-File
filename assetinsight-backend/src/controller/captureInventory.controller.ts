import type { Request, Response } from "express";
import type { AuthRequest } from "../middleware/auth.middleware.js";
import { CaptureInventoryError, saveCaptureInventory, getCaptureAcknowledgement, listCaptureInventory,
  listCaptureUsers, getAdminCaptureInventory, removeCaptureHistory } from "../service/captureInventoryService.js";

function handle(res: Response, work: () => Promise<unknown>) {
  res.setHeader("Cache-Control", "no-store, private");
  return work().then((result) => res.json(result)).catch((error: unknown) => {
    if (error instanceof CaptureInventoryError) return res.status(error.statusCode).json({
      code: error.code, message: error.message, ...(error.data ? { data: error.data } : {}),
    });
    // Never log the client snapshot, file paths or unfiltered database diagnostics.
    return res.status(503).json({ code: "CAPTURE_INVENTORY_UNAVAILABLE", message: "Capture inventory is temporarily unavailable. Your local photos and report workflow are unchanged." });
  });
}
export const putCaptureInventory = (req: AuthRequest, res: Response) => handle(res, () => saveCaptureInventory({ userId: req.userId!, deviceId: req.deviceId, captureId: req.params.captureId, body: req.body }));
export const getCaptureInventory = (req: AuthRequest, res: Response) => handle(res, () => getCaptureAcknowledgement(req.userId!, req.params.captureId));
export const getAdminCaptureInventories = (req: Request, res: Response) => handle(res, () => listCaptureInventory(req.query));
export const getAdminCaptureUsers = (req: Request, res: Response) => handle(res, () => listCaptureUsers(req.query));
export const getAdminCaptureDetail = (req: Request, res: Response) => handle(res, () => getAdminCaptureInventory(req.params.id, req.query));
export const deleteAdminCaptureHistory = (req: AuthRequest, res: Response) => handle(res, () => removeCaptureHistory(req.params.id, req.body, req.userId!));
