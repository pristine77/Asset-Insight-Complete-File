import mongoose from "mongoose";
import dotenv from "dotenv";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import ReportDraft from "../models/reportDraft.model.js";
import ReportJob from "../models/reportJob.model.js";
import ReportUploadSession from "../models/reportUploadSession.model.js";
import ReportSubmissionAdmission from "../models/reportSubmissionAdmission.model.js";
import { removeLegacyReportSubmissionClaims } from "../service/reportSubmissionClaimMigrationService.js";

dotenv.config();

// This migration must repair duplicate identities before Mongoose attempts to
// build model indexes as part of connection initialization.
mongoose.set("autoIndex", false);

const MAX_INDEX_ATTEMPTS = 5;
const PREVIEW_STATUS_PRIORITY: Record<string, number> = {
  idle: 0,
  error: 1,
  queued: 2,
  processing: 3,
  ready: 4,
};

type DraftRecord = Record<string, any>;

const asTime = (value: unknown) => {
  const timestamp = value ? new Date(value as any).getTime() : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const compareDraftAuthority = (left: DraftRecord, right: DraftRecord) =>
  Number(right.revision || 0) - Number(left.revision || 0) ||
  asTime(right.updatedAt) - asTime(left.updatedAt) ||
  String(right._id).localeCompare(String(left._id));

const comparePreviewLifecycle = (left: DraftRecord, right: DraftRecord) => {
  const leftMatchesRevision =
    Number(left.previewRequestedRevision) === Number(left.revision);
  const rightMatchesRevision =
    Number(right.previewRequestedRevision) === Number(right.revision);
  return (
    Number(rightMatchesRevision) - Number(leftMatchesRevision) ||
    (PREVIEW_STATUS_PRIORITY[String(right.previewStatus)] || 0) -
      (PREVIEW_STATUS_PRIORITY[String(left.previewStatus)] || 0) ||
    asTime(right.previewReadyAt || right.previewRequestedAt) -
      asTime(left.previewReadyAt || left.previewRequestedAt) ||
    asTime(right.updatedAt) - asTime(left.updatedAt)
  );
};

const mediaIdentity = (item: DraftRecord, fallbackIndex: number) =>
  String(
    item.clientFileId ||
      item.localKey ||
      item.mediaId ||
      item.r2Key ||
      `${item.lotId || "lot"}:${item.slot || "main"}:${
        item.originalOrder ?? item.captureOrder ?? item.index ?? fallbackIndex
      }:${item.name || "media"}`
  );

/**
 * Autosave duplicates can each contain confirmed R2 fields that the other row
 * does not yet have. Merge by stable media identity and prefer the authoritative
 * draft while filling only missing transport metadata from sibling rows.
 */
function mergeDraftMedia(drafts: DraftRecord[], canonicalId: unknown) {
  const ordered = [...drafts].sort((left, right) => {
    if (String(left._id) === String(canonicalId)) return -1;
    if (String(right._id) === String(canonicalId)) return 1;
    return compareDraftAuthority(left, right);
  });
  const merged = new Map<string, DraftRecord>();

  ordered.forEach((draft) => {
    (Array.isArray(draft.media) ? draft.media : []).forEach(
      (rawItem: DraftRecord, index: number) => {
        const item = { ...rawItem };
        const key = mediaIdentity(item, index);
        const current = merged.get(key);
        if (!current) {
          merged.set(key, item);
          return;
        }
        for (const [field, value] of Object.entries(item)) {
          if (
            (current[field] === undefined ||
              current[field] === null ||
              current[field] === "") &&
            value !== undefined &&
            value !== null &&
            value !== ""
          ) {
            current[field] = value;
          }
        }
      }
    );
  });

  return [...merged.values()].sort((left, right) => {
    const leftLot = String(left.lotId || "");
    const rightLot = String(right.lotId || "");
    if (leftLot !== rightLot) return leftLot.localeCompare(rightLot);
    const leftSlot = left.slot === "main" ? 0 : left.slot === "extra" ? 1 : 2;
    const rightSlot = right.slot === "main" ? 0 : right.slot === "extra" ? 1 : 2;
    return (
      leftSlot - rightSlot ||
      Number(left.originalOrder ?? left.captureOrder ?? left.index ?? 0) -
        Number(right.originalOrder ?? right.captureOrder ?? right.index ?? 0)
    );
  });
}

const previewLifecyclePatch = (source: DraftRecord) => ({
  previewStatus: source.previewStatus || "idle",
  previewReportId: source.previewReportId || null,
  previewJobId: source.previewJobId || undefined,
  previewRequestedRevision: source.previewRequestedRevision,
  previewProcessedRevision: source.previewProcessedRevision,
  previewError: source.previewError || undefined,
  previewRequestedAt: source.previewRequestedAt,
  previewReadyAt: source.previewReadyAt,
});

async function backfillLegacyClientIds() {
  const legacyDrafts = await ReportDraft.find({
    $or: [
      { clientDraftId: { $exists: false } },
      { clientDraftId: null },
      { clientDraftId: "" },
    ],
  })
    .select("_id")
    .lean();

  if (legacyDrafts.length) {
    await ReportDraft.bulkWrite(
      legacyDrafts.map((draft) => ({
        updateOne: {
          filter: { _id: draft._id },
          // Mongo ids are immutable, making this fallback deterministic and
          // safe when the deployment migration is rerun.
          update: { $set: { clientDraftId: `legacy-${String(draft._id)}` } },
        },
      })),
      { ordered: false }
    );
  }
  return legacyDrafts.length;
}

async function findDuplicateIdentities() {
  return ReportDraft.aggregate<{
    _id: { user: mongoose.Types.ObjectId; type: string; clientDraftId: string };
    ids: mongoose.Types.ObjectId[];
    count: number;
  }>([
    { $match: { clientDraftId: { $type: "string", $ne: "" } } },
    {
      $group: {
        _id: { user: "$user", type: "$type", clientDraftId: "$clientDraftId" },
        ids: { $push: "$_id" },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);
}

/**
 * Retain the newest draft revision and redirect every durable preview reference
 * before deleting duplicate identity rows. R2 objects are not moved or deleted;
 * their descriptors are merged into the retained document.
 */
async function consolidateDuplicateIdentity(ids: mongoose.Types.ObjectId[]) {
  const drafts = (await ReportDraft.find({ _id: { $in: ids } }).lean()) as DraftRecord[];
  if (drafts.length < 2) return 0;

  const authority = [...drafts].sort(compareDraftAuthority)[0];
  const highestRevision = Number(authority.revision || 0);
  const lifecycle =
    [...drafts]
      .filter((draft) => Number(draft.revision || 0) === highestRevision)
      .sort(comparePreviewLifecycle)[0] || authority;
  const duplicateIds = drafts
    .filter((draft) => String(draft._id) !== String(authority._id))
    .map((draft) => draft._id);
  const allIdValues = drafts.flatMap((draft) => [draft._id, String(draft._id)]);

  await ReportDraft.updateOne(
    { _id: authority._id },
    {
      $set: {
        media: mergeDraftMedia(drafts, authority._id),
        ...previewLifecyclePatch(lifecycle),
      },
    },
    { runValidators: false }
  );

  // Hidden report documents and queued jobs may have been created from either
  // racing row. Repoint them before removing the duplicate draft documents.
  await Promise.all([
    AssetReport.updateMany(
      { source_draft_id: { $in: duplicateIds }, is_draft_preview: true } as any,
      { $set: { source_draft_id: authority._id } }
    ),
    LotListing.updateMany(
      { source_draft_id: { $in: duplicateIds }, is_draft_preview: true } as any,
      { $set: { source_draft_id: authority._id } }
    ),
    ReportJob.updateMany(
      { "payload.source_draft_id": { $in: allIdValues } },
      { $set: { "payload.source_draft_id": String(authority._id) } }
    ),
  ]);

  const result = await ReportDraft.deleteMany({ _id: { $in: duplicateIds } });
  return result.deletedCount || 0;
}

async function consolidateDuplicateDrafts() {
  const groups = await findDuplicateIdentities();
  let removed = 0;
  for (const group of groups) {
    removed += await consolidateDuplicateIdentity(group.ids);
  }
  return { groups: groups.length, removed };
}

async function synchronizeIndexesWithRaceRecovery() {
  let totalGroups = 0;
  let totalRemoved = 0;
  for (let attempt = 1; attempt <= MAX_INDEX_ATTEMPTS; attempt += 1) {
    const consolidated = await consolidateDuplicateDrafts();
    totalGroups += consolidated.groups;
    totalRemoved += consolidated.removed;
    try {
      await ReportDraft.syncIndexes();
      return { totalGroups, totalRemoved, attempts: attempt };
    } catch (error: any) {
      // The old application remains live during deployment. If an autosave
      // races index creation, consolidate the new duplicate and retry briefly.
      if (error?.code !== 11000 || attempt === MAX_INDEX_ATTEMPTS) throw error;
      console.warn(
        `A draft autosave raced index creation; retrying (${attempt}/${MAX_INDEX_ATTEMPTS}).`
      );
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  throw new Error("Unable to synchronize report draft indexes.");
}

async function dropIndexIfPresent(
  collection: {
    indexes: () => Promise<Array<{ name?: string }>>;
    dropIndex: (name: string) => Promise<unknown>;
  },
  indexName: string,
) {
  let indexes: Array<{ name?: string }>;
  try {
    indexes = await collection.indexes();
  } catch (error: any) {
    // A brand-new environment may not have created this collection yet.
    if (Number(error?.code) === 26 || error?.codeName === "NamespaceNotFound") {
      return false;
    }
    throw error;
  }
  if (!indexes.some((index) => index.name === indexName)) return false;
  try {
    await collection.dropIndex(indexName);
  } catch (error: any) {
    if (Number(error?.code) === 27 || error?.codeName === "IndexNotFound") {
      return false;
    }
    throw error;
  }
  return true;
}

async function migrateReportDraftIndexes() {
  // Match the production database connector while retaining legacy aliases
  // used by older local and migration environments.
  const mongoUri =
    process.env.MONGODB_URL || process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error("MONGODB_URL, MONGO_URI, or MONGODB_URI is required");
  }

  await mongoose.connect(mongoUri);
  const backfilled = await backfillLegacyClientIds();
  const result = await synchronizeIndexesWithRaceRecovery();
  const retiredIndexes = await Promise.all([
    dropIndexIfPresent(
      AssetReport.collection,
      "uniq_active_asset_contract_claim_per_user",
    ),
    dropIndexIfPresent(
      LotListing.collection,
      "uniq_active_lot_listing_contract_claim_per_user",
    ),
    dropIndexIfPresent(
      ReportUploadSession.collection,
      "uniq_active_upload_contract_claim",
    ),
  ]);
  const reportClaims = await removeLegacyReportSubmissionClaims();
  const uploadClaims = await ReportUploadSession.updateMany(
    { activeContractClaim: { $exists: true } },
    { $unset: { activeContractClaim: 1 } },
  );
  await Promise.all([AssetReport.createIndexes(), LotListing.createIndexes()]);
  await ReportUploadSession.createIndexes();
  // Contract-scoped admission leases were retired with the uniqueness rule.
  // The API and workers are quiesced here, so every remaining lease is stale.
  await ReportSubmissionAdmission.deleteMany({});
  await ReportSubmissionAdmission.createIndexes();
  console.log(
    `Report draft indexes synchronized. Backfilled ${backfilled} legacy draft(s), ` +
      `consolidated ${result.totalGroups} duplicate identity group(s), and removed ` +
      `${result.totalRemoved} superseded row(s). Retired ` +
      `${retiredIndexes.filter(Boolean).length} contract-claim index(es), removed ` +
      `${uploadClaims.modifiedCount} upload claim(s), ` +
      `${reportClaims.asset.claimsRemoved + reportClaims.lotListing.claimsRemoved} ` +
      `report claim(s), and ` +
      `${reportClaims.asset.bypassFlagsRemoved + reportClaims.lotListing.bypassFlagsRemoved} ` +
      `legacy bypass flag(s), in ` +
      `${result.attempts} attempt(s).`
  );
}

migrateReportDraftIndexes()
  .catch((error) => {
    console.error("Report draft index migration failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
