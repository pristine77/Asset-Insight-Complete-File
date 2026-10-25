import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import AssetReport from "../src/models/asset.model.js";
import LotListing from "../src/models/lotListing.model.js";
import { removeLegacyReportSubmissionClaims } from "../src/service/reportSubmissionClaimMigrationService.js";

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await Promise.all([AssetReport.createIndexes(), LotListing.createIndexes()]);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe.sequential("legacy report contract-claim cleanup", () => {
  it("removes retired claims and bypass flags without changing contract keys", async () => {
    const user = new mongoose.Types.ObjectId();
    const asset = await AssetReport.create({
      user,
      grouping_mode: "single_lot",
      contract_no: " Shared   Contract 500 ",
      submission_contract_claim: "shared contract 500",
      imageUrls: [],
      lots: [],
      status: "processing",
      job_status: "queued",
    });
    const listing = await LotListing.create({
      user,
      contract_no: "Shared Contract 500",
      submission_contract_claim_bypassed: true,
      sales_date: new Date("2026-09-01T00:00:00.000Z"),
      location: "Regina, SK",
      imageUrls: [],
      videoUrls: [],
      lots: [],
      status: "processing",
      job_status: "queued",
    });

    await expect(removeLegacyReportSubmissionClaims()).resolves.toEqual({
      asset: { claimsRemoved: 1, bypassFlagsRemoved: 0 },
      lotListing: { claimsRemoved: 0, bypassFlagsRemoved: 1 },
    });

    const [assetAfter, listingAfter] = await Promise.all([
      AssetReport.findById(asset._id)
        .select("+submission_contract_claim +submission_contract_claim_bypassed")
        .lean(),
      LotListing.findById(listing._id)
        .select("+submission_contract_claim +submission_contract_claim_bypassed")
        .lean(),
    ]);
    expect(assetAfter?.contract_key).toBe("shared contract 500");
    expect(assetAfter?.submission_contract_claim).toBeUndefined();
    expect(listingAfter?.contract_key).toBe("shared contract 500");
    expect(listingAfter?.submission_contract_claim_bypassed).toBeUndefined();

    await expect(removeLegacyReportSubmissionClaims()).resolves.toEqual({
      asset: { claimsRemoved: 0, bypassFlagsRemoved: 0 },
      lotListing: { claimsRemoved: 0, bypassFlagsRemoved: 0 },
    });
  });

  it("allows several active reports for the same normalized contract", async () => {
    const user = new mongoose.Types.ObjectId();
    const common = {
      user,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "processing",
      job_status: "queued",
    };

    await AssetReport.create({ ...common, contract_no: "SPLIT-600" });
    await AssetReport.create({ ...common, contract_no: " split-600 " });

    await expect(removeLegacyReportSubmissionClaims()).resolves.toBeDefined();
    expect(await AssetReport.countDocuments({ user })).toBe(2);
  });
});
