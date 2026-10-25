import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import ExcelJS from "exceljs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generateAssetXlsxFromReport, generateLotListingXlsxFromReport } from "../src/service/xlsx/assetXlsxService.js";

let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let AssetReport: typeof import("../src/models/asset.model.js")["default"];
let LotListing: typeof import("../src/models/lotListing.model.js")["default"];

const userHeaders = (id: string) => ({
  Authorization: `Bearer ${jwt.sign(
    { id, role: "admin" },
    process.env.JWT_SECRET!,
    { expiresIn: "30m" }
  )}`,
});

const createPhotoFixture = () => {
  const imageUrls = Array.from(
    { length: 40 },
    (_, index) => `https://images.sellsnap.store/uploads/lot-listing/photo-${index}.jpg`
  );
  const lots = Array.from({ length: 20 }, (_, index) => {
    const firstImageIndex = index * 2;
    return {
      lot_id: `lot-${index + 1}`,
      lot_number: String(1001 + index),
      title: `Lot ${1001 + index}`,
      description: `Lot ${1001 + index}`,
      estimated_value: "CAD 100",
      image_indexes: [firstImageIndex, firstImageIndex + 1],
      image_urls: [imageUrls[firstImageIndex], imageUrls[firstImageIndex + 1]],
      extra_image_indexes: [] as number[],
      extra_image_urls: [] as string[],
    };
  });
  return { imageUrls, lots };
};

const previewAfterDeletingFirstPhotoFromLot1012 = (
  lotsValue: ReturnType<typeof createPhotoFixture>["lots"],
  deletedUrl: string
) => {
  const lots = JSON.parse(JSON.stringify(lotsValue));
  lots[11].image_indexes = [23];
  lots[11].image_urls = [lotsValue[11].image_urls[1]];
  return {
    contract_no: "PHOTO-SYNC-20",
    currency: "CAD",
    lots,
    deleted_image_indexes: [22],
    deleted_image_urls: [deletedUrl],
  };
};

const expectPhotoReferencesSynchronized = (
  previewData: any,
  imageUrls: string[]
) => {
  expect(previewData.lots).toHaveLength(20);
  for (const lot of previewData.lots) {
    const resolved = (lot.image_indexes || []).map((index: number) => imageUrls[index]);
    expect(resolved).toEqual(lot.image_urls);
  }
  const lot1013 = previewData.lots.find((lot: any) => String(lot.lot_number) === "1013");
  const lot1014 = previewData.lots.find((lot: any) => String(lot.lot_number) === "1014");
  expect(lot1013.image_indexes).toEqual([23, 24]);
  expect(lot1014.image_indexes).toEqual([25, 26]);
  expect(lot1014.image_urls).not.toContain(lot1013.image_urls[1]);
};

beforeAll(async () => {
  process.env.JWT_SECRET ||= "preview-photo-sync-test-secret";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: AssetReport } = await import("../src/models/asset.model.js"));
  ({ default: LotListing } = await import("../src/models/lotListing.model.js"));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

async function createOwner() {
  return User.create({
    email: "photo-sync@example.test",
    username: "photo-sync",
    companyName: "Photo Sync Tests",
    password: await bcrypt.hash("Password123!", 4),
    authProvider: "email",
    isVerified: true,
    role: "admin",
  });
}

describe.sequential("preview photo save synchronization", () => {
  it.each(["asset", "lotListing"] as const)("exports the assigned approver's %s Title edit while retaining the complete snapshot", async kind => {
    const owner = await createOwner();
    const approver = await User.create({ email: "title-approver@example.test", username: "title-approver", password: "Password123!",
      authProvider: "email", isVerified: true, role: "admin" });
    const Model = kind === "asset" ? AssetReport : LotListing;
    const { lots, imageUrls } = createPhotoFixture();
    lots[0].description = "Independent narrative retained but no longer printed in the Description output";
    const report = await (Model as any).create({ user: owner._id, approval_assigned_to: approver._id,
      grouping_mode: "single_lot", status: "pending_approval", job_status: "done", contract_no: "ASSIGNED-TITLE",
      sales_date: new Date(), location: "Regina, SK", imageUrls, lots,
      preview_data: { contract_no: "ASSIGNED-TITLE", lots } });
    const title = "Assigned reviewer Title TEST with the complete equipment name beyond sixty characters";
    const edited = { contract_no: "ASSIGNED-TITLE", lots: lots.map((lot, index) => index ? lot : { ...lot, title }) };
    const saved = await request(app).put(`/api/reports/assigned-approvals/${report._id}/preview`)
      .set(userHeaders(String(approver._id))).send({ preview_data: edited });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const persisted = await (Model as any).findById(report._id).lean();
    // Assigned Asset save keeps the canonical edit in preview_data until the
    // generation handoff; Lot Listing synchronizes the root immediately.
    expect(persisted.lots[0]).toMatchObject({ title: kind === "asset" ? lots[0].title : title, description: lots[0].description });
    expect(persisted.preview_data.lots[0]).toMatchObject({ title, description: lots[0].description });
    expect(persisted.imageUrls).toEqual(imageUrls);
    expect(persisted.lots.map((lot: any) => lot.image_urls)).toEqual(lots.map(lot => lot.image_urls));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await (kind === "asset" ? generateAssetXlsxFromReport : generateLotListingXlsxFromReport)(persisted.preview_data));
    expect(workbook.getWorksheet("Sheet1")!.getCell("B2").value).toBe(title);
    const sheet = workbook.getWorksheet("Sheet1")!;
    expect(Array.from({ length: 20 }, (_, index) => sheet.getCell(index + 2, 1).value)).toEqual(lots.map(lot => lot.lot_number));
    expect(sheet.getCell("B22").value).toBeNull();
  });

  it.each([
    ["asset", "preview", false], ["lotListing", "preview", false],
    ["asset", "error", false], ["lotListing", "error", false],
    ["asset", "preview", true], ["lotListing", "preview", true],
  ] as const)("preserves complete descriptions across save/reopen (%s, %s, draft=%s)", async (kind, status, draft) => {
    const owner = await createOwner();
    const Model = kind === "asset" ? AssetReport : LotListing;
    const path = kind === "asset" ? "/api/asset" : "/api/lot-listing";
    const imageUrls = ["https://assetinsight.test/greenhouse.jpg", "https://assetinsight.test/pump.jpg"];
    const lots = ["730", "731"].map((number, i) => ({
      lot_id: `lot-${number}`, lot_number: number, title: i === 0 ? "Leafy Green Machine (Greenhouse)" : "Irrigation pump",
      description: "Original description", estimated_value: "CA$18,000", image_indexes: [i], image_urls: [imageUrls[i]],
    }));
    const report = await (Model as any).create({
      user: owner._id, grouping_mode: "single_lot", contract_no: "DESCRIPTION-RECOVERY",
      sales_date: new Date(), location: "Regina, SK", currency: "CAD", imageUrls, lots, status,
      job_status: status === "error" ? "error" : "done", is_draft_preview: draft,
      preview_data: { contract_no: "DESCRIPTION-RECOVERY", currency: "CAD", location: "Regina, SK", lots },
    });
    const descriptions = [
      "Websites for reference: https://www.freightfarms.com/\n\nLeafy Green Machine (Greenhouse). Includes growing racks, LED lighting and climate controls.\n- Irrigation equipment included.\n- Condition: Inspected by owner; verification needed.\nÉquipement supplémentaire — no text should disappear.",
      "Separate pump details\nSecond lot has its own accessories and inspection notes.\nLegal: N/A; keep this user-written information.\nReference: https://example.test/pump?model=731&condition=used",
    ];
    const titles = ["Edited greenhouse Title with growing racks, LED lighting and complete climate controls TEST", "Edited irrigation pump Title TEST"];
    const preview = { contract_no: "DESCRIPTION-RECOVERY", currency: "CAD", location: "Regina, SK", lots: lots.map((lot, i) => ({ ...lot, title: titles[i], description: descriptions[i] })) };
    for (let pass = 0; pass < 2; pass++) {
      const saved = await request(app).put(`${path}/${report._id}/preview`).set(userHeaders(String(owner._id))).send({ preview_data: preview });
      expect(saved.status).toBe(200);
      const reopened = await request(app).get(`${path}/${report._id}/preview`).set(userHeaders(String(owner._id)));
      expect(reopened.status).toBe(200);
      expect(reopened.body.data.preview_data.lots.map((lot: any) => lot.description)).toEqual(descriptions);
      expect(reopened.body.data.imageUrls).toEqual(imageUrls);
      const persisted = await (Model as any).findById(report._id).lean();
      expect(persisted.lots.map((lot: any) => lot.description)).toEqual(descriptions);
      expect(persisted.lots.map((lot: any) => lot.title)).toEqual(titles);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await (kind === "asset" ? generateAssetXlsxFromReport : generateLotListingXlsxFromReport)(persisted.preview_data));
      expect([workbook.getWorksheet("Sheet1")!.getCell("B2").value, workbook.getWorksheet("Sheet1")!.getCell("B3").value]).toEqual(titles);
      expect(persisted.status).toBe(status);
    }
  });

  it("persists exact per-lot numbers and multiline descriptions", async () => {
    const owner = await createOwner();
    const originalLots = [
      {
        lot_id: "duplicate-ai-id",
        lot_number: "1",
        title: "Livestock gates",
        description: "Generated first",
        image_indexes: [],
      },
      {
        lot_id: "duplicate-ai-id",
        lot_number: "2",
        title: "Livestock gates",
        description: "Generated second",
        image_indexes: [],
      },
    ];
    const report = await AssetReport.create({
      user: owner._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: originalLots,
      status: "preview",
      contract_no: "EDIT-PRESERVATION",
      preview_data: {
        contract_no: "EDIT-PRESERVATION",
        lots: originalLots,
      },
    });
    const editedLots = [
      {
        ...originalLots[0],
        lot_number: "825291",
        description:
          "First custom line\nSecond custom line with stock-photo context, Completeness: N/A, Legal: N/A",
      },
      {
        ...originalLots[1],
        lot_number: "825295",
        description:
          "Different first line\nDifferent second line for the other lot and more than sixty characters",
      },
    ];

    const response = await request(app)
      .put(`/api/asset/${report._id}/preview`)
      .set(userHeaders(String(owner._id)))
      .send({
        preview_data: {
          contract_no: "EDIT-PRESERVATION",
          lots: editedLots,
        },
      });

    expect(response.status).toBe(200);
    expect(
      response.body.data.lots.map((lot: any) => [lot.lot_number, lot.description])
    ).toEqual(editedLots.map((lot) => [lot.lot_number, lot.description]));

    const persisted = await AssetReport.findById(report._id).lean();
    expect(
      (persisted?.preview_data as any).lots.map((lot: any) => [
        lot.lot_number,
        lot.description,
      ])
    ).toEqual(editedLots.map((lot) => [lot.lot_number, lot.description]));
  });

  it("conflicts a changed resubmit while an older file snapshot is still generating", async () => {
    const owner = await createOwner();
    const lots = [
      {
        lot_id: "lot-1",
        lot_number: "825291",
        title: "Livestock gates",
        description: "Existing saved description",
        image_indexes: [],
      },
    ];
    const report = await AssetReport.create({
      user: owner._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots,
      status: "pending_approval",
      files_generating: true,
      contract_no: "ACTIVE-GENERATION",
      preview_data: { contract_no: "ACTIVE-GENERATION", lots },
    });

    const response = await request(app)
      .post(`/api/asset/${report._id}/resubmit`)
      .set(userHeaders(String(owner._id)))
      .send({
        preview_data: {
          contract_no: "ACTIVE-GENERATION",
          lots: [{ ...lots[0], lot_number: "825295" }],
        },
      });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("ASSET_PREVIEW_GENERATION_IN_PROGRESS");
    expect(response.body.message).toMatch(/already generating files/i);
    const persisted = await AssetReport.findById(report._id).lean();
    expect((persisted?.preview_data as any).lots[0].lot_number).toBe("825291");
  });

  it("returns the compacted Asset root image list with remapped 20-lot preview indexes", async () => {
    const owner = await createOwner();
    const fixture = createPhotoFixture();
    const report = await AssetReport.create({
      user: owner._id,
      grouping_mode: "single_lot",
      imageUrls: fixture.imageUrls,
      lots: fixture.lots,
      status: "preview",
      contract_no: "PHOTO-SYNC-20",
      preview_data: {
        contract_no: "PHOTO-SYNC-20",
        currency: "CAD",
        lots: fixture.lots,
      },
    });
    const editedPreview = previewAfterDeletingFirstPhotoFromLot1012(
      fixture.lots,
      fixture.imageUrls[22]
    );

    const response = await request(app)
      .put(`/api/asset/${report._id}/preview`)
      .set(userHeaders(String(owner._id)))
      .send({ preview_data: editedPreview });

    expect(response.status).toBe(200);
    expect(response.body.imageUrls).toEqual(fixture.imageUrls.filter((_, index) => index !== 22));
    expect(response.body.image_count).toBe(39);
    expectPhotoReferencesSynchronized(response.body.data, response.body.imageUrls);
  });

  it("does not persist stale inherited coordinates when an Asset preview location changes", async () => {
    const owner = await createOwner();
    const oldCoordinates = { latitude: 50.1, longitude: -104.2 };
    const inheritedLot = {
      lot_id: "asset-location-inherited",
      lot_number: "1",
      title: "Inherited location lot",
      description: "Inherited location lot",
      image_indexes: [],
      location: "Old Inspection Yard",
      ...oldCoordinates,
    };
    const independentLot = {
      lot_id: "asset-location-independent",
      lot_number: "2",
      title: "Independent location lot",
      description: "Independent location lot",
      image_indexes: [],
      location: "Independent Storage Site",
      latitude: 49.8,
      longitude: -97.1,
    };
    const report = await AssetReport.create({
      user: owner._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [inheritedLot, independentLot],
      status: "preview",
      contract_no: "ASSET-LOCATION-SYNC",
      preview_data: {
        contract_no: "ASSET-LOCATION-SYNC",
        location: "Old Inspection Yard",
        ...oldCoordinates,
        lots: [inheritedLot, independentLot],
      },
    });

    const response = await request(app)
      .put(`/api/asset/${report._id}/preview`)
      .set(userHeaders(String(owner._id)))
      .send({
        preview_data: {
          contract_no: "ASSET-LOCATION-SYNC",
          location: "New Inspection Yard",
          ...oldCoordinates,
          lots: [inheritedLot, independentLot],
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      location: "New Inspection Yard",
    });
    expect(response.body.data).not.toHaveProperty("latitude");
    expect(response.body.data).not.toHaveProperty("longitude");
    expect(response.body.data.lots[0]).toMatchObject({
      location: "New Inspection Yard",
    });
    expect(response.body.data.lots[0]).not.toHaveProperty("latitude");
    expect(response.body.data.lots[0]).not.toHaveProperty("longitude");
    expect(response.body.data.lots[1]).toMatchObject({
      location: "Independent Storage Site",
      latitude: 49.8,
      longitude: -97.1,
    });

    const persisted = await AssetReport.findById(report._id).lean();
    expect((persisted?.preview_data as any)?.location).toBe("New Inspection Yard");
    expect(persisted?.preview_data).not.toHaveProperty("latitude");
    expect(persisted?.preview_data).not.toHaveProperty("longitude");
  });

  it("returns a plain Lot Listing payload and the compacted root image list", async () => {
    const owner = await createOwner();
    const fixture = createPhotoFixture();
    const listing = await LotListing.create({
      user: owner._id,
      contract_no: "PHOTO-SYNC-20",
      sales_date: new Date("2026-08-10T00:00:00.000Z"),
      location: "Test Yard",
      latitude: 49.8951,
      longitude: -97.1384,
      imageUrls: fixture.imageUrls,
      lots: fixture.lots,
      status: "preview",
      preview_data: {
        contract_no: "PHOTO-SYNC-20",
        sales_date: "2026-08-10T00:00:00.000Z",
        location: "Test Yard",
        latitude: 49.8951,
        longitude: -97.1384,
        currency: "CAD",
        lots: fixture.lots,
      },
    });
    const editedPreview = {
      ...previewAfterDeletingFirstPhotoFromLot1012(fixture.lots, fixture.imageUrls[22]),
      sales_date: "2026-08-10T00:00:00.000Z",
      location: "Updated Test Yard",
      latitude: 49.9012,
      longitude: -97.1456,
    };

    const response = await request(app)
      .put(`/api/lot-listing/${listing._id}/preview`)
      .set(userHeaders(String(owner._id)))
      .send({ preview_data: editedPreview });

    expect(response.status).toBe(200);
    expect(response.body.data).not.toHaveProperty("_doc");
    expect(response.body.imageUrls).toEqual(fixture.imageUrls.filter((_, index) => index !== 22));
    expect(response.body.data.imageUrls).toEqual(response.body.imageUrls);
    expect(response.body.data.image_count).toBe(39);
    expectPhotoReferencesSynchronized(
      response.body.data.preview_data,
      response.body.data.imageUrls
    );
    const persisted = await LotListing.findById(listing._id).lean();
    expect(persisted).toMatchObject({
      location: "Updated Test Yard",
      latitude: 49.9012,
      longitude: -97.1456,
      preview_data: {
        location: "Updated Test Yard",
        latitude: 49.9012,
        longitude: -97.1456,
      },
    });
  });

  it("clears stale inherited coordinates when the readable Lot Listing location changes", async () => {
    const owner = await createOwner();
    const oldCoordinates = { latitude: 49.8951, longitude: -97.1384 };
    const lot = {
      lot_id: "location-lot-1",
      lot_number: "1",
      title: "Location test lot",
      description: "Location test lot",
      image_indexes: [],
      location: "Old Inspection Yard",
      ...oldCoordinates,
    };
    const listing = await LotListing.create({
      user: owner._id,
      contract_no: "LOCATION-SYNC-1",
      sales_date: new Date("2026-08-10T00:00:00.000Z"),
      location: "Old Inspection Yard",
      ...oldCoordinates,
      imageUrls: [],
      lots: [lot],
      status: "preview",
      preview_data: {
        contract_no: "LOCATION-SYNC-1",
        location: "Old Inspection Yard",
        ...oldCoordinates,
        lots: [lot],
      },
    });

    const response = await request(app)
      .put(`/api/lot-listing/${listing._id}/preview`)
      .set(userHeaders(String(owner._id)))
      .send({
        preview_data: {
          contract_no: "LOCATION-SYNC-1",
          location: "New Inspection Yard",
          ...oldCoordinates,
          lots: [{ ...lot, location: "Old Inspection Yard" }],
        },
      });

    expect(response.status).toBe(200);
    expect(response.body.data.preview_data.location).toBe("New Inspection Yard");
    expect(response.body.data.preview_data).not.toHaveProperty("latitude");
    expect(response.body.data.preview_data).not.toHaveProperty("longitude");
    expect(response.body.data.preview_data.lots[0]).toMatchObject({
      location: "New Inspection Yard",
    });
    expect(response.body.data.preview_data.lots[0]).not.toHaveProperty("latitude");
    expect(response.body.data.preview_data.lots[0]).not.toHaveProperty("longitude");

    const persisted = await LotListing.findById(listing._id).lean();
    expect(persisted?.location).toBe("New Inspection Yard");
    expect(persisted).not.toHaveProperty("latitude");
    expect(persisted).not.toHaveProperty("longitude");
  });
});
