import mongoose from "mongoose";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import ReportDraft from "../models/reportDraft.model.js";
import { normalizeDraftContract } from "./reportDraftService.js";
import { legacyReportContractRegex } from "../utils/reportContractIdentity.js";

export const DUPLICATE_LOT_DETECTED = "DUPLICATE_LOT_DETECTED";

export type DuplicateLotConflict = {
  contractNo: string;
  lotNumber: string;
  sourceType: "draft" | "asset" | "lotListing";
  sourceId: string;
  ownerId?: string;
  title?: string;
};

function cleanLotNumber(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/^lot\s*#?\s*/i, "")
    .replace(/\s+/g, " ");
}

function lotNumberKey(value: unknown): string {
  return cleanLotNumber(value).toLocaleLowerCase("en-CA");
}

function explicitLotNumber(lot: any): string {
  return cleanLotNumber(lot?.lot_number ?? lot?.lotNumber ?? lot?.lot_no ?? lot?.lotNo);
}

function reportLots(report: any): any[] {
  const root = Array.isArray(report?.lots) ? report.lots : [];
  const preview = Array.isArray(report?.preview_data?.lots) ? report.preview_data.lots : [];
  return root.length ? root : preview;
}

function currentDraftDuplicates(input: {
  contractNo: string;
  draftId?: string;
  lots: any[];
}): DuplicateLotConflict[] {
  const seen = new Map<string, string>();
  const conflicts: DuplicateLotConflict[] = [];
  for (const lot of input.lots) {
    const lotNumber = explicitLotNumber(lot);
    const key = lotNumberKey(lotNumber);
    if (!key) continue;
    if (seen.has(key)) {
      conflicts.push({
        contractNo: input.contractNo,
        lotNumber,
        sourceType: "draft",
        sourceId: input.draftId || "current",
        title: "This draft contains the lot number more than once",
      });
    } else {
      seen.set(key, lotNumber);
    }
  }
  return conflicts;
}

/**
 * Finds explicit lot-number collisions across every saved draft/report owner.
 * Positional fallback ids are intentionally ignored: only a lot number entered
 * or detected for the user can reserve a contract/lot identity.
 */
export async function findContractLotConflicts(input: {
  contractNo: unknown;
  lots: any[];
  excludeDraftId?: unknown;
  excludeReportId?: unknown;
}): Promise<DuplicateLotConflict[]> {
  const contractNo = String(input.contractNo || "").trim().replace(/\s+/g, " ");
  const contractKey = normalizeDraftContract(contractNo);
  const wanted = new Map<string, string>();
  for (const lot of Array.isArray(input.lots) ? input.lots : []) {
    const lotNumber = explicitLotNumber(lot);
    const key = lotNumberKey(lotNumber);
    if (key && !wanted.has(key)) wanted.set(key, lotNumber);
  }

  const own = currentDraftDuplicates({
    contractNo,
    draftId: input.excludeDraftId ? String(input.excludeDraftId) : undefined,
    lots: Array.isArray(input.lots) ? input.lots : [],
  });
  if (!contractKey || !wanted.size) return own;

  const excludeDraftId = mongoose.isValidObjectId(input.excludeDraftId)
    ? new mongoose.Types.ObjectId(String(input.excludeDraftId))
    : null;
  const excludeReportId = mongoose.isValidObjectId(input.excludeReportId)
    ? new mongoose.Types.ObjectId(String(input.excludeReportId))
    : null;
  const draftFilter: any = {
    normalizedContractNo: contractKey,
    promotedAt: null,
  };
  if (excludeDraftId) draftFilter._id = { $ne: excludeDraftId };
  const reportIdFilter: Record<string, unknown> = excludeReportId
    ? { _id: { $ne: excludeReportId } }
    : {};
  const sourceDraftFilter: Record<string, unknown> = excludeDraftId
    ? { source_draft_id: { $ne: excludeDraftId } }
    : {};
  const legacyContract = legacyReportContractRegex(contractNo);
  // Older Asset records may predate contract_key. The exact normalized-text
  // fallback keeps those reports in the global contract/lot uniqueness check.
  const assetFilter: Record<string, unknown> = {
    ...reportIdFilter,
    ...sourceDraftFilter,
    is_draft_preview: { $ne: true },
    $or: [
      { contract_key: contractKey },
      ...(legacyContract ? [{ contract_no: legacyContract }] : []),
    ],
  };
  const listingFilter: Record<string, unknown> = {
    ...reportIdFilter,
    ...sourceDraftFilter,
    is_draft_preview: { $ne: true },
    $or: [
      { contract_key: contractKey },
      ...(legacyContract ? [{ contract_no: legacyContract }] : []),
    ],
  };

  const [drafts, assets, listings] = await Promise.all([
    ReportDraft.find(draftFilter).select("user contractNo title lots").lean(),
    AssetReport.find(assetFilter as any)
      .select("user contract_no lots preview_data title")
      .lean(),
    LotListing.find(listingFilter as any)
      .select("user contract_no lots preview_data title")
      .lean(),
  ]);

  const conflicts = [...own];
  const append = (
    sourceType: DuplicateLotConflict["sourceType"],
    source: any,
    lots: any[]
  ) => {
    const emitted = new Set<string>();
    for (const lot of lots) {
      const lotNumber = explicitLotNumber(lot);
      const key = lotNumberKey(lotNumber);
      if (!key || emitted.has(key) || !wanted.has(key)) continue;
      emitted.add(key);
      conflicts.push({
        contractNo,
        lotNumber: wanted.get(key) || lotNumber,
        sourceType,
        sourceId: String(source._id),
        ownerId: source.user ? String(source.user) : undefined,
        title: String(source.title || lot?.title || "").trim() || undefined,
      });
    }
  };

  drafts.forEach((draft: any) => append("draft", draft, Array.isArray(draft.lots) ? draft.lots : []));
  assets.forEach((report: any) => append("asset", report, reportLots(report)));
  listings.forEach((report: any) => append("lotListing", report, reportLots(report)));
  return conflicts;
}

export function duplicateLotMessage(conflicts: DuplicateLotConflict[]): string {
  const numbers = Array.from(new Set(conflicts.map((item) => item.lotNumber))).slice(0, 4);
  const suffix = conflicts.length > numbers.length ? ` and ${conflicts.length - numbers.length} more` : "";
  return `Duplicate Lot Detected. Lot ${numbers.join(", ")}${suffix} already exists under this contract. Lot numbers must be unique within a contract.`;
}

export function duplicateLotError(conflicts: DuplicateLotConflict[]) {
  return Object.assign(new Error(duplicateLotMessage(conflicts)), {
    statusCode: 409,
    code: DUPLICATE_LOT_DETECTED,
    conflicts,
  });
}
