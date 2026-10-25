import type { Request, RequestHandler, Response } from "express";
import {
  AnnouncementApiError,
  createAnnouncement,
  listAnnouncementRecipients,
  listAnnouncements,
} from "../service/announcementService.js";

type DeveloperRequest = Request & { userId?: string };

function actorId(req: DeveloperRequest): string {
  if (!req.userId) {
    throw new AnnouncementApiError(401, "UNAUTHORIZED", "Authentication is required");
  }
  return req.userId;
}

function endpoint(
  handler: (req: DeveloperRequest, res: Response) => Promise<void>
): RequestHandler {
  return async (req, res) => {
    try {
      res.setHeader("Cache-Control", "no-store");
      await handler(req as DeveloperRequest, res);
    } catch (error: any) {
      if (error instanceof AnnouncementApiError) {
        res.status(error.status).json({ code: error.code, message: error.message });
        return;
      }
      console.error("Announcement API error", error);
      res.status(500).json({
        code: "ANNOUNCEMENT_INTERNAL_ERROR",
        message: "The announcement request could not be completed",
      });
    }
  };
}

export const getAnnouncementRecipients = endpoint(async (req, res) => {
  const result = await listAnnouncementRecipients({
    search: req.query.search,
    segment: req.query.segment,
    page: req.query.page,
    limit: req.query.limit,
  });
  res.status(200).json(result);
});

export const getAnnouncements = endpoint(async (req, res) => {
  const result = await listAnnouncements({ page: req.query.page, limit: req.query.limit });
  res.status(200).json(result);
});

export const postAnnouncement = endpoint(async (req, res) => {
  const result = await createAnnouncement({
    actorId: actorId(req),
    subject: req.body?.subject,
    heading: req.body?.heading,
    message: req.body?.message,
    audience: req.body?.audience,
    selectedUserIds: req.body?.selectedUserIds,
    requestId: req.body?.requestId,
  });
  res.status(result.idempotent ? 200 : 202).json(result);
});
