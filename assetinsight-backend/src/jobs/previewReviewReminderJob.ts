import type { Model } from "mongoose";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import ReportDraft from "../models/reportDraft.model.js";
import User from "../models/user.model.js";
import { getConfiguredPreviewSupervisor } from "../service/previewSupervisorService.js";
import {
  sendPreviewReminder,
  type ReminderOwner,
} from "../service/previewReminderService.js";

const DEFAULT_REMINDER_HOURS = 12;
const DEFAULT_INTERVAL_MS = 15 * 60 * 1_000;
const DEFAULT_CLAIM_TTL_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_PER_SWEEP = 100;

type ReminderKind = "draft" | "preview";
type ReminderCandidate = {
  _id: unknown;
  user?: unknown;
  type?: "asset" | "lotListing";
  contractNo?: string;
  contract_no?: string;
  updatedAt?: Date;
  createdAt?: Date;
  previewReadyAt?: Date;
  processing_completed_at?: Date;
  reviewReminderRecipientIds?: unknown[];
  preview_reminder_recipient_ids?: unknown[];
};

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function recipientId(value: unknown): string {
  return String((value as any)?._id ?? value ?? "").trim();
}

function recipientName(value: ReminderOwner | null | undefined): string {
  return (
    String(value?.username || "").trim() ||
    String(value?.companyName || "").trim() ||
    String(value?.email || "").trim() ||
    "the report owner"
  );
}

async function reminderRecipients(
  ownerId: unknown,
  configuredSupervisor: ReminderOwner | null
): Promise<{
  owner: ReminderOwner | null;
  recipients: ReminderOwner[];
}> {
  const owner: any = await User.findById(ownerId)
    .select("username email companyName isBlocked isReviewAccount")
    .lean();
  if (!owner) return { owner: null, recipients: [] };

  // The supervisor is a singleton operational setting. Combining it with the
  // owner here preserves owner reminders and de-duplicates self-supervision.
  const possible = [owner, owner.isReviewAccount === true ? null : configuredSupervisor].filter(Boolean) as ReminderOwner[];
  const seen = new Set<string>();
  const recipients = possible.filter((candidate) => {
    const id = recipientId(candidate._id);
    const email = String(candidate.email || "").trim();
    if (!id || !email || candidate.isBlocked || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return { owner, recipients };
}

function reminderMessage(input: {
  kind: ReminderKind;
  reportType: "Asset" | "LotListing";
  owner: ReminderOwner | null;
  recipient: ReminderOwner;
}) {
  const typeLabel = input.reportType === "Asset" ? "Asset Report" : "Lot Listing";
  const workLabel = input.kind === "draft" ? "draft" : "preview";
  const isOwner = recipientId(input.owner?._id) === recipientId(input.recipient._id);
  if (isOwner) {
    return `Your ${typeLabel} ${workLabel} has been waiting for review for at least 12 hours. Please open it, review the saved work, and approve/submit it as soon as possible.`;
  }
  return `${recipientName(input.owner)}'s ${typeLabel} ${workLabel} has been waiting for review for at least 12 hours. As their Preview Supervisor, please follow up and help ensure it is reviewed and submitted.`;
}

function draftClaimFilter(cutoff: Date, claimExpiredBefore: Date) {
  return {
    reviewReminderSentAt: null,
    promotedAt: null,
    promotionToken: null,
    updatedAt: { $lte: cutoff },
    previewStatus: { $in: ["idle", "ready", "error"] },
    $or: [
      { reviewReminderClaimedAt: null },
      { reviewReminderClaimedAt: { $exists: false } },
      { reviewReminderClaimedAt: { $lte: claimExpiredBefore } },
    ],
  };
}

export function previewClaimFilter(cutoff: Date, claimExpiredBefore: Date) {
  return {
    is_draft_preview: { $ne: true },
    status: "preview",
    preview_submitted_at: null,
    approval_requested_at: null,
    preview_reminder_sent_at: null,
    // A reviewed manual send owns delivery, including uncertain provider
    // outcomes. Never let the background reminder become a second attempt.
    preview_reminder_delivery_id: null,
    $and: [
      {
        $or: [
          { processing_completed_at: { $lte: cutoff } },
          {
            processing_completed_at: null,
            updatedAt: { $lte: cutoff },
          },
          {
            processing_completed_at: { $exists: false },
            updatedAt: { $lte: cutoff },
          },
        ],
      },
      {
        $or: [
          { preview_reminder_claimed_at: null },
          { preview_reminder_claimed_at: { $exists: false } },
          { preview_reminder_claimed_at: { $lte: claimExpiredBefore } },
        ],
      },
    ],
  };
}

async function claimOne(
  model: Model<any>,
  kind: ReminderKind,
  cutoff: Date,
  claimExpiredBefore: Date
): Promise<ReminderCandidate | null> {
  const claimField = kind === "draft" ? "reviewReminderClaimedAt" : "preview_reminder_claimed_at";
  return model
    .findOneAndUpdate(
      kind === "draft"
        ? draftClaimFilter(cutoff, claimExpiredBefore)
        : previewClaimFilter(cutoff, claimExpiredBefore),
      { $set: { [claimField]: new Date() } },
      // A claim is operational metadata, not user activity. Suppressing the
      // timestamp keeps the original inactivity clock stable.
      { new: true, timestamps: false }
    )
    .lean();
}

async function updateReminderState(input: {
  model: Model<any>;
  id: unknown;
  kind: ReminderKind;
  set?: Record<string, unknown>;
  addRecipientId?: string;
}) {
  const recipientField =
    input.kind === "draft" ? "reviewReminderRecipientIds" : "preview_reminder_recipient_ids";
  const update: Record<string, unknown> = {};
  if (input.set && Object.keys(input.set).length) update.$set = input.set;
  if (input.addRecipientId) update.$addToSet = { [recipientField]: input.addRecipientId };
  await input.model.updateOne({ _id: input.id }, update, { timestamps: false });
}

async function deliverCandidate(input: {
  model: Model<any>;
  kind: ReminderKind;
  candidate: ReminderCandidate;
  configuredSupervisor: ReminderOwner | null;
}) {
  const { owner, recipients } = await reminderRecipients(
    input.candidate.user,
    input.configuredSupervisor
  );
  const sentIds = new Set(
    (input.kind === "draft"
      ? input.candidate.reviewReminderRecipientIds
      : input.candidate.preview_reminder_recipient_ids
    )?.map(recipientId) || []
  );
  const reportType: "Asset" | "LotListing" =
    input.kind === "draft"
      ? input.candidate.type === "lotListing"
        ? "LotListing"
        : "Asset"
      : input.model.modelName === LotListing.modelName
        ? "LotListing"
        : "Asset";
  const contractNo = String(input.candidate.contractNo || input.candidate.contract_no || "").trim();
  const waitingSince = new Date(
    input.kind === "draft"
      ? input.candidate.updatedAt || input.candidate.createdAt || Date.now()
      : input.candidate.processing_completed_at ||
          input.candidate.updatedAt ||
          input.candidate.createdAt ||
          Date.now()
  );
  const webUrl = String(
    process.env.WEB_APP_URL || process.env.CLIENT_URL || "http://localhost:3000"
  ).replace(/\/+$/, "");
  const route = input.kind === "draft" ? "/dashboard" : "/previews";
  const targetUrl =
    input.kind === "draft"
      ? `${webUrl}/dashboard?view=drafts&draftId=${encodeURIComponent(String(input.candidate._id))}`
      : `${webUrl}/previews?reportId=${encodeURIComponent(String(input.candidate._id))}&reportType=${
          reportType === "Asset" ? "asset" : "lotListing"
        }`;

  if (!recipients.length) {
    await updateReminderState({
      model: input.model,
      id: input.candidate._id,
      kind: input.kind,
      set:
        input.kind === "draft"
          ? {
              reviewReminderSentAt: new Date(),
              reviewReminderClaimedAt: null,
              reviewReminderError: "No active reminder recipient has an email address.",
            }
          : {
              preview_reminder_sent_at: new Date(),
              preview_reminder_claimed_at: null,
              preview_reminder_error: "No active reminder recipient has an email address.",
            },
    });
    return;
  }

  for (const recipient of recipients) {
    const id = recipientId(recipient._id);
    if (sentIds.has(id)) continue;
    const isSupervisor = id !== recipientId(owner?._id);
    await sendPreviewReminder({
      reportId: String(input.candidate._id),
      reportType,
      contractNo,
      waitingSince,
      message: reminderMessage({ kind: input.kind, reportType, owner, recipient }),
      owner: recipient,
      kind: input.kind,
      targetUrl,
      notificationRoute: route,
      notificationTitle: `${input.kind === "draft" ? "Draft" : "Preview"} waiting for review`,
      notificationBody: isSupervisor
        ? `${recipientName(owner)} has a pending ${reportType === "Asset" ? "Asset Report" : "Lot Listing"} ${input.kind}.`
        : `Your ${reportType === "Asset" ? "Asset Report" : "Lot Listing"} ${input.kind} is waiting for review and submission.`,
    });
    sentIds.add(id);
    await updateReminderState({
      model: input.model,
      id: input.candidate._id,
      kind: input.kind,
      addRecipientId: id,
    });
  }

  await updateReminderState({
    model: input.model,
    id: input.candidate._id,
    kind: input.kind,
    set:
      input.kind === "draft"
        ? {
            reviewReminderSentAt: new Date(),
            reviewReminderClaimedAt: null,
            reviewReminderError: "",
          }
        : {
            preview_reminder_sent_at: new Date(),
            preview_reminder_claimed_at: null,
            preview_reminder_error: "",
          },
  });
}

async function releaseFailedClaim(input: {
  model: Model<any>;
  id: unknown;
  kind: ReminderKind;
  error: unknown;
}) {
  const message = String((input.error as any)?.message || input.error || "Reminder delivery failed").slice(0, 1_000);
  await updateReminderState({
    model: input.model,
    id: input.id,
    kind: input.kind,
    set:
      input.kind === "draft"
        ? { reviewReminderClaimedAt: null, reviewReminderError: message }
        : { preview_reminder_claimed_at: null, preview_reminder_error: message },
  });
}

export async function runPreviewReviewReminderSweep() {
  const reminderHours = positiveNumber(
    process.env.REPORT_REVIEW_REMINDER_HOURS,
    DEFAULT_REMINDER_HOURS
  );
  const claimTtlMs = positiveNumber(
    process.env.REPORT_REVIEW_REMINDER_CLAIM_TTL_MS,
    DEFAULT_CLAIM_TTL_MS
  );
  const maxPerSweep = Math.floor(
    positiveNumber(process.env.REPORT_REVIEW_REMINDER_MAX_PER_SWEEP, DEFAULT_MAX_PER_SWEEP)
  );
  const cutoff = new Date(Date.now() - reminderHours * 60 * 60 * 1_000);
  const claimExpiredBefore = new Date(Date.now() - claimTtlMs);
  const queues: Array<{ model: Model<any>; kind: ReminderKind }> = [
    { model: ReportDraft, kind: "draft" },
    { model: AssetReport, kind: "preview" },
    { model: LotListing, kind: "preview" },
  ];
  // Resolve once per sweep so every candidate observes one consistent global
  // supervisor and the worker does not issue a settings query per report.
  const configuredSupervisor = await getConfiguredPreviewSupervisor();
  let handled = 0;

  for (const queue of queues) {
    while (handled < maxPerSweep) {
      const candidate = await claimOne(queue.model, queue.kind, cutoff, claimExpiredBefore);
      if (!candidate) break;
      handled += 1;
      try {
        await deliverCandidate({ ...queue, candidate, configuredSupervisor });
      } catch (error) {
        console.error("[PreviewReminderJob] Delivery failed", {
          kind: queue.kind,
          id: String(candidate._id),
          error,
        });
        await releaseFailedClaim({ ...queue, id: candidate._id, error });
      }
    }
    if (handled >= maxPerSweep) break;
  }
  return handled;
}

export function startPreviewReviewReminderJob() {
  if (process.env.REPORT_REVIEW_REMINDER_ENABLED === "false") return;
  const intervalMs = positiveNumber(
    process.env.REPORT_REVIEW_REMINDER_INTERVAL_MS,
    DEFAULT_INTERVAL_MS
  );
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await runPreviewReviewReminderSweep();
    } catch (error) {
      console.error("[PreviewReminderJob] Sweep failed", error);
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref();
}
