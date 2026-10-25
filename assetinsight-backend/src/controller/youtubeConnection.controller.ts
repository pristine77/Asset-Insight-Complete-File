import type { Response } from "express";
import type { AdminAuthRequest } from "../middleware/admin.middleware.js";
import { beginYoutubeConnection, completeYoutubeConnection, disconnectYoutubeConnection, getYoutubeConnectionStatus, YoutubeConnectionError } from "../service/youtubeConnectionService.js";
import { acknowledgeYoutubeManualRevocation, eraseYoutubeData, revokeYoutubeAccessAndEraseData } from "../service/youtubeDataLifecycleService.js";

function exactBody(req: AdminAuthRequest, fields: string[]): Record<string, any> {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== fields.length || fields.some((field) => !Object.prototype.hasOwnProperty.call(body, field))) throw new YoutubeConnectionError("YOUTUBE_REQUEST_INVALID", "The YouTube request contains missing or unsupported fields.", 400);
  return body;
}

function handle(action: (req: AdminAuthRequest) => Promise<unknown>) {
  return async (req: AdminAuthRequest, res: Response) => {
    res.setHeader("Cache-Control", "no-store, private");
    try {
      if (Object.keys(req.query).length) throw new YoutubeConnectionError("YOUTUBE_REQUEST_INVALID", "This YouTube endpoint does not accept query parameters.", 400);
      return res.status(200).json(await action(req));
    } catch (error) {
      if (error instanceof YoutubeConnectionError) return res.status(error.statusCode).json({ code: error.code, message: error.message });
      // Do not serialize/log OAuth request bodies, token-bearing errors or queries.
      return res.status(500).json({ code: "YOUTUBE_CONNECTION_UNAVAILABLE", message: "YouTube connection settings are temporarily unavailable. Try again." });
    }
  };
}

export const getAdminYoutubeStatus = handle(() => getYoutubeConnectionStatus());
export const connectAdminYoutube = handle((req) => {
  const body = exactBody(req, ["policyConsent"]);
  return beginYoutubeConnection(String(req.userId || ""), body.policyConsent);
});
export const completeAdminYoutube = handle((req) => {
  const body = exactBody(req, ["code", "state"]);
  return completeYoutubeConnection(String(req.userId || ""), body.code, body.state);
});
export const disconnectAdminYoutube = handle((req) => {
  const body = exactBody(req, ["revision"]);
  return disconnectYoutubeConnection(String(req.userId || ""), body.revision);
});
export const revokeAdminYoutube = handle((req) => {
  const body = exactBody(req, ["revision", "confirm"]);
  return revokeYoutubeAccessAndEraseData(String(req.userId || ""), body.revision, body.confirm);
});
export const eraseAdminYoutubeData = handle((req) => {
  const body = exactBody(req, ["revision", "confirm"]);
  return eraseYoutubeData(String(req.userId || ""), body.revision, body.confirm);
});
export const acknowledgeAdminYoutubeRevocation = handle((req) => {
  const body = exactBody(req, ["revision", "confirm"]);
  return acknowledgeYoutubeManualRevocation(String(req.userId || ""), body.revision, body.confirm);
});
