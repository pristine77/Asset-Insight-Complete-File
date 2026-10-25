/**
 * Encodes CRM lifecycle transitions and their follow-up side effects. State validation
 * stays beside transition rules so controllers cannot create impossible combinations;
 * notification/email work is separated from persistence where delivery must not decide
 * whether a valid CRM update commits.
 */
import {
  CRM_LEAD_STATUSES,
  CRM_LOST_REASONS,
  type CrmLeadStatus,
  type CrmLostReason,
} from "../models/crmLead.model.js";
import {
  normalizeCrmPhoneFields,
  phoneFieldsEqual,
} from "../utils/crmPhone.js";
import { clearCrmFollowUp, readCrmFollowUpSchedule } from "./crmFollowUpService.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const LEGACY_STATUS_MAP: Record<string, { status: CrmLeadStatus; lostReason?: CrmLostReason }> = {
  pending: { status: "new_lead" },
  in_progress: { status: "contacted" },
  no_answer: { status: "contacted" },
  completed: { status: "won" },
  not_interested: { status: "lost", lostReason: "not_interested" },
};

export const CRM_OPEN_STATUSES: CrmLeadStatus[] = [
  "new_lead",
  "contacted",
  "inspection_required",
  "inspection_complete",
  "proposal_submitted",
  "decision_pending",
];

export function isCrmStatus(value: string): value is CrmLeadStatus {
  return (CRM_LEAD_STATUSES as readonly string[]).includes(value);
}

export function isCrmLostReason(value: string): value is CrmLostReason {
  return (CRM_LOST_REASONS as readonly string[]).includes(value);
}

export function normalizeCrmLostReason(value: unknown): CrmLostReason | undefined {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return undefined;
  return isCrmLostReason(raw) ? raw : undefined;
}

export function normalizeCrmStatusValue(
  statusValue: unknown,
  lostReasonValue?: unknown
): { status: CrmLeadStatus; lostReason?: CrmLostReason } {
  const rawStatus = String(statusValue || "").trim().toLowerCase();
  const normalizedLostReason = normalizeCrmLostReason(lostReasonValue);

  if (isCrmStatus(rawStatus)) {
    if (rawStatus !== "lost") {
      return { status: rawStatus };
    }

    return {
      status: rawStatus,
      lostReason: normalizedLostReason || "not_interested",
    };
  }

  const legacy = LEGACY_STATUS_MAP[rawStatus];
  if (legacy) {
    return legacy;
  }

  return { status: "new_lead" };
}

export function isCrmClosedStatus(statusValue: unknown): boolean {
  const { status } = normalizeCrmStatusValue(statusValue);
  return status === "won" || status === "lost";
}

export function getCrmReminderCadenceDays(
  statusValue: unknown,
  lostReasonValue?: unknown
): number | null {
  const { status, lostReason } = normalizeCrmStatusValue(statusValue, lostReasonValue);

  if (status === "contacted" || status === "inspection_required" || status === "inspection_complete") {
    return 7;
  }

  if (status === "proposal_submitted" || status === "decision_pending") {
    return 2;
  }

  if (status === "lost" && lostReason && ["not_interested", "timing", "no_assets"].includes(lostReason)) {
    return 30;
  }

  return null;
}

export function computeNextCrmReminderDate(
  statusValue: unknown,
  lostReasonValue?: unknown,
  fromDate?: Date | string | null
): Date | undefined {
  const cadenceDays = getCrmReminderCadenceDays(statusValue, lostReasonValue);
  if (!cadenceDays) return undefined;

  const baseDate =
    fromDate instanceof Date
      ? fromDate
      : fromDate
        ? new Date(fromDate)
        : new Date();

  if (!Number.isFinite(baseDate.getTime())) {
    return new Date(Date.now() + cadenceDays * DAY_MS);
  }

  return new Date(baseDate.getTime() + cadenceDays * DAY_MS);
}

function toValidDate(value: unknown): Date | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value as any);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

export function applyCrmStatusChange(
  lead: any,
  nextStatusValue: unknown,
  lostReasonValue?: unknown,
  changedAt?: Date
): void {
  const changedOn = changedAt && Number.isFinite(changedAt.getTime()) ? changedAt : new Date();
  const { status, lostReason } = normalizeCrmStatusValue(nextStatusValue, lostReasonValue);
  const nextDueDate = computeNextCrmReminderDate(status, lostReason, changedOn);

  lead.set("status", status);
  lead.set("lostReason", lostReason || undefined);
  lead.set("statusChangedAt", changedOn);
  lead.set("taskStartDate", changedOn);
  lead.set("dueDate", nextDueDate || undefined);
  lead.set("dueSoonPushSentAt", undefined);
  lead.set("overduePushSentAt", undefined);

  // A follow-up date the agent picked (crmFollowUpService.ts) outranks the
  // cadence; Won and Lost end it.
  const followUp = readCrmFollowUpSchedule(lead);
  if (followUp) {
    if (status === "won" || status === "lost") {
      clearCrmFollowUp(lead, { now: changedOn, cadenceDueDate: nextDueDate });
    } else {
      lead.set("dueDate", followUp.dueAt);
    }
  }
}

export function normalizeCrmLeadDocument(lead: any): boolean {
  if (!lead) return false;

  let changed = false;
  const normalizedPhones = normalizeCrmPhoneFields({
    phoneRaw: (lead as any).phoneRaw,
    phoneFormatted: (lead as any).phoneFormatted,
    contactPhones: (lead as any).contactPhones,
    contactMobilePhones: (lead as any).contactMobilePhones,
    companyPhones: (lead as any).companyPhones,
  });
  if (!phoneFieldsEqual(lead, normalizedPhones)) {
    // Keep every phone surface consistent so a placeholder primary cannot
    // hide a valid alternate number in web or mobile clients.
    lead.set("phoneRaw", normalizedPhones.phoneRaw);
    lead.set("phoneFormatted", normalizedPhones.phoneFormatted);
    lead.set("contactPhones", normalizedPhones.contactPhones);
    lead.set("contactMobilePhones", normalizedPhones.contactMobilePhones);
    lead.set("companyPhones", normalizedPhones.companyPhones);
    changed = true;
  }
  const normalizedLead = normalizeCrmStatusValue((lead as any).status, (lead as any).lostReason);
  if ((lead as any).status !== normalizedLead.status) {
    lead.set("status", normalizedLead.status);
    changed = true;
  }

  if (((lead as any).lostReason || undefined) !== (normalizedLead.lostReason || undefined)) {
    lead.set("lostReason", normalizedLead.lostReason || undefined);
    changed = true;
  }

  const updates = Array.isArray((lead as any).updates) ? ((lead as any).updates as any[]) : [];
  for (const update of updates) {
    const normalizedUpdate = normalizeCrmStatusValue((update as any)?.status, (update as any)?.lostReason);
    if ((update as any)?.status !== normalizedUpdate.status) {
      (update as any).status = normalizedUpdate.status;
      changed = true;
    }
    if (((update as any)?.lostReason || undefined) !== (normalizedUpdate.lostReason || undefined)) {
      (update as any).lostReason = normalizedUpdate.lostReason || undefined;
      changed = true;
    }
  }

  const existingStatusChangedAt = toValidDate((lead as any).statusChangedAt);
  const fallbackStatusChangedAt =
    toValidDate((lead as any).taskStartDate) ||
    toValidDate((lead as any).updatedAt) ||
    toValidDate((lead as any).createdAt) ||
    new Date();

  const statusChangedAt = existingStatusChangedAt || fallbackStatusChangedAt;
  if (!existingStatusChangedAt) {
    lead.set("statusChangedAt", statusChangedAt);
    changed = true;
  }

  const existingTaskStartDate = toValidDate((lead as any).taskStartDate);
  if (!existingTaskStartDate || existingTaskStartDate.getTime() !== statusChangedAt.getTime()) {
    lead.set("taskStartDate", statusChangedAt);
    changed = true;
  }

  const cadenceDays = getCrmReminderCadenceDays((lead as any).status, (lead as any).lostReason);
  const existingDueDate = toValidDate((lead as any).dueDate);

  // An open lead with a follow-up date is due when the follow-up is.
  const followUp = readCrmFollowUpSchedule(lead);
  if (followUp && normalizedLead.status !== "won" && normalizedLead.status !== "lost") {
    if (!existingDueDate || existingDueDate.getTime() !== followUp.dueAt.getTime()) {
      lead.set("dueDate", followUp.dueAt);
      changed = true;
    }
    return changed;
  }

  if (!cadenceDays) {
    if (normalizedLead.status === "new_lead") {
      return changed;
    }

    if ((lead as any).dueDate) {
      lead.set("dueDate", undefined);
      changed = true;
    }
    return changed;
  }

  if (!existingDueDate) {
    lead.set(
      "dueDate",
      computeNextCrmReminderDate((lead as any).status, (lead as any).lostReason, statusChangedAt)
    );
    changed = true;
  }

  return changed;
}

export function advanceCrmReminderSchedule(lead: any, fromDate?: Date): void {
  const now = fromDate && Number.isFinite(fromDate.getTime()) ? fromDate : new Date();
  const nextDueDate = computeNextCrmReminderDate((lead as any)?.status, (lead as any)?.lostReason, now);

  lead.set("dueDate", nextDueDate || undefined);
  lead.set("dueSoonPushSentAt", undefined);
  lead.set("overduePushSentAt", undefined);
}
