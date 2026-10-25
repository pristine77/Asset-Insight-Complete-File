import type { NextFunction, Response } from "express";
import { authenticateReportTransfer, issueReportTransferGrant, recordReportTransferEvent, revokeReportTransferGrant, TransferError, type TransferRequest } from "../service/reportTransferService.js";
import { ActivityError } from "../service/reportActivityService.js";
import { completeUploadSession, getUploadSessionStatus, issueSessionUploadTargets, uploadUploadSessionFile, verifyUploadSessionFile } from "./reportUploadSession.controller.js";
import { uploadSessionFallbackMiddleware } from "../utils/multerStorage.js";
import ReportUploadSession from "../models/reportUploadSession.model.js";

function errorResponse(res: Response, error: unknown) {
  if (error instanceof TransferError || error instanceof ActivityError) return res.status(error.statusCode).json({ code: error.code, message: error.message });
  return res.status(503).json({ code: "REPORT_TRANSFER_TEMPORARILY_UNAVAILABLE", message: "The upload could not finish this attempt. Your saved originals remain on the device. Retry the same upload." });
}
const handle = (work: (req: TransferRequest) => Promise<unknown>) => (req: TransferRequest, res: Response) => {
  res.setHeader("Cache-Control", "no-store, private");
  return work(req).then(data => res.json({ data })).catch(error => errorResponse(res, error));
};
export const postReportTransferGrant = handle(issueReportTransferGrant);
export const deleteReportTransferGrant = handle(revokeReportTransferGrant);
export const postReportTransferEvent = handle(recordReportTransferEvent);
export function requireReportTransfer(req: TransferRequest, res: Response, next: NextFunction) {
  res.setHeader("Cache-Control", "no-store, private");
  return authenticateReportTransfer(req).then(() => next()).catch(error => errorResponse(res, error));
}
export const getReportTransferTargets = handle(async req => {
  if (Object.keys(req.query).some(key => !["cursor", "limit"].includes(key))) throw new TransferError("Unsupported upload target filter.");
  const cursor = Number(req.query.cursor ?? 0), limit = Number(req.query.limit ?? 100);
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TransferError("Request at most 100 upload targets at a time.");
  const session = await ReportUploadSession.findOne({ _id: req.transferSession._id, user: req.userId }, { status: 1, r2Bucket: 1, r2PublicBaseUrl: 1,
    files: { $slice: [cursor, limit] }, expectedFileCount: 1 }).lean() as any;
  if (!session) throw new TransferError("Upload session was not found.", 404, "REPORT_TRANSFER_NOT_FOUND");
  if (["completed", "queued", "processed"].includes(session.status)) throw new TransferError("This upload is already being processed. Check its status.", 409, "UPLOAD_SESSION_LOCKED");
  const files = await issueSessionUploadTargets(session, 0, limit);
  await req.assertTransferAuthorization?.();
  return { files, cursor, nextCursor: cursor + files.length < session.expectedFileCount ? String(cursor + files.length) : null, total: session.expectedFileCount };
});
// These adapters reuse exact existing validation, immutable source keys, and
// report outbox acceptance. Capabilities never reach create/edit/approval APIs.
function bindReceiptIdentity(req: TransferRequest, res: Response) {
  const send = res.json.bind(res);
  res.json = (body: any) => {
    const identity = { ownerId: req.userId, sessionId: String(req.transferGrant.sessionId), type: req.transferGrant.type };
    if (body?.data?.sessionId) body = { ...body, data: { ...body.data, ...identity } };
    else if (body?.accepted === true) body = { ...body, ...identity };
    return send(body);
  };
}
export const getReportTransferStatus = (req: TransferRequest, res: Response) => { bindReceiptIdentity(req, res); return getUploadSessionStatus(req.transferGrant.type)(req, res); };
export const postReportTransferComplete = (req: TransferRequest, res: Response) => { bindReceiptIdentity(req, res); return completeUploadSession(req.transferGrant.type)(req, res); };
export const postReportTransferVerify = (req: TransferRequest, res: Response) => verifyUploadSessionFile(req.transferGrant.type)(req, res);
export const parseReportTransferFile = (req: TransferRequest, res: Response, next: NextFunction) => uploadSessionFallbackMiddleware(req.transferGrant.type)(req, res, next);
export const postReportTransferFile = (req: TransferRequest, res: Response) => uploadUploadSessionFile(req.transferGrant.type)(req, res);
