import crypto from "crypto";
import mongoose from "mongoose";
import Announcement, {
  ANNOUNCEMENT_AUDIENCES,
} from "../models/announcement.model.js";
import AnnouncementDelivery from "../models/announcementDelivery.model.js";
import User from "../models/user.model.js";
import { isReviewReportOwnerId } from "./reviewReportPolicy.js";
import { sendTransactionalEmail } from "../utils/sendVerificationEmail.js";

const DELIVERY_LEASE_MS = 2 * 60_000;
const DELIVERY_BATCH_SIZE = 8;
const MAX_DELIVERY_ATTEMPTS = 3;
const WORKER_INTERVAL_MS = 5_000;

type AnnouncementAudience = (typeof ANNOUNCEMENT_AUDIENCES)[number];

export class AnnouncementApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function boundedText(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): string {
  const text = String(value ?? "").trim();
  if (text.length < minimum || text.length > maximum) {
    throw new AnnouncementApiError(
      400,
      "VALIDATION_ERROR",
      `${label} must be between ${minimum} and ${maximum} characters`
    );
  }
  return text;
}

function positiveInteger(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

function audienceValue(value: unknown): AnnouncementAudience {
  const audience = String(value || "all") as AnnouncementAudience;
  if (!ANNOUNCEMENT_AUDIENCES.includes(audience)) {
    throw new AnnouncementApiError(400, "VALIDATION_ERROR", "Invalid audience");
  }
  return audience;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function recipientName(user: any): string {
  return String(user.username || user.companyName || user.email || "Asset Insight user").trim();
}

function activeUserFilter(extra: Record<string, unknown> = {}) {
  return {
    role: "user",
    isBlocked: { $ne: true },
    isReviewAccount: { $ne: true },
    email: { $type: "string" as const, $ne: "" },
    ...extra,
  };
}

function serializeAnnouncement(row: any) {
  const creator = row.createdBy && typeof row.createdBy === "object" ? row.createdBy : null;
  return {
    id: String(row._id),
    subject: row.subject,
    heading: row.heading,
    message: row.message,
    audience: row.audience,
    status: row.status,
    recipientCount: row.recipientCount || 0,
    sentCount: row.sentCount || 0,
    failedCount: row.failedCount || 0,
    startedAt: row.startedAt || null,
    completedAt: row.completedAt || null,
    lastError: row.lastError || null,
    createdAt: row.createdAt,
    createdBy: creator
      ? {
          id: String(creator._id),
          name: recipientName(creator),
          email: creator.email || "",
        }
      : null,
  };
}

function announcementEmailHtml(input: {
  recipientName: string;
  heading: string;
  message: string;
}): string {
  const body = input.message
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map(
      (paragraph) =>
        `<p style="margin:0 0 16px;color:#344054;font-size:16px;line-height:1.65">${escapeHtml(
          paragraph
        ).replace(/\n/g, "<br/>")}</p>`
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#f4f7fb;font-family:Arial,sans-serif;color:#101828">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f7fb;padding:32px 14px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #dfe5ee;border-radius:12px;overflow:hidden">
        <tr><td style="height:5px;background:#155eef"></td></tr>
        <tr><td style="padding:30px 34px 14px">
          <div style="font-size:13px;font-weight:700;letter-spacing:.08em;color:#155eef;text-transform:uppercase">Asset Insight Announcement</div>
          <h1 style="margin:12px 0 0;font-size:28px;line-height:1.2;color:#101828">${escapeHtml(input.heading)}</h1>
        </td></tr>
        <tr><td style="padding:10px 34px 28px">
          <p style="margin:0 0 18px;color:#344054;font-size:16px;line-height:1.65">Hello ${escapeHtml(input.recipientName)},</p>
          ${body}
        </td></tr>
        <tr><td style="border-top:1px solid #e4e9f0;background:#f8fafc;padding:18px 34px;color:#667085;font-size:12px;line-height:1.5">
          This operational announcement was sent by the Asset Insight team. Please do not reply to this automated email.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

export async function listAnnouncementRecipients(input: {
  search?: unknown;
  segment?: unknown;
  page?: unknown;
  limit?: unknown;
}) {
  const page = positiveInteger(input.page, 1, 100_000);
  const limit = positiveInteger(input.limit, 50, 100);
  const segment = String(input.segment || "all") === "crm" ? "crm" : "all";
  const search = String(input.search || "").trim().slice(0, 120);
  const filter: Record<string, unknown> = activeUserFilter(
    segment === "crm" ? { isCrmAgent: true } : {}
  );
  if (search) {
    const pattern = new RegExp(escapeRegex(search), "i");
    filter.$or = [
      { username: pattern },
      { email: pattern },
      { companyName: pattern },
    ];
  }

  const [users, total, allCount, crmCount] = await Promise.all([
    User.find(filter)
      .select("username email companyName isCrmAgent")
      .sort({ username: 1, email: 1, _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    User.countDocuments(filter),
    User.countDocuments(activeUserFilter()),
    User.countDocuments(activeUserFilter({ isCrmAgent: true })),
  ]);

  return {
    users: users.map((user: any) => ({
      id: String(user._id),
      name: recipientName(user),
      email: user.email,
      companyName: user.companyName || "",
      isCrmAgent: Boolean(user.isCrmAgent),
    })),
    pagination: {
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
    },
    counts: { all: allCount, crm: crmCount },
  };
}

export async function listAnnouncements(input: { page?: unknown; limit?: unknown }) {
  const page = positiveInteger(input.page, 1, 100_000);
  const limit = positiveInteger(input.limit, 20, 50);
  const [rows, total] = await Promise.all([
    Announcement.find({})
      .populate("createdBy", "username email companyName")
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Announcement.countDocuments({}),
  ]);
  return {
    announcements: rows.map(serializeAnnouncement),
    pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
  };
}

async function resolveAnnouncementUsers(
  audience: AnnouncementAudience,
  selectedUserIds: unknown
) {
  if (audience !== "selected") {
    return User.find(
      activeUserFilter(audience === "crm" ? { isCrmAgent: true } : {})
    )
      .select("username email companyName")
      .sort({ _id: 1 })
      .lean();
  }

  const ids = Array.isArray(selectedUserIds)
    ? [...new Set(selectedUserIds.map(String).filter(mongoose.isValidObjectId))]
    : [];
  if (!ids.length || ids.length > 5000) {
    throw new AnnouncementApiError(
      400,
      "VALIDATION_ERROR",
      "Select at least one eligible user"
    );
  }
  return User.find(activeUserFilter({ _id: { $in: ids } }))
    .select("username email companyName")
    .sort({ _id: 1 })
    .lean();
}

export async function createAnnouncement(input: {
  actorId: string;
  subject: unknown;
  heading: unknown;
  message: unknown;
  audience: unknown;
  selectedUserIds: unknown;
  requestId: unknown;
}) {
  const subject = boundedText(input.subject, "Subject", 3, 160);
  const heading = boundedText(input.heading, "Heading", 3, 160);
  const message = boundedText(input.message, "Message", 3, 10_000);
  const audience = audienceValue(input.audience);
  const requestId = boundedText(input.requestId, "Request ID", 8, 100);

  const existing = await Announcement.findOne({
    createdBy: input.actorId,
    requestId,
  })
    .populate("createdBy", "username email companyName")
    .lean();
  if (existing) return { announcement: serializeAnnouncement(existing), idempotent: true };

  const users = await resolveAnnouncementUsers(audience, input.selectedUserIds);
  if (!users.length) {
    throw new AnnouncementApiError(
      400,
      "NO_ELIGIBLE_RECIPIENTS",
      "No active users match this audience"
    );
  }

  let announcement: any;
  try {
    announcement = await Announcement.create({
      subject,
      heading,
      message,
      audience,
      selectedUserIds:
        audience === "selected" ? users.map((user: any) => user._id) : [],
      requestId,
      createdBy: input.actorId,
      recipientCount: users.length,
      status: "queued",
    });
  } catch (error: any) {
    if (error?.code === 11000) {
      const duplicate = await Announcement.findOne({
        createdBy: input.actorId,
        requestId,
      })
        .populate("createdBy", "username email companyName")
        .lean();
      if (duplicate) {
        return { announcement: serializeAnnouncement(duplicate), idempotent: true };
      }
    }
    throw error;
  }

  try {
    await AnnouncementDelivery.insertMany(
      users.map((user: any) => ({
        announcement: announcement._id,
        user: user._id,
        email: String(user.email).trim().toLowerCase(),
        recipientName: recipientName(user),
      })),
      { ordered: false }
    );
  } catch (error) {
    await Promise.all([
      AnnouncementDelivery.deleteMany({ announcement: announcement._id }),
      Announcement.deleteOne({ _id: announcement._id }),
    ]);
    throw error;
  }

  kickAnnouncementDeliveryWorker();
  const populated = await Announcement.findById(announcement._id)
    .populate("createdBy", "username email companyName")
    .lean();
  return { announcement: serializeAnnouncement(populated), idempotent: false };
}

async function refreshAnnouncementStatus(announcementId: mongoose.Types.ObjectId) {
  const counts = await AnnouncementDelivery.aggregate([
    { $match: { announcement: announcementId } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const byStatus = Object.fromEntries(counts.map((row) => [row._id, row.count]));
  const sentCount = Number(byStatus.sent || 0);
  const failedCount = Number(byStatus.failed || 0);
  const activeCount = Number(byStatus.pending || 0) + Number(byStatus.sending || 0);
  const status = activeCount
    ? "sending"
    : sentCount && failedCount
      ? "partial"
      : sentCount
        ? "completed"
        : "failed";
  await Announcement.updateOne(
    { _id: announcementId },
    {
      $set: {
        status,
        sentCount,
        failedCount,
        completedAt: activeCount ? null : new Date(),
        lastError: activeCount || sentCount ? null : "Every delivery failed",
      },
    }
  );
}

async function claimDelivery(announcementId: mongoose.Types.ObjectId) {
  const now = new Date();
  const leaseToken = crypto.randomUUID();
  return AnnouncementDelivery.findOneAndUpdate(
    {
      announcement: announcementId,
      attemptCount: { $lt: MAX_DELIVERY_ATTEMPTS },
      $or: [
        { status: "pending" },
        { status: "sending", leaseUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        status: "sending",
        leaseToken,
        leaseUntil: new Date(now.getTime() + DELIVERY_LEASE_MS),
        error: null,
      },
      $inc: { attemptCount: 1 },
    },
    { returnDocument: "after", sort: { createdAt: 1, _id: 1 } }
  ).lean();
}

async function deliverClaimed(announcement: any, delivery: any) {
  try {
    // Recheck queued recipients too: a saved snapshot predating review-account
    // isolation must not deliver a real operational announcement to reviewers.
    if (await isReviewReportOwnerId(delivery.user)) {
      await AnnouncementDelivery.updateOne(
        { _id: delivery._id, leaseToken: delivery.leaseToken },
        { $set: { status: "failed", error: "Review accounts are excluded from operational announcements" }, $unset: { leaseToken: "", leaseUntil: "" } }
      );
      return;
    }
    const providerMessageId = await sendTransactionalEmail({
      to: delivery.email,
      subject: announcement.subject,
      htmlContent: announcementEmailHtml({
        recipientName: delivery.recipientName,
        heading: announcement.heading,
        message: announcement.message,
      }),
      idempotencyKey: `announcement-${announcement._id}-${delivery._id}`,
    });
    await AnnouncementDelivery.updateOne(
      { _id: delivery._id, leaseToken: delivery.leaseToken },
      {
        $set: {
          status: "sent",
          sentAt: new Date(),
          providerMessageId,
          error: null,
        },
        $unset: { leaseToken: "", leaseUntil: "" },
      }
    );
  } catch (error: any) {
    const terminal = Number(delivery.attemptCount || 0) >= MAX_DELIVERY_ATTEMPTS;
    await AnnouncementDelivery.updateOne(
      { _id: delivery._id, leaseToken: delivery.leaseToken },
      {
        $set: {
          status: terminal ? "failed" : "pending",
          error: String(error?.message || error || "Email delivery failed").slice(0, 1000),
        },
        $unset: { leaseToken: "", leaseUntil: "" },
      }
    );
  }
}

async function processAnnouncement(announcement: any) {
  await Announcement.updateOne(
    { _id: announcement._id, startedAt: null },
    { $set: { status: "sending", startedAt: new Date() } }
  );
  for (let index = 0; index < DELIVERY_BATCH_SIZE; index += 1) {
    const delivery: any = await claimDelivery(announcement._id);
    if (!delivery) break;
    await deliverClaimed(announcement, delivery);
  }
  await refreshAnnouncementStatus(announcement._id);
}

let workerRunning = false;
let workerTimer: NodeJS.Timeout | null = null;

async function runAnnouncementDeliveryWorker() {
  if (workerRunning) return;
  workerRunning = true;
  try {
    const announcement: any = await Announcement.findOne({
      status: { $in: ["queued", "sending"] },
    })
      .sort({ createdAt: 1, _id: 1 })
      .lean();
    if (announcement) await processAnnouncement(announcement);
  } catch (error) {
    console.error("[AnnouncementDelivery] worker failed", error);
  } finally {
    workerRunning = false;
  }
}

export function kickAnnouncementDeliveryWorker(): void {
  const timer = setTimeout(() => void runAnnouncementDeliveryWorker(), 0);
  timer.unref?.();
}

export function startAnnouncementDeliveryWorker(): void {
  if (workerTimer) return;
  kickAnnouncementDeliveryWorker();
  workerTimer = setInterval(
    () => void runAnnouncementDeliveryWorker(),
    positiveInteger(
      process.env.ANNOUNCEMENT_DELIVERY_INTERVAL_MS,
      WORKER_INTERVAL_MS,
      60_000
    )
  );
  workerTimer.unref?.();
}
