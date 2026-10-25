import type { NextFunction, Response } from "express";
import { protect } from "../middleware/auth.middleware.js";
import { DeviceApiError } from "../service/deviceAccessService.js";
import { ActivityError, BackupError, authenticateBackupGrant, backupOriginal, backupTargets, confirmBackupFiles, getBackupPlan, getBackupStatus, issueBackupGrant, listBackupPlans, recordBackupEvent, recordUnregisteredBackupEvent, registerBackupPlan, revokeBackupGrant, type BackupRequest } from "../service/captureBackupService.js";

function errorResponse(res: Response, error: unknown) {
  if (error instanceof BackupError || error instanceof ActivityError) return res.status(error.statusCode).json({ code: error.code, message: error.message });
  // Device challenge tokens and raw storage diagnostics do not belong in a
  // worker response. Foreground sign-in resolves restrictions normally.
  if (error instanceof DeviceApiError) return res.status(error.status >= 500 ? 503 : error.status === 403 ? 403 : 401).json({ code: "BACKUP_AUTHENTICATION_REQUIRED", message: "Open the app to review this device's access before continuing backup." });
  return res.status(503).json({ code: "BACKUP_TEMPORARILY_UNAVAILABLE", message: "Backup could not finish this attempt. The local originals remain on this device; it will retry when available." });
}
export function requireBackupGrant(req: BackupRequest, res: Response, next: NextFunction) {
  res.setHeader("Cache-Control", "no-store, private");
  return authenticateBackupGrant(req).then(() => next()).catch(error => errorResponse(res, error));
}
export function readBackupAuthentication(req: BackupRequest, res: Response, next: NextFunction) {
  return req.get("X-Capture-Backup-Grant") ? requireBackupGrant(req, res, next) : protect(req, res, next);
}
const handle = (work: (req: BackupRequest) => Promise<unknown>) => (req: BackupRequest, res: Response) => {
  res.setHeader("Cache-Control", "no-store, private");
  return work(req).then(data => res.json({ data })).catch(error => errorResponse(res, error));
};
export const postBackupGrant = handle(issueBackupGrant);
export const deleteBackupGrant = handle(revokeBackupGrant);
export const postBackupPlan = handle(registerBackupPlan);
export const getBackupPlans = handle(listBackupPlans);
export const getBackupPlanDetail = handle(getBackupPlan);
export const getBackupPlanStatus = handle(getBackupStatus);
export const postBackupTargets = handle(backupTargets);
export const postBackupConfirm = handle(confirmBackupFiles);
export const postBackupEvent = handle(recordBackupEvent);
export const postUnregisteredBackupEvent = handle(recordUnregisteredBackupEvent);
export const getBackupOriginal = async (req: BackupRequest, res: Response) => {
  res.setHeader("Cache-Control", "no-store, private");
  try {
    const { source, mimeType, size } = await backupOriginal(req);
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Length", String(size));
    res.setHeader("X-Content-Type-Options", "nosniff");
    source.stream.once("error", () => {
      if (res.headersSent) res.destroy();
      else { res.removeHeader("Content-Length"); res.status(503).json({ code: "BACKUP_TEMPORARILY_UNAVAILABLE", message: "The saved original could not be read. Retry restoring this backup." }); }
    });
    res.once("close", () => source.stream.destroy());
    source.stream.pipe(res);
  } catch (error) { errorResponse(res, error); }
};
