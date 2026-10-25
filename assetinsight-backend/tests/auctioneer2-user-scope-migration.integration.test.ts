import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import AuctioneerWorkItem from "../src/models/auctioneerWorkItem.model.js";
import { migrateAuctioneer2UserScope } from "../src/service/auctioneer2UserScopeMigrationService.js";
import { auctioneer2ActiveContractKey } from "../src/utils/auctioneer2WorkItemKeys.js";

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await AuctioneerWorkItem.createIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("Auctioneer 2.0 user-scope migration", () => {
  it("backfills only unsent work and is idempotent", async () => {
    const claimant = new mongoose.Types.ObjectId();
    const unsent = await AuctioneerWorkItem.create({
      source: "auctioneer2",
      cycleKey: "migration-unsent",
      activeContractKey: "contract-migration",
      contract: {
        id: "contract-migration",
        contractNo: "C-MIGRATION",
      },
      kind: "scheduleA",
      snapshot: {
        tasks: [],
        lots: [],
        capturedAt: new Date(),
      },
      claimedBy: claimant,
      selectedReportType: "asset",
      clientSubmissionId: "migration-unsent",
      status: "report_created",
      delivery: {
        status: "failed",
        completeContract: true,
        manifest: {
          destination: "LottingBoard",
          completeContract: true,
        },
        attempts: 1,
        lots: [],
      },
    });
    const secondUnsent = await AuctioneerWorkItem.create({
      source: "auctioneer2",
      cycleKey: "migration-unsent-two",
      contract: {
        id: "contract-migration",
        contractNo: "C-MIGRATION",
      },
      kind: "scheduleA",
      snapshot: {
        tasks: [],
        lots: [],
        capturedAt: new Date(),
      },
      claimedBy: claimant,
      selectedReportType: "lotListing",
      clientSubmissionId: "migration-unsent-two",
      status: "claimed",
      delivery: {
        status: "not_ready",
        completeContract: false,
        attempts: 0,
        lots: [],
      },
    });
    const sent = await AuctioneerWorkItem.create({
      source: "auctioneer2",
      cycleKey: "migration-sent",
      contract: {
        id: "contract-sent",
        contractNo: "C-SENT",
      },
      kind: "scheduleA",
      snapshot: {
        tasks: [],
        lots: [],
        capturedAt: new Date(),
      },
      claimedBy: new mongoose.Types.ObjectId(),
      selectedReportType: "asset",
      clientSubmissionId: "migration-sent",
      status: "sent",
      delivery: {
        status: "sent",
        completeContract: true,
        attempts: 1,
        lots: [],
      },
    });

    await expect(migrateAuctioneer2UserScope()).resolves.toEqual({
      scanned: 2,
      updated: 2,
    });
    const migrated = await AuctioneerWorkItem.findById(unsent._id).lean();
    const secondMigrated = await AuctioneerWorkItem.findById(
      secondUnsent._id
    ).lean();
    expect(String(migrated?.assignmentUserId)).toBe(String(claimant));
    expect(migrated?.activeContractKey).toBe(
      auctioneer2ActiveContractKey(
        "contract-migration",
        String(claimant),
        "migration-unsent"
      )
    );
    expect(String(secondMigrated?.assignmentUserId)).toBe(String(claimant));
    expect(secondMigrated?.activeContractKey).toBe(
      auctioneer2ActiveContractKey(
        "contract-migration",
        String(claimant),
        "migration-unsent-two"
      )
    );
    expect(secondMigrated?.activeContractKey).not.toBe(
      migrated?.activeContractKey
    );
    expect(migrated?.delivery.completeContract).toBe(false);
    expect(migrated?.delivery.manifest).toMatchObject({
      completeContract: false,
    });

    await expect(migrateAuctioneer2UserScope()).resolves.toEqual({
      scanned: 2,
      updated: 0,
    });
    const untouchedSent = await AuctioneerWorkItem.findById(sent._id).lean();
    expect(untouchedSent?.assignmentUserId).toBeUndefined();
    expect(untouchedSent?.delivery.completeContract).toBe(true);
  });
});
