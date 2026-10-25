import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import AssetReport from "../src/models/asset.model.js";
import LotListing from "../src/models/lotListing.model.js";
import { resolveSubmissionContractClaim } from "../src/service/reportSubmissionConflictService.js";

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

function reportInput(Model: typeof AssetReport | typeof LotListing, user: mongoose.Types.ObjectId) {
  return {
    user,
    contract_no: " Ｃontract   １２３ ",
    imageUrls: [],
    lots: [],
    status: "processing",
    job_status: "queued",
    ...(Model === LotListing
      ? {
          sales_date: new Date("2026-09-03T00:00:00.000Z"),
          location: "Regina",
          videoUrls: [],
        }
      : { grouping_mode: "mixed" }),
  };
}

describe.sequential("report identity", () => {
  it("keeps a normalized contract key for search without using it as identity", async () => {
    const listing = await LotListing.create(
      reportInput(LotListing, new mongoose.Types.ObjectId()),
    );

    expect(listing.contract_key).toBe("contract 123");
    expect(
      resolveSubmissionContractClaim({ contractNo: "contract\t123" }),
    ).toBeUndefined();
  });

  it.each([
    ["Asset", AssetReport],
    ["Lot Listing", LotListing],
  ] as const)(
    "allows concurrent %s reports to share a contract number",
    async (_label, Model) => {
      await Model.syncIndexes();
      const user = new mongoose.Types.ObjectId();
      const make = (clientSubmissionId: string) =>
        Model.create({
          ...reportInput(Model, user),
          client_submission_id: clientSubmissionId,
          job_id: clientSubmissionId,
        } as any);

      const outcomes = await Promise.allSettled([
        make("split-report-a"),
        make("split-report-b"),
      ]);

      expect(outcomes.every((result) => result.status === "fulfilled")).toBe(true);
      expect(await Model.countDocuments({ user })).toBe(2);
    },
  );

  it.each([
    ["Asset", AssetReport],
    ["Lot Listing", LotListing],
  ] as const)(
    "still coalesces exact %s retries by client submission id",
    async (_label, Model) => {
      await Model.syncIndexes();
      const user = new mongoose.Types.ObjectId();
      const make = () =>
        Model.create({
          ...reportInput(Model, user),
          client_submission_id: "same-logical-submission",
          job_id: `job-${new mongoose.Types.ObjectId()}`,
        } as any);

      const outcomes = await Promise.allSettled([make(), make()]);
      expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(Number((outcomes.find((result) => result.status === "rejected") as PromiseRejectedResult).reason?.code)).toBe(11000);
      expect(await Model.countDocuments({ user })).toBe(1);
    },
  );
});
