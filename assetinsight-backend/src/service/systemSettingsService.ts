/**
 * Provides typed access to database-backed operational flags. Short-lived process-local
 * caches keep hot request paths off MongoDB, and write-through cache updates make
 * changes visible in the writing process immediately while other instances converge
 * within the bounded TTL.
 */
import mongoose from "mongoose";
import SystemSetting from "../models/systemSetting.model.js";

export const AUCTIONEER_SPEC_WEB_SEARCH_SETTING_KEY = "auctioneer_spec_web_search_enabled";
export const ASSET_APPROVAL_THRESHOLD_SETTING_KEY = "asset_auto_approval_threshold";
export const DEFAULT_ASSET_AUTO_APPROVAL_THRESHOLD = 500000;

let specWebSearchCache:
  | { value: boolean; expiresAt: number }
  | null = null;

let assetApprovalThresholdCache:
  | { value: number; expiresAt: number }
  | null = null;

function booleanFromUnknown(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    if (/^(true|1|yes|on|enabled)$/i.test(value.trim())) return true;
    if (/^(false|0|no|off|disabled)$/i.test(value.trim())) return false;
  }
  return fallback;
}

function numberFromUnknown(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number.parseFloat(
    String(value ?? "")
      .replace(/,/g, "")
      .replace(/[^0-9.-]+/g, "")
  );
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeAssetApprovalThreshold(value: unknown): number {
  const parsed = numberFromUnknown(value, DEFAULT_ASSET_AUTO_APPROVAL_THRESHOLD);
  return Math.max(0, Math.round(parsed * 100) / 100);
}

export async function getSystemSettingValue<T = unknown>(
  key: string,
  fallback: T
): Promise<T> {
  const item = await SystemSetting.findOne({ key }).lean();
  return item && Object.prototype.hasOwnProperty.call(item, "value")
    ? (item.value as T)
    : fallback;
}

export async function setSystemSettingValue(
  key: string,
  value: unknown,
  updatedBy?: string | mongoose.Types.ObjectId
) {
  const updatedById = updatedBy
    ? new mongoose.Types.ObjectId(String(updatedBy))
    : undefined;
  const item = await SystemSetting.findOneAndUpdate(
    { key },
    {
      $set: {
        value,
        ...(updatedById ? { updatedBy: updatedById } : {}),
      },
    },
    { new: true, upsert: true }
  ).lean();
  if (key === AUCTIONEER_SPEC_WEB_SEARCH_SETTING_KEY) {
    specWebSearchCache = {
      value: booleanFromUnknown(value, false),
      expiresAt: Date.now() + 5000,
    };
  } else if (key === ASSET_APPROVAL_THRESHOLD_SETTING_KEY) {
    assetApprovalThresholdCache = {
      value: normalizeAssetApprovalThreshold(value),
      expiresAt: Date.now() + 5000,
    };
  }
  return item;
}

export async function isAuctioneerSpecWebSearchEnabled(): Promise<boolean> {
  const now = Date.now();
  if (specWebSearchCache && specWebSearchCache.expiresAt > now) {
    return specWebSearchCache.value;
  }
  const value = await getSystemSettingValue(
    AUCTIONEER_SPEC_WEB_SEARCH_SETTING_KEY,
    false
  );
  const enabled = booleanFromUnknown(value, false);
  specWebSearchCache = { value: enabled, expiresAt: now + 5000 };
  return enabled;
}

export async function setAuctioneerSpecWebSearchEnabled(
  enabled: boolean,
  updatedBy?: string | mongoose.Types.ObjectId
) {
  await setSystemSettingValue(
    AUCTIONEER_SPEC_WEB_SEARCH_SETTING_KEY,
    enabled,
    updatedBy
  );
  return { enabled };
}

export async function getAssetAutoApprovalThreshold(): Promise<number> {
  const now = Date.now();
  if (assetApprovalThresholdCache && assetApprovalThresholdCache.expiresAt > now) {
    return assetApprovalThresholdCache.value;
  }

  const value = await getSystemSettingValue(
    ASSET_APPROVAL_THRESHOLD_SETTING_KEY,
    DEFAULT_ASSET_AUTO_APPROVAL_THRESHOLD
  );
  const threshold = normalizeAssetApprovalThreshold(value);
  assetApprovalThresholdCache = { value: threshold, expiresAt: now + 5000 };
  return threshold;
}

export async function setAssetAutoApprovalThreshold(
  threshold: unknown,
  updatedBy?: string | mongoose.Types.ObjectId
) {
  const normalizedThreshold = normalizeAssetApprovalThreshold(threshold);
  await setSystemSettingValue(
    ASSET_APPROVAL_THRESHOLD_SETTING_KEY,
    normalizedThreshold,
    updatedBy
  );
  return { threshold: normalizedThreshold };
}
