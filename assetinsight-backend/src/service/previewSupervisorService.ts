import { Types } from "mongoose";
import User from "../models/user.model.js";
import {
  getSystemSettingValue,
  setSystemSettingValue,
} from "./systemSettingsService.js";

export const PREVIEW_SUPERVISOR_SETTING_KEY = "global_preview_supervisor_user_id";

const PREVIEW_SUPERVISOR_SELECT =
  "email username companyName role avatarUrl isBlocked";

export class PreviewSupervisorSettingError extends Error {}

function toObjectId(value: unknown): Types.ObjectId | null {
  const candidate =
    value && typeof value === "object"
      ? (value as any)._id ?? (value as any).id
      : value;
  const text = String(candidate || "").trim();
  return Types.ObjectId.isValid(text) ? new Types.ObjectId(text) : null;
}

export function normalizePreviewSupervisorId(value: unknown): Types.ObjectId | null {
  return toObjectId(value);
}

/** Any active account may supervise draft and preview follow-up. */
export async function getPreviewSupervisorOptions() {
  return User.find({ isBlocked: { $ne: true }, isReviewAccount: { $ne: true } })
    .select(PREVIEW_SUPERVISOR_SELECT)
    .sort({ username: 1, email: 1 })
    .lean();
}

/**
 * Resolves the one account that supervises saved work across every report owner.
 * A deleted or blocked configured account is treated as unassigned so reminders
 * continue going to owners without leaking to an inactive account.
 */
export async function getConfiguredPreviewSupervisor() {
  const configuredId = normalizePreviewSupervisorId(
    await getSystemSettingValue<unknown>(PREVIEW_SUPERVISOR_SETTING_KEY, null)
  );
  if (!configuredId) return null;

  return User.findOne({
    _id: configuredId,
    isBlocked: { $ne: true },
    isReviewAccount: { $ne: true },
  })
    .select(PREVIEW_SUPERVISOR_SELECT)
    .lean();
}

export async function getGlobalPreviewSupervisorSetting() {
  const [previewSupervisor, options] = await Promise.all([
    getConfiguredPreviewSupervisor(),
    getPreviewSupervisorOptions(),
  ]);
  return { previewSupervisor, options };
}

export async function setGlobalPreviewSupervisorSetting(
  value: unknown,
  updatedBy?: string | Types.ObjectId
) {
  const supervisorId = normalizePreviewSupervisorId(value);
  if (value && !supervisorId) {
    throw new PreviewSupervisorSettingError("Invalid preview supervisor");
  }

  if (supervisorId) {
    const active = await User.exists({
      _id: supervisorId,
      isBlocked: { $ne: true },
      isReviewAccount: { $ne: true },
    });
    if (!active) {
      throw new PreviewSupervisorSettingError(
        "Selected preview supervisor must be an active user"
      );
    }
  }

  await setSystemSettingValue(
    PREVIEW_SUPERVISOR_SETTING_KEY,
    supervisorId ? String(supervisorId) : null,
    updatedBy
  );
  return getGlobalPreviewSupervisorSetting();
}
