/**
 * Repairs historical Auctioneer2 work items that predate user-scoped ownership. The
 * migration is idempotent: already-scoped records are left untouched and only records
 * with an unambiguous linked user are updated, avoiding accidental cross-user claims.
 */
import AuctioneerWorkItem from "../models/auctioneerWorkItem.model.js";
import { auctioneer2ActiveContractKey } from "../utils/auctioneer2WorkItemKeys.js";

type MigrationResult = {
  scanned: number;
  updated: number;
};

function asId(value: unknown): string {
  return value ? String(value).trim() : "";
}

export async function migrateAuctioneer2UserScope(): Promise<MigrationResult> {
  const unsentFilter = {
    status: { $ne: "sent" },
    "delivery.status": { $ne: "sent" },
  };
  const cursor = AuctioneerWorkItem.collection.find(unsentFilter, {
    projection: {
      status: 1,
      claimedBy: 1,
      assignmentUserId: 1,
      activeContractKey: 1,
      cycleKey: 1,
      "contract.id": 1,
      "delivery.completeContract": 1,
      "delivery.manifest": 1,
    },
  });
  let scanned = 0;
  let updated = 0;
  let operations: any[] = [];

  const flush = async () => {
    if (!operations.length) return;
    const result = await AuctioneerWorkItem.collection.bulkWrite(operations, {
      ordered: false,
    });
    updated += result.modifiedCount;
    operations = [];
  };

  for await (const workItem of cursor) {
    scanned += 1;
    const claimedBy = asId(workItem.claimedBy);
    const assignmentUserId = asId(workItem.assignmentUserId) || claimedBy;
    const contractId = asId(workItem.contract?.id);
    const cycleKey = asId(workItem.cycleKey);
    if (!claimedBy || !assignmentUserId || !contractId || !cycleKey) continue;

    const set: Record<string, unknown> = {};
    if (!workItem.assignmentUserId) {
      set.assignmentUserId = workItem.claimedBy;
    }
    if (workItem.status === "claimed" || workItem.status === "report_created") {
      const activeContractKey = auctioneer2ActiveContractKey(
        contractId,
        assignmentUserId,
        cycleKey
      );
      if (workItem.activeContractKey !== activeContractKey) {
        set.activeContractKey = activeContractKey;
      }
    }
    if (workItem.delivery?.completeContract === true) {
      set["delivery.completeContract"] = false;
    }
    const manifest = workItem.delivery?.manifest;
    if (
      manifest &&
      typeof manifest === "object" &&
      !Array.isArray(manifest) &&
      manifest.completeContract === true
    ) {
      set["delivery.manifest"] = {
        ...manifest,
        completeContract: false,
      };
    }
    if (!Object.keys(set).length) continue;

    operations.push({
      updateOne: {
        filter: {
          _id: workItem._id,
          ...unsentFilter,
        },
        update: { $set: set },
      },
    });
    if (operations.length >= 500) await flush();
  }
  await flush();
  return { scanned, updated };
}
