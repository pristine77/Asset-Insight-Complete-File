import type { SmartUploadGroup } from "../models/reportUploadSession.model.js";
import { normalizeDetectedBundleLotNumber } from "./bundleLotAnalysisPolicy.js";

export const LOT_NUMBER_UPLOAD_ALGORITHM_VERSION = "lot-start-photo-v1";
export const isLotNumberUpload = (session: any): boolean => session?.smartGrouping?.method === "lot_number";
export const smartUploadGroupingMethod = (session: any): "black_divider" | "lot_number" =>
  isLotNumberUpload(session) ? "lot_number" : "black_divider";

/** Ordered start photos belong to the following lot; no source photo is excluded. */
export function buildLotNumberUploadGroups(
  orderedFiles: Array<{ fileId: string }>,
  metrics: Array<{ fileId: string; kind?: string; lotNumber?: string | null }>,
  maxImagesPerLot = 200,
): SmartUploadGroup[] {
  const byId = new Map(metrics.map((metric) => [String(metric.fileId), metric]));
  const groups: SmartUploadGroup[] = [];
  for (const file of orderedFiles) {
    const metric = byId.get(String(file.fileId));
    const number = metric?.kind === "lot_start" ? normalizeDetectedBundleLotNumber(metric.lotNumber) : null;
    if (!groups.length || number) {
      groups.push({ groupIndex: groups.length, fileIds: [], imageCount: 0,
        coverFileId: String(file.fileId), overLimit: false, ...(number ? { lotNumber: number } : {}) });
    }
    const group = groups[groups.length - 1]!;
    group.fileIds.push(String(file.fileId));
    group.imageCount += 1;
    group.overLimit = group.imageCount > maxImagesPerLot;
  }
  return groups;
}

/** Number correctness remains reviewable; duplicate identifiers are never merged. */
export function lotNumberUploadWarnings(groups: SmartUploadGroup[]): string[] {
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const [index, group] of groups.entries()) {
    const number = normalizeDetectedBundleLotNumber(group.lotNumber);
    if (!number) warnings.push(`Enter the lot number for group ${index + 1} before confirming.`);
    else if (seen.has(number.toUpperCase())) warnings.push(`Lot number ${number} appears more than once. Review the boundaries and number before confirming.`);
    if (number) seen.add(number.toUpperCase());
    if (group.overLimit) warnings.push(`Lot ${number || index + 1} contains too many photos. Split it so each lot has 200 or fewer.`);
  }
  if (!groups.length) warnings.push("Keep at least one photo in a lot.");
  return warnings;
}

export function applyReviewedGroupNumbers(groups: SmartUploadGroup[], rawGroups: unknown[]): SmartUploadGroup[] {
  return groups.map((group, index) => {
    const number = normalizeDetectedBundleLotNumber((rawGroups[index] as any)?.lotNumber);
    return { ...group, ...(number ? { lotNumber: number } : {}) };
  });
}
