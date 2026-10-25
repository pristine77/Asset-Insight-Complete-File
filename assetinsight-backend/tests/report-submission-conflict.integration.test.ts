import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { createHash } from "node:crypto";
import { access, rm } from "node:fs/promises";
import { MongoMemoryServer } from "mongodb-memory-server";
import request from "supertest";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import AssetReport from "../src/models/asset.model.js";
import LotListing from "../src/models/lotListing.model.js";
import ReportDraft from "../src/models/reportDraft.model.js";
import ReportJob from "../src/models/reportJob.model.js";
import ReportUploadSession from "../src/models/reportUploadSession.model.js";
import ReportSubmissionAdmission from "../src/models/reportSubmissionAdmission.model.js";
import User from "../src/models/user.model.js";
import { findActiveSameContractReport } from "../src/service/reportSubmissionConflictService.js";
import { cleanupAbandonedSmartUploadSessions } from "../src/utils/smartUploadSessionMaintenance.js";

const dependencyMocks = vi.hoisted(() => ({
  createPutUrl: vi.fn(),
  deleteFromR2Strict: vi.fn(),
  headR2Object: vi.fn(),
  uploadFilePathToR2: vi.fn(),
  queueAssetPreviewJob: vi.fn(),
  queuePreviewFilesJob: vi.fn(),
  queueLotListingJob: vi.fn(),
  regenerateLotListingFiles: vi.fn(),
}));

vi.mock("../src/utils/r2Storage/r2Upload.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/utils/r2Storage/r2Upload.js")
  >();
  return {
    ...actual,
    createR2PresignedPutUrl: dependencyMocks.createPutUrl,
    deleteFromR2Strict: dependencyMocks.deleteFromR2Strict,
    headR2Object: dependencyMocks.headR2Object,
    uploadFilePathToR2: dependencyMocks.uploadFilePathToR2,
  };
});

vi.mock("../src/jobs/assetReportJob.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/jobs/assetReportJob.js")>()),
  queueAssetPreviewJob: dependencyMocks.queueAssetPreviewJob,
  queuePreviewFilesJob: dependencyMocks.queuePreviewFilesJob,
}));

vi.mock("../src/jobs/lotListingJob.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/jobs/lotListingJob.js")>()),
  queueLotListingJob: dependencyMocks.queueLotListingJob,
  regenerateLotListingFiles: dependencyMocks.regenerateLotListingFiles,
}));

let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
const originalDeviceApprovalEnforcement =
  process.env.DEVICE_APPROVAL_ENFORCEMENT;
const originalR2BucketName = process.env.R2_BUCKET_NAME;
const originalR2PublicUrl = process.env.R2_PUBLIC_URL;
const originalLegacyR2BucketName = process.env.R2_LEGACY_BUCKET_NAME;
const originalLegacyR2PublicUrl = process.env.R2_LEGACY_PUBLIC_URL;

function restoreEnvironmentValue(
  name:
    | "DEVICE_APPROVAL_ENFORCEMENT"
    | "R2_BUCKET_NAME"
    | "R2_PUBLIC_URL"
    | "R2_LEGACY_BUCKET_NAME"
    | "R2_LEGACY_PUBLIC_URL",
  value: string | undefined,
) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const authHeader = (id: string) => ({
  Authorization: `Bearer ${jwt.sign(
    { id, role: "admin" },
    process.env.JWT_SECRET!,
    { expiresIn: "30m" },
  )}`,
});

async function createAdmin() {
  return User.create({
    email: `report-conflict-${new mongoose.Types.ObjectId()}@example.test`,
    username: `report-conflict-${new mongoose.Types.ObjectId()}`,
    password: "Password123!",
    authProvider: "email",
    isVerified: true,
    role: "admin",
  });
}

const uploadSessionReportCases = [
  {
    label: "Asset",
    type: "asset",
    path: "/api/asset/upload-session",
  },
  {
    label: "Lot Listing",
    type: "lotListing",
    path: "/api/lot-listing/upload-session",
  },
] as const;

const invalidUploadSessionCoordinates = [
  ["partial latitude", { latitude: "50.44521" }],
  ["partial longitude", { longitude: "-104.618896" }],
  ["out-of-range pair", { latitude: "91", longitude: "-104.618896" }],
  ["boolean pair", { latitude: true, longitude: false }],
  ["array pair", { latitude: [50.44521], longitude: [-104.618896] }],
  ["object pair", { latitude: { value: 50.44521 }, longitude: { value: -104.618896 } }],
  ["nonnumeric pair", { latitude: "north", longitude: "west" }],
] as const;

function uploadSessionRequestBody({
  type,
  clientSubmissionId,
  location = "10 Downing Street, London",
  coordinates,
}: {
  type: (typeof uploadSessionReportCases)[number]["type"];
  clientSubmissionId: string;
  location?: string;
  coordinates: Record<string, unknown>;
}) {
  return {
    details: {
      client_submission_id: clientSubmissionId,
      progress_id: clientSubmissionId,
      contract_no: `UPLOAD-COORDINATES-${clientSubmissionId}`,
      location,
      ...(type === "asset"
        ? {
            grouping_mode: "mixed",
            mixed_lots: [
              { count: 1, extra_count: 0, mode: "single_lot" },
            ],
          }
        : {
            sales_date: "2026-09-01T00:00:00.000Z",
          }),
      ...coordinates,
    },
    files: [
      {
        fileId: "images-0",
        name: "inspection.jpg",
        type: "image/jpeg",
        size: 2_048,
        lastModified: 500,
        fieldname: "images",
        imageIndex: 0,
        originalOrder: 0,
        role: "main",
      },
    ],
  };
}

beforeAll(async () => {
  process.env.DEVICE_APPROVAL_ENFORCEMENT = "off";
  process.env.R2_BUCKET_NAME = "report-conflict-test";
  process.env.R2_PUBLIC_URL = "https://assetinsight.test";
  process.env.R2_LEGACY_BUCKET_NAME = "legacy-report-conflict-test";
  process.env.R2_LEGACY_PUBLIC_URL = "https://images.sellsnap.test";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  dependencyMocks.createPutUrl.mockReset();
  dependencyMocks.deleteFromR2Strict.mockReset();
  dependencyMocks.headR2Object.mockReset();
  dependencyMocks.uploadFilePathToR2.mockReset();
  dependencyMocks.queueAssetPreviewJob.mockReset();
  dependencyMocks.queuePreviewFilesJob.mockReset();
  dependencyMocks.queueLotListingJob.mockReset();
  dependencyMocks.regenerateLotListingFiles.mockReset();
  dependencyMocks.createPutUrl.mockResolvedValue(
    "https://r2-upload.example/signed-put",
  );
  dependencyMocks.deleteFromR2Strict.mockResolvedValue(undefined);
  dependencyMocks.headR2Object.mockResolvedValue({ size: 2_048 });
  dependencyMocks.uploadFilePathToR2.mockResolvedValue(
    "https://assetinsight.test/uploaded.jpg",
  );
  dependencyMocks.queueAssetPreviewJob.mockResolvedValue(undefined);
  dependencyMocks.queueLotListingJob.mockResolvedValue(undefined);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  restoreEnvironmentValue(
    "DEVICE_APPROVAL_ENFORCEMENT",
    originalDeviceApprovalEnforcement,
  );
  restoreEnvironmentValue("R2_BUCKET_NAME", originalR2BucketName);
  restoreEnvironmentValue("R2_PUBLIC_URL", originalR2PublicUrl);
  restoreEnvironmentValue(
    "R2_LEGACY_BUCKET_NAME",
    originalLegacyR2BucketName,
  );
  restoreEnvironmentValue("R2_LEGACY_PUBLIC_URL", originalLegacyR2PublicUrl);
});

describe("active report submission conflicts", () => {
  it.each(uploadSessionReportCases)("retains optional $label capture provenance through upload completion and retries", async ({ type, path }) => {
    const user = await createAdmin();
    const clientSubmissionId = `${type}-capture-link`;
    const captureId = "a7a45591-2a9a-4a60-9e50-7844ab603ada";
    const body = uploadSessionRequestBody({ type, clientSubmissionId, coordinates: { capture_id: captureId } });
    const created = await request(app).post(path).set(authHeader(String(user._id))).send(body);
    expect(created.status).toBe(201);
    const session: any = await ReportUploadSession.findOne({ clientSubmissionId });
    expect(session.capture_id).toBe(captureId);
    session.files[0].uploadedAt = new Date();
    session.files[0].verifiedSize = 2048;
    await session.save();
    const completed = await request(app).post(`${path}/${session._id}/complete`).set(authHeader(String(user._id)));
    expect(completed.status).toBe(202);
    const model = type === "asset" ? AssetReport : LotListing;
    const report: any = await model.findOne({ user: user._id, client_submission_id: clientSubmissionId }).lean();
    expect(report.capture_id).toBe(captureId);
    expect((await request(app).post(`${path}/${session._id}/complete`).set(authHeader(String(user._id)))).status).toBe(200);
    expect(await model.countDocuments({ user: user._id })).toBe(1);
    expect(await mongoose.connection.collection("captureinventories").countDocuments()).toBe(0);
  });

  it.each(uploadSessionReportCases)("retains optional $label capture provenance in multipart acceptance", async ({ type, path }) => {
    const user = await createAdmin();
    const captureId = "a7a45591-2a9a-4a60-9e50-7844ab603ada";
    const body = uploadSessionRequestBody({ type, clientSubmissionId: `${type}-capture-multipart`, coordinates: { capture_id: captureId } });
    const response = await request(app).post(path.replace("/upload-session", "")).set(authHeader(String(user._id)))
      .field("details", JSON.stringify({ ...body.details, grouping_mode: "single_lot", mixed_lots: [] }));
    expect(response.status).toBe(202);
    const model = type === "asset" ? AssetReport : LotListing;
    expect((await model.findOne({ user: user._id }).lean() as any).capture_id).toBe(captureId);
  });

  it.each(uploadSessionReportCases.flatMap((reportCase) =>
    [undefined, false, true, "false", "true"].map((choice) => ({ ...reportCase, choice }))
  ))("keeps $label upload-session watermark default/choice ($choice) through completion", async ({ type, path, choice }) => {
    const user = await createAdmin();
    const clientSubmissionId = `${type}-watermark-${String(choice)}`;
    const body = uploadSessionRequestBody({
      type, clientSubmissionId, coordinates: { watermark_images: choice },
    });
    const created = await request(app).post(path).set(authHeader(String(user._id))).send(body);
    expect(created.status).toBe(201);
    const session: any = await ReportUploadSession.findOne({ clientSubmissionId });
    // Isolated verified-object fixture: actual storage is mocked in this suite.
    session.files[0].uploadedAt = new Date();
    session.files[0].verifiedSize = 2048;
    await session.save();
    const completed = await request(app).post(`${path}/${session._id}/complete`).set(authHeader(String(user._id)));
    expect(completed.status).toBe(202);
    const queue = type === "asset" ? dependencyMocks.queueAssetPreviewJob : dependencyMocks.queueLotListingJob;
    expect(queue).toHaveBeenCalledTimes(1);
    const queued = queue.mock.calls[0][0];
    const Model = type === "asset" ? AssetReport : LotListing;
    const report: any = await Model.findById(queued.reportId || queued.listingId).lean();
    expect(report.watermark_images).toBe(choice === true || choice === "true");
    // A retry retains exactly the same report and accepted preference.
    expect((await request(app).post(`${path}/${session._id}/complete`).set(authHeader(String(user._id)))).status).toBe(200);
    expect(await Model.countDocuments({ user: user._id })).toBe(1);
  });

  it.each(uploadSessionReportCases.flatMap((reportCase) =>
    [undefined, false, true, "false", "true"].map((choice) => ({ ...reportCase, choice }))
  ))("keeps $label multipart watermark default/choice ($choice)", async ({ type, path, choice }) => {
    const user = await createAdmin();
    const body = uploadSessionRequestBody({
      type, clientSubmissionId: `${type}-multipart-watermark-${String(choice)}`,
      coordinates: { watermark_images: choice },
    });
    const response = await request(app).post(path.replace("/upload-session", ""))
      .set(authHeader(String(user._id))).field("details", JSON.stringify({
        ...body.details, grouping_mode: "single_lot", mixed_lots: [],
      }));
    expect(response.status).toBe(202);
    const Model = type === "asset" ? AssetReport : LotListing;
    const report: any = await Model.findOne({ user: user._id }).lean();
    expect(report.watermark_images).toBe(choice === true || choice === "true");
  });

  it("forwards browser coordinates through the initial multipart Lot Listing queue", async () => {
    const user = await createAdmin();
    const location = "700 Exact Inspection Road, Winnipeg, MB R3H 0A1";
    const latitude = 49.907321;
    const longitude = -97.219876;

    const response = await request(app)
      .post("/api/lot-listing")
      .set(authHeader(String(user._id)))
      .field(
        "details",
        JSON.stringify({
          client_submission_id: "lot-listing-coordinate-forwarding",
          progress_id: "lot-listing-coordinate-forwarding",
          contract_no: "LOT-COORDINATES-100",
          sales_date: "2026-09-01T00:00:00.000Z",
          location,
          latitude: String(latitude),
          longitude: String(longitude),
        })
      );

    expect(response.status).toBe(202);
    expect(dependencyMocks.queueLotListingJob).toHaveBeenCalledTimes(1);
    expect(
      dependencyMocks.queueLotListingJob.mock.calls[0]?.[0]?.details
    ).toMatchObject({ location, latitude, longitude });
    const queuedListingId =
      dependencyMocks.queueLotListingJob.mock.calls[0]?.[0]?.listingId;
    const persisted = await LotListing.findById(queuedListingId).lean();
    expect(persisted).toMatchObject({ location, latitude, longitude });
  });

  it("normalizes valid numeric-string coordinates for an initial Asset submission", async () => {
    const user = await createAdmin();
    const response = await request(app)
      .post("/api/asset")
      .set(authHeader(String(user._id)))
      .field(
        "details",
        JSON.stringify({
          client_submission_id: "asset-coordinate-normalization",
          progress_id: "asset-coordinate-normalization",
          contract_no: "ASSET-COORDINATES-100",
          grouping_mode: "single_lot",
          location: "10 Downing Street, London",
          latitude: "51.503407",
          longitude: "-0.127592",
        })
      );

    expect(response.status).toBe(202);
    expect(dependencyMocks.queueAssetPreviewJob).toHaveBeenCalledTimes(1);
    expect(
      dependencyMocks.queueAssetPreviewJob.mock.calls[0]?.[0]?.details
    ).toMatchObject({ latitude: 51.503407, longitude: -0.127592 });
  });

  it("reopens a direct Asset upload after enqueue failure and queues one retry", async () => {
    const user = await createAdmin();
    const details = {
      client_submission_id: "asset-direct-queue-retry",
      progress_id: "asset-direct-queue-retry",
      contract_no: "ASSET-DIRECT-QUEUE-RETRY",
      grouping_mode: "single_lot",
    };
    dependencyMocks.queueAssetPreviewJob.mockRejectedValueOnce(
      new Error("asset preview queue unavailable")
    );

    const failed = await request(app)
      .post("/api/asset")
      .set(authHeader(String(user._id)))
      .field("details", JSON.stringify(details))
      .attach("images", Buffer.from("first-attempt"), {
        filename: "asset.jpg",
        contentType: "image/jpeg",
      });

    expect(failed.status).toBe(500);
    expect(await AssetReport.findOne({
      client_submission_id: details.client_submission_id,
    }).lean()).toMatchObject({
      status: "error",
      job_id: details.progress_id,
      job_status: "error",
      files_generating: false,
      files_regenerating: false,
    });

    dependencyMocks.queueAssetPreviewJob.mockResolvedValueOnce(undefined);
    const retried = await request(app)
      .post("/api/asset")
      .set(authHeader(String(user._id)))
      .field("details", JSON.stringify(details))
      .attach("images", Buffer.from("second-attempt"), {
        filename: "asset.jpg",
        contentType: "image/jpeg",
      });

    expect(retried.status).toBe(202);
    const retryJobId = String(retried.body.jobId || "");
    expect(retryJobId).toMatch(/^asset-preview-retry-/);
    expect(retryJobId).not.toBe(details.progress_id);
    expect(retried.body).toMatchObject({
      resumed: true,
      status: "processing",
    });
    expect(dependencyMocks.queueAssetPreviewJob).toHaveBeenCalledTimes(2);
    expect(dependencyMocks.queueAssetPreviewJob.mock.calls[1]?.[0]).toMatchObject({
      progressId: retryJobId,
      submissionAttemptId: retryJobId,
    });
    expect(await AssetReport.findOne({
      client_submission_id: details.client_submission_id,
    }).lean()).toMatchObject({
      status: "processing",
      job_id: retryJobId,
      job_status: "queued",
    });
  });

  it("repairs a queued direct Asset placeholder with the exact retry job", async () => {
    const user = await createAdmin();
    const clientSubmissionId = "asset-direct-missing-job-recovery";
    const report = await AssetReport.create({
      user: user._id,
      client_submission_id: clientSubmissionId,
      contract_no: "ASSET-DIRECT-MISSING-JOB",
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "processing",
      job_id: clientSubmissionId,
      job_status: "queued",
    });

    const retried = await request(app)
      .post("/api/asset")
      .set(authHeader(String(user._id)))
      .field(
        "details",
        JSON.stringify({
          client_submission_id: clientSubmissionId,
          progress_id: clientSubmissionId,
          contract_no: "ASSET-DIRECT-MISSING-JOB",
          grouping_mode: "single_lot",
        })
      )
      .attach("images", Buffer.from("safe retry source"), {
        filename: "asset.jpg",
        contentType: "image/jpeg",
      });

    expect(retried.status).toBe(202);
    expect(retried.body).toMatchObject({
      reportId: String(report._id),
      jobId: clientSubmissionId,
      resumed: true,
    });
    expect(dependencyMocks.queueAssetPreviewJob).toHaveBeenCalledTimes(1);
    expect(dependencyMocks.queueAssetPreviewJob).toHaveBeenCalledWith(
      expect.objectContaining({
        reportId: String(report._id),
        progressId: clientSubmissionId,
        details: expect.objectContaining({
          client_submission_id: clientSubmissionId,
        }),
      })
    );
  });

  it("retains queued state and source files when queue acceptance lookup is unavailable", async () => {
    const user = await createAdmin();
    const clientSubmissionId = "asset-direct-ambiguous-queue";
    dependencyMocks.queueAssetPreviewJob.mockRejectedValueOnce(
      new Error("queue acknowledgement lost")
    );
    const reportJobLookup = vi
      .spyOn(ReportJob, "findOne")
      .mockImplementationOnce(() => {
        throw new Error("job database unavailable");
      });

    let sourcePath = "";
    try {
      const response = await request(app)
        .post("/api/asset")
        .set(authHeader(String(user._id)))
        .field(
          "details",
          JSON.stringify({
            client_submission_id: clientSubmissionId,
            progress_id: clientSubmissionId,
            contract_no: "ASSET-DIRECT-AMBIGUOUS-QUEUE",
            grouping_mode: "single_lot",
          })
        )
        .attach("images", Buffer.from("possibly accepted source"), {
          filename: "asset.jpg",
          contentType: "image/jpeg",
        });

      sourcePath = String(
        dependencyMocks.queueAssetPreviewJob.mock.calls[0]?.[0]?.images?.[0]
          ?.path || ""
      );
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({
        code: "ASSET_PREVIEW_QUEUE_STATE_UNKNOWN",
        retryable: true,
        resumed: true,
      });
      expect(await AssetReport.findOne({
        client_submission_id: clientSubmissionId,
      }).lean()).toMatchObject({
        status: "processing",
        job_id: clientSubmissionId,
        job_status: "queued",
      });
      expect(sourcePath).toBeTruthy();
      await expect(access(sourcePath)).resolves.toBeUndefined();
    } finally {
      reportJobLookup.mockRestore();
      if (sourcePath) await rm(sourcePath, { force: true });
    }
  });

  it.each([
    ["partial latitude", { latitude: 50.1 }],
    ["partial longitude", { longitude: -104.2 }],
    ["latitude above range", { latitude: 91, longitude: 0 }],
    ["latitude below range", { latitude: -91, longitude: 0 }],
    ["longitude above range", { latitude: 0, longitude: 181 }],
    ["longitude below range", { latitude: 0, longitude: -181 }],
  ])("rejects %s in initial Asset and Lot Listing submissions", async (_label, coordinates) => {
    const user = await createAdmin();
    const baseDetails = {
      location: "Readable Inspection Yard",
      sales_date: "2026-09-01T00:00:00.000Z",
      ...coordinates,
    };

    const assetResponse = await request(app)
      .post("/api/asset")
      .set(authHeader(String(user._id)))
      .field(
        "details",
        JSON.stringify({
          ...baseDetails,
          client_submission_id: `invalid-asset-${_label}`,
          progress_id: `invalid-asset-${_label}`,
          contract_no: `INVALID-ASSET-${_label}`,
          grouping_mode: "single_lot",
        })
      );
    const lotResponse = await request(app)
      .post("/api/lot-listing")
      .set(authHeader(String(user._id)))
      .field(
        "details",
        JSON.stringify({
          ...baseDetails,
          client_submission_id: `invalid-lot-${_label}`,
          progress_id: `invalid-lot-${_label}`,
          contract_no: `INVALID-LOT-${_label}`,
        })
      );

    expect(assetResponse.status).toBe(400);
    expect(lotResponse.status).toBe(400);
    expect(assetResponse.body.message).toMatch(/supplied together.*valid ranges/i);
    expect(lotResponse.body.message).toMatch(/supplied together.*valid ranges/i);
  });

  it.each(uploadSessionReportCases)(
    "normalizes valid numeric-string coordinates for $label upload-session creation and resume",
    async ({ type, path }) => {
      const user = await createAdmin();
      const clientSubmissionId = `${type}-valid-session-coordinates`;
      const created = await request(app)
        .post(path)
        .set(authHeader(String(user._id)))
        .send(
          uploadSessionRequestBody({
            type,
            clientSubmissionId,
            coordinates: {
              latitude: "51.503407",
              longitude: "-0.127592",
            },
          }),
        );

      expect(created.status).toBe(201);
      let persisted = await ReportUploadSession.findOne({
        user: user._id,
        type,
        clientSubmissionId,
      }).lean();
      expect(persisted?.details).toMatchObject({
        latitude: 51.503407,
        longitude: -0.127592,
      });
      expect(persisted).toMatchObject({
        r2Bucket: "report-conflict-test",
        r2PublicBaseUrl: "https://assetinsight.test",
      });
      expect(created.body.data.files[0]).toMatchObject({
        publicUrl: expect.stringMatching(
          /^https:\/\/assetinsight\.test\/uploads\/report-sessions\//,
        ),
      });
      expect(dependencyMocks.createPutUrl).toHaveBeenCalledWith(
        "report-conflict-test",
        expect.stringMatching(/^uploads\/report-sessions\//),
        "image/jpeg",
        expect.any(Number),
        { preventOverwrite: true },
      );

      const resumed = await request(app)
        .post(path)
        .set(authHeader(String(user._id)))
        .send(
          uploadSessionRequestBody({
            type,
            clientSubmissionId,
            location: "2500 Wascana Parkway, Regina, SK",
            coordinates: {
              latitude: "50.415288",
              longitude: "-104.590929",
            },
          }),
        );

      expect(resumed.status).toBe(200);
      expect(resumed.body.data).toMatchObject({ resumed: true });
      persisted = await ReportUploadSession.findOne({
        user: user._id,
        type,
        clientSubmissionId,
      }).lean();
      expect(persisted?.details).toMatchObject({
        location: "2500 Wascana Parkway, Regina, SK",
        latitude: 50.415288,
        longitude: -104.590929,
      });
      expect(
        await ReportUploadSession.countDocuments({
          user: user._id,
          type,
          clientSubmissionId,
        }),
      ).toBe(1);
      expect(dependencyMocks.queueAssetPreviewJob).not.toHaveBeenCalled();
      expect(dependencyMocks.queueLotListingJob).not.toHaveBeenCalled();
    },
  );

  it.each(
    uploadSessionReportCases.flatMap((reportCase) =>
      invalidUploadSessionCoordinates.map(([coordinateCase, coordinates]) => ({
        ...reportCase,
        coordinateCase,
        coordinates,
      })),
    ),
  )(
    "rejects $coordinateCase before creating a $label upload session",
    async ({ type, path, coordinateCase, coordinates }) => {
      const user = await createAdmin();
      const clientSubmissionId = `${type}-invalid-create-${coordinateCase.replaceAll(" ", "-")}`;
      const response = await request(app)
        .post(path)
        .set(authHeader(String(user._id)))
        .send(
          uploadSessionRequestBody({
            type,
            clientSubmissionId,
            coordinates,
          }),
        );

      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/supplied together.*valid ranges/i);
      expect(await ReportUploadSession.countDocuments()).toBe(0);
      expect(await AssetReport.countDocuments()).toBe(0);
      expect(await LotListing.countDocuments()).toBe(0);
      expect(dependencyMocks.createPutUrl).not.toHaveBeenCalled();
      expect(dependencyMocks.queueAssetPreviewJob).not.toHaveBeenCalled();
      expect(dependencyMocks.queueLotListingJob).not.toHaveBeenCalled();
    },
  );

  it.each(
    uploadSessionReportCases.flatMap((reportCase) =>
      invalidUploadSessionCoordinates.map(([coordinateCase, coordinates]) => ({
        ...reportCase,
        coordinateCase,
        coordinates,
      })),
    ),
  )(
    "rejects $coordinateCase without rewriting a resumed $label upload session",
    async ({ type, path, coordinateCase, coordinates }) => {
      const user = await createAdmin();
      const clientSubmissionId = `${type}-invalid-resume-${coordinateCase.replaceAll(" ", "-")}`;
      const created = await request(app)
        .post(path)
        .set(authHeader(String(user._id)))
        .send(
          uploadSessionRequestBody({
            type,
            clientSubmissionId,
            coordinates: {
              latitude: "51.503407",
              longitude: "-0.127592",
            },
          }),
        );
      expect(created.status).toBe(201);

      dependencyMocks.createPutUrl.mockClear();
      const response = await request(app)
        .post(path)
        .set(authHeader(String(user._id)))
        .send(
          uploadSessionRequestBody({
            type,
            clientSubmissionId,
            location: "Location that must not replace the accepted details",
            coordinates,
          }),
        );

      expect(response.status).toBe(400);
      expect(response.body.message).toMatch(/supplied together.*valid ranges/i);
      expect(
        await ReportUploadSession.countDocuments({
          user: user._id,
          type,
          clientSubmissionId,
        }),
      ).toBe(1);
      const persisted = await ReportUploadSession.findOne({
        user: user._id,
        type,
        clientSubmissionId,
      }).lean();
      expect(persisted?.details).toMatchObject({
        location: "10 Downing Street, London",
        latitude: 51.503407,
        longitude: -0.127592,
      });
      expect(dependencyMocks.createPutUrl).not.toHaveBeenCalled();
      expect(dependencyMocks.queueAssetPreviewJob).not.toHaveBeenCalled();
      expect(dependencyMocks.queueLotListingJob).not.toHaveBeenCalled();
    },
  );

  it.each(uploadSessionReportCases)(
    "allows concurrent separate $label uploads for one contract",
    async ({ type, path }) => {
      await ReportUploadSession.createIndexes();
      const user = await createAdmin();
      const firstBody = uploadSessionRequestBody({
        type,
        clientSubmissionId: `${type}-contract-race-a`,
        coordinates: {},
      });
      const secondBody = uploadSessionRequestBody({
        type,
        clientSubmissionId: `${type}-contract-race-b`,
        coordinates: {},
      });
      firstBody.details.contract_no = "  Concurrent   Contract 100  ";
      secondBody.details.contract_no = "concurrent contract 100";

      const responses = await Promise.all([
        request(app)
          .post(path)
          .set(authHeader(String(user._id)))
          .send(firstBody),
        request(app)
          .post(path)
          .set(authHeader(String(user._id)))
          .send(secondBody),
      ]);

      expect(responses.map(({ status }) => status).sort()).toEqual([201, 201]);
      const sessions = await ReportUploadSession.find({
        type,
        user: user._id,
      })
        .select("+activeContractClaim")
        .lean();
      expect(sessions).toHaveLength(2);
      expect(sessions.every((session) => !session.activeContractClaim)).toBe(true);
    },
  );

  it.each(uploadSessionReportCases)(
    "does not let a legacy claimless $label upload block a separate report",
    async ({ type, path }) => {
      await ReportUploadSession.createIndexes();
      const user = await createAdmin();
      const legacyClientSubmissionId = `${type}-legacy-claimless-upload`;
      const legacy = await ReportUploadSession.create({
        type,
        status: "uploading",
        user: user._id,
        jobId: legacyClientSubmissionId,
        clientSubmissionId: legacyClientSubmissionId,
        details: { contract_no: "  Legacy   Rolling Deploy 100  " },
        files: [],
        expectedFileCount: 0,
        expectedImageCount: 0,
        expectedVideoCount: 0,
        totalBytes: 0,
      });
      const body = uploadSessionRequestBody({
        type,
        clientSubmissionId: `${type}-new-after-rolling-deploy`,
        coordinates: {},
      });
      body.details.contract_no = "legacy rolling deploy 100";

      const response = await request(app)
        .post(path)
        .set(authHeader(String(user._id)))
        .send(body);

      expect(response.status).toBe(201);
      expect(
        await ReportUploadSession.countDocuments({ type, user: user._id }),
      ).toBe(2);
      const claimed = await ReportUploadSession.findById(legacy._id)
        .select("+activeContractClaim")
        .lean();
      expect(claimed?.activeContractClaim).toBeUndefined();
    },
  );

  it.each(uploadSessionReportCases)(
    "converges concurrent same-client $label retries without a contract claim",
    async ({ type, path }) => {
      await ReportUploadSession.createIndexes();
      const user = await createAdmin();
      const body = uploadSessionRequestBody({
        type,
        clientSubmissionId: `${type}-same-client-race`,
        coordinates: {},
      });
      body.details.contract_no = "SAME-CLIENT-CLAIM-100";

      const responses = await Promise.all([
        request(app)
          .post(path)
          .set(authHeader(String(user._id)))
          .send(body),
        request(app)
          .post(path)
          .set(authHeader(String(user._id)))
          .send(body),
      ]);

      expect(responses.map(({ status }) => status).sort()).toEqual([200, 201]);
      expect(
        await ReportUploadSession.countDocuments({ type, user: user._id }),
      ).toBe(1);
      const session = await ReportUploadSession.findOne({
        type,
        user: user._id,
      })
        .select("+activeContractClaim")
        .lean();
      expect(session?.activeContractClaim).toBeUndefined();
    },
  );

  it.each(uploadSessionReportCases)(
    "allows explicit force-new $label uploads to share a contract without a claim",
    async ({ type, path }) => {
      await ReportUploadSession.createIndexes();
      const user = await createAdmin();
      const makeBody = (clientSubmissionId: string) => {
        const body = uploadSessionRequestBody({
          type,
          clientSubmissionId,
          coordinates: {},
        });
        body.details.contract_no = "FORCE-NEW-CLAIM-100";
        (body.details as any).force_new = true;
        return body;
      };

      const responses = await Promise.all([
        request(app)
          .post(path)
          .set(authHeader(String(user._id)))
          .send(makeBody(`${type}-force-new-a`)),
        request(app)
          .post(path)
          .set(authHeader(String(user._id)))
          .send(makeBody(`${type}-force-new-b`)),
      ]);

      expect(responses.map(({ status }) => status).sort()).toEqual([201, 201]);
      const sessions = await ReportUploadSession.find({ type, user: user._id })
        .select("+activeContractClaim")
        .lean();
      expect(sessions).toHaveLength(2);
      expect(sessions.every((session) => !session.activeContractClaim)).toBe(
        true,
      );
    },
  );

  it("supersedes by submission id without transferring a legacy contract claim", async () => {
    await ReportUploadSession.createIndexes();
    const user = await createAdmin();
    const failedId = "failed-contract-claim";
    await ReportUploadSession.create({
      type: "asset",
      status: "failed",
      user: user._id,
      jobId: failedId,
      clientSubmissionId: failedId,
      activeContractClaim: "reclaim-contract-100",
      details: { contract_no: "RECLAIM-CONTRACT-100" },
      files: [],
      expectedFileCount: 0,
      expectedImageCount: 0,
      expectedVideoCount: 0,
      totalBytes: 0,
    });

    const replacementBody = uploadSessionRequestBody({
      type: "asset",
      clientSubmissionId: "replacement-contract-claim",
      coordinates: {},
    });
    replacementBody.details.contract_no = "RECLAIM-CONTRACT-100";
    const replacement = await request(app)
      .post("/api/asset/upload-session")
      .set(authHeader(String(user._id)))
      .send(replacementBody);
    expect(replacement.status).toBe(201);

    const failed = await ReportUploadSession.findOne({
      clientSubmissionId: failedId,
    })
      .select("+activeContractClaim")
      .lean();
    const active = await ReportUploadSession.findOne({
      clientSubmissionId: "replacement-contract-claim",
    })
      .select("+activeContractClaim")
      .lean();
    expect(failed?.activeContractClaim).toBe("reclaim-contract-100");
    expect(active?.activeContractClaim).toBeUndefined();

    const supersedingBody = uploadSessionRequestBody({
      type: "asset",
      clientSubmissionId: "superseding-contract-claim",
      coordinates: {},
    });
    supersedingBody.details.contract_no = "RECLAIM-CONTRACT-100";
    (supersedingBody.details as any).supersedes_client_submission_id =
      "replacement-contract-claim";
    const superseding = await request(app)
      .post("/api/asset/upload-session")
      .set(authHeader(String(user._id)))
      .send(supersedingBody);
    expect(superseding.status).toBe(201);

    const superseded = await ReportUploadSession.findOne({
      clientSubmissionId: "replacement-contract-claim",
    })
      .select("+activeContractClaim")
      .lean();
    const finalSession = await ReportUploadSession.findOne({
      clientSubmissionId: "superseding-contract-claim",
    })
      .select("+activeContractClaim")
      .lean();
    expect(superseded?.cleanupStartedAt).toBeInstanceOf(Date);
    expect(superseded?.activeContractClaim).toBeUndefined();
    expect(finalSession?.activeContractClaim).toBeUndefined();
  });

  it("atomically supersedes only an incomplete upload session", async () => {
    const user = await createAdmin();
    const requestBody = (
      clientSubmissionId: string,
      supersedesClientSubmissionId?: string,
    ) => ({
      details: {
        contract_no: "SUPERSEDE-100",
        grouping_mode: "mixed",
        mixed_lots: [
          { count: 1, extra_count: 0, mode: "single_lot" },
        ],
        client_submission_id: clientSubmissionId,
        progress_id: clientSubmissionId,
        ...(supersedesClientSubmissionId
          ? {
              supersedes_client_submission_id:
                supersedesClientSubmissionId,
            }
          : {}),
      },
      files: [
        {
          fileId: "images-0",
          name: "replacement.jpg",
          type: "image/jpeg",
          size: 2_048,
          lastModified: 500,
          fieldname: "images",
          imageIndex: 0,
          originalOrder: 0,
          role: "main",
        },
      ],
    });

    const oldId = "superseded-upload";
    const oldCreated = await request(app)
      .post("/api/asset/upload-session")
      .set(authHeader(String(user._id)))
      .send(requestBody(oldId));
    expect(oldCreated.status).toBe(201);

    const replacementId = "replacement-upload";
    const replacement = await request(app)
      .post("/api/asset/upload-session")
      .set(authHeader(String(user._id)))
      .send(requestBody(replacementId, oldId));
    expect(replacement.status, JSON.stringify(replacement.body)).toBe(201);
    expect(dependencyMocks.deleteFromR2Strict).not.toHaveBeenCalled();
    const supersededSession = await ReportUploadSession.findOne({
      user: user._id,
      clientSubmissionId: oldId,
    }).lean();
    expect(supersededSession).toMatchObject({
      supersededByClientSubmissionId: replacementId,
    });
    expect(supersededSession?.cleanupStartedAt).toBeInstanceOf(Date);
    expect(supersededSession?.cleanupNotBefore).toBeInstanceOf(Date);
    expect(
      supersededSession!.cleanupNotBefore!.getTime(),
    ).toBeGreaterThan(supersededSession!.cleanupStartedAt!.getTime());
    const replacementSession = await ReportUploadSession.findOne({
      user: user._id,
      clientSubmissionId: replacementId,
    }).lean();
    expect(replacementSession).toMatchObject({
      supersedesClientSubmissionIds: [oldId],
    });

    const replacementRetry = await request(app)
      .post("/api/asset/upload-session")
      .set(authHeader(String(user._id)))
      .send(requestBody(replacementId, oldId));
    expect(replacementRetry.status).toBe(200);
    expect(replacementRetry.body.data).toMatchObject({ resumed: true });

    const restoredOldIdRetry = await request(app)
      .post("/api/asset/upload-session")
      .set(authHeader(String(user._id)))
      .send(requestBody(oldId));
    expect(restoredOldIdRetry.status).toBe(200);
    expect(restoredOldIdRetry.body.data).toMatchObject({
      resumed: true,
      jobId: replacementId,
    });

    const secondReplacementId = "second-replacement-upload";
    const secondReplacement = await request(app)
      .post("/api/asset/upload-session")
      .set(authHeader(String(user._id)))
      .send(requestBody(secondReplacementId, replacementId));
    expect(secondReplacement.status).toBe(201);
    const secondReplacementSession = await ReportUploadSession.findOne({
      user: user._id,
      clientSubmissionId: secondReplacementId,
    }).lean();
    expect(secondReplacementSession).toMatchObject({
      supersedesClientSubmissionIds: [oldId, replacementId],
    });

    const oldestIdRetry = await request(app)
      .post("/api/asset/upload-session")
      .set(authHeader(String(user._id)))
      .send(requestBody(oldId));
    expect(oldestIdRetry.status).toBe(200);
    expect(oldestIdRetry.body.data).toMatchObject({
      resumed: true,
      jobId: secondReplacementId,
    });

    await ReportDraft.create([
      {
        user: user._id,
        type: "asset",
        clientDraftId: oldId,
        title: "Original saved draft",
      },
      {
        user: user._id,
        type: "asset",
        clientDraftId: replacementId,
        title: "Replacement saved draft",
      },
      {
        user: user._id,
        type: "asset",
        clientDraftId: secondReplacementId,
        title: "Second replacement saved draft",
      },
    ]);
    const secondReplacementReport = await AssetReport.create({
      user: user._id, client_submission_id: secondReplacementId, contract_no: "SUPERSEDE-100",
      grouping_mode: "mixed", imageUrls: [], lots: [], status: "processing",
      job_id: secondReplacementId, job_status: "queued",
    });
    await ReportUploadSession.updateOne(
      { user: user._id, clientSubmissionId: secondReplacementId },
      { $set: { status: "queued", reportId: String(secondReplacementReport._id), uploadCompletedAt: new Date() } },
    );
    const lostResponseRetry = await request(app)
      .post("/api/asset/upload-session")
      .set(authHeader(String(user._id)))
      .send(requestBody(oldId));
    expect(lostResponseRetry.status).toBe(200);
    expect(lostResponseRetry.body.data).toMatchObject({
      resumed: true,
      alreadyQueued: true,
      jobId: secondReplacementId,
    });
    await vi.waitFor(async () => {
      expect(
        await ReportDraft.countDocuments({
          user: user._id,
          clientDraftId: {
            $in: [oldId, replacementId, secondReplacementId],
          },
        }),
      ).toBe(0);
    });

    // The accepted queued session correctly owns this contract. Finish that
    // independent scenario before exercising recovery of a completed session
    // which failed before it acquired a report id.
    await ReportUploadSession.updateOne(
      { user: user._id, clientSubmissionId: secondReplacementId },
      {
        $set: { status: "processed" },
        $unset: { activeContractClaim: 1 },
      },
    );

    const finalizedWithoutReportId = "failed-finalization-before-replacement";
    const finalizedWithoutReport = await request(app)
      .post("/api/asset/upload-session")
      .set(authHeader(String(user._id)))
      .send(requestBody(finalizedWithoutReportId));
    expect(finalizedWithoutReport.status).toBe(201);
    await ReportUploadSession.updateOne(
      { user: user._id, clientSubmissionId: finalizedWithoutReportId },
      {
        $set: {
          status: "completed",
          lastError: "A competing report acquired the contract claim",
        },
      },
    );

    const recoveredReplacementId = "replacement-after-failed-finalization";
    const recoveredReplacement = await request(app)
      .post("/api/asset/upload-session")
      .set(authHeader(String(user._id)))
      .send(
        requestBody(recoveredReplacementId, finalizedWithoutReportId),
      );
    expect(recoveredReplacement.status).toBe(201);
    expect(
      await ReportUploadSession.findOne({
        user: user._id,
        clientSubmissionId: finalizedWithoutReportId,
      }).lean(),
    ).toMatchObject({
      supersededByClientSubmissionId: recoveredReplacementId,
    });

    await ReportUploadSession.updateOne(
      { user: user._id, clientSubmissionId: recoveredReplacementId },
      {
        $set: { status: "processed" },
        $unset: { activeContractClaim: 1 },
      },
    );

    const acceptedOldId = "accepted-before-replacement";
    const acceptedCreated = await request(app)
      .post("/api/asset/upload-session")
      .set(authHeader(String(user._id)))
      .send(requestBody(acceptedOldId));
    expect(acceptedCreated.status).toBe(201);
    const acceptedReport = await AssetReport.create({
      user: user._id,
      client_submission_id: acceptedOldId,
      contract_no: "SUPERSEDE-100",
      grouping_mode: "mixed",
      imageUrls: [],
      lots: [],
      status: "processing",
      job_id: acceptedOldId,
      job_status: "queued",
    });
    await ReportUploadSession.updateOne(
      { user: user._id, clientSubmissionId: acceptedOldId },
      {
        $set: {
          status: "completed",
          reportId: String(acceptedReport._id),
        },
      },
    );

    const rejectedReplacementId = "too-late-replacement";
    const rejectedReplacement = await request(app)
      .post("/api/asset/upload-session")
      .set(authHeader(String(user._id)))
      .send(requestBody(rejectedReplacementId, acceptedOldId));
    expect(rejectedReplacement.status).toBe(409);
    expect(rejectedReplacement.body.code).toBe("ACTIVE_REPORT_EXISTS");
    await expect(
      ReportUploadSession.exists({
        user: user._id,
        clientSubmissionId: rejectedReplacementId,
      }),
    ).resolves.toBeNull();
  });

  it.each(uploadSessionReportCases.flatMap((reportCase) =>
    ["reportId", "placeholder", "outbox", "archived", "failedJob", "cancelledJob", "finalizationClaim"].map((evidence) => ({
      ...reportCase,
      evidence,
    }))
  ))("does not supersede a failed $label upload with $evidence evidence", async ({ type, path, evidence }) => {
    const user = await createAdmin();
    const clientSubmissionId = `${type}-failed-retained-${evidence}`;
    const body = uploadSessionRequestBody({ type, clientSubmissionId, coordinates: {} });
    const created = await request(app).post(path).set(authHeader(String(user._id))).send(body);
    expect(created.status).toBe(201);
    const sessionId = created.body.data.sessionId;
    const reportId = new mongoose.Types.ObjectId();
    const previewJobType = type === "asset" ? "asset-preview" : "lot-listing-preview";

    if (["placeholder", "outbox", "archived"].includes(evidence)) {
      const Model = type === "asset" ? AssetReport : LotListing;
      await Model.create({
        _id: reportId,
        user: user._id,
        client_submission_id: clientSubmissionId,
        contract_no: body.details.contract_no,
        location: "Regina, SK",
        sales_date: new Date("2026-09-30"),
        grouping_mode: "single_lot",
        imageUrls: [],
        lots: [],
        status: "error",
        job_id: clientSubmissionId,
        job_status: "error",
        ...(evidence === "archived" ? { adminArchivedAt: new Date() } : {}),
        ...(evidence === "outbox" ? {
          report_job_outbox: {
            token: "retained-upload-intent",
            type: previewJobType,
            reportId: String(reportId),
            progressId: clientSubmissionId,
            payload: {},
          },
        } : {}),
      } as any);
    }
    if (["failedJob", "cancelledJob"].includes(evidence)) {
      await ReportJob.create({
        type: previewJobType,
        reportId: String(reportId),
        progressId: clientSubmissionId,
        status: evidence === "failedJob" ? "failed" : "cancelled",
        payload: {},
      });
    }
    await ReportUploadSession.updateOne({ _id: sessionId }, {
      $set: {
        status: "failed",
        ...(evidence === "reportId" ? { reportId: String(reportId) } : {}),
        ...(evidence === "finalizationClaim" ? { finalizationClaimToken: "retained-completion-claim" } : {}),
      },
    });
    const before = await ReportUploadSession.findById(sessionId).select("+finalizationClaimToken").lean();
    const replacementId = `${clientSubmissionId}-replacement`;
    dependencyMocks.createPutUrl.mockClear();
    const replacement = await request(app).post(path).set(authHeader(String(user._id))).send({
      ...body,
      details: {
        ...body.details,
        client_submission_id: replacementId,
        progress_id: replacementId,
        supersedes_client_submission_id: clientSubmissionId,
      },
    });

    expect(replacement.status).toBe(409);
    expect(replacement.body.code).toBe(evidence === "reportId" ? "UPLOAD_SESSION_REPORT_UNAVAILABLE"
      : ["failedJob", "cancelledJob"].includes(evidence) ? "UPLOAD_SESSION_ACCEPTANCE_UNCONFIRMED" : "ACTIVE_REPORT_EXISTS");
    expect(replacement.body.data).toMatchObject({ canSupersede: false, canCreateSeparate: false });
    expect(await ReportUploadSession.findById(sessionId).select("+finalizationClaimToken").lean()).toEqual(before);
    expect(await ReportUploadSession.exists({ clientSubmissionId: replacementId })).toBeNull();
    expect(dependencyMocks.createPutUrl).not.toHaveBeenCalled();
    expect(dependencyMocks.deleteFromR2Strict).not.toHaveBeenCalled();
    expect(dependencyMocks.queueAssetPreviewJob).not.toHaveBeenCalled();
    expect(dependencyMocks.queueLotListingJob).not.toHaveBeenCalled();
  });

  it.each(uploadSessionReportCases)("fences $label supersession when a failed report link appears after preflight", async ({ type, path }) => {
    const user = await createAdmin();
    const clientSubmissionId = `${type}-supersede-report-race`;
    const replacementId = `${clientSubmissionId}-replacement`;
    const body = uploadSessionRequestBody({ type, clientSubmissionId, coordinates: {} });
    const created = await request(app).post(path).set(authHeader(String(user._id))).send(body);
    expect(created.status).toBe(201);
    const sessionId = new mongoose.Types.ObjectId(created.body.data.sessionId);
    const reportId = String(new mongoose.Types.ObjectId());
    const originalUpdate = ReportUploadSession.findOneAndUpdate.bind(ReportUploadSession);
    let concurrentReportLinked = false;
    const updateSpy = vi.spyOn(ReportUploadSession, "findOneAndUpdate").mockImplementation((...args: any[]) => {
      const query = (originalUpdate as any)(...args);
      if (args[1]?.$set?.supersededByClientSubmissionId === replacementId) {
        const originalExec = query.exec.bind(query);
        query.exec = async () => {
          // Preserve updatedAt deliberately: the report-link predicate must
          // protect legacy writers independently of the timestamp CAS.
          await ReportUploadSession.collection.updateOne({ _id: sessionId }, {
            $set: { status: "failed", reportId },
          });
          concurrentReportLinked = true;
          return originalExec();
        };
      }
      return query;
    });
    try {
      const replacement = await request(app).post(path).set(authHeader(String(user._id))).send({
        ...body,
        details: {
          ...body.details,
          client_submission_id: replacementId,
          progress_id: replacementId,
          supersedes_client_submission_id: clientSubmissionId,
        },
      });
      expect(concurrentReportLinked).toBe(true);
      expect(replacement.status).toBe(409);
      expect(replacement.body).toMatchObject({ code: "UPLOAD_SESSION_REPORT_UNAVAILABLE",
        data: { accepted: false, reportAvailable: false, canSupersede: false, canCreateSeparate: false } });
      const original = await ReportUploadSession.findById(sessionId).lean();
      expect(original).toMatchObject({ status: "failed", reportId });
      expect(original?.cleanupStartedAt).toBeUndefined();
      expect(original?.supersededByClientSubmissionId).toBeUndefined();
      expect(await ReportUploadSession.exists({ clientSubmissionId: replacementId })).toBeNull();
      expect(dependencyMocks.deleteFromR2Strict).not.toHaveBeenCalled();
    } finally {
      updateSpy.mockRestore();
    }
  });

  it("keeps a superseded tombstone until its upload targets expire, then removes its objects", async () => {
    const user = await createAdmin();
    const session = await ReportUploadSession.create({
      type: "asset",
      status: "uploading",
      user: user._id,
      jobId: "superseded-cleanup-job",
      clientSubmissionId: "superseded-cleanup-session",
      details: { contract_no: "SUPERSEDE-CLEANUP-100" },
      r2Bucket: "report-conflict-test",
      r2PublicBaseUrl: "https://assetinsight.test",
      files: [
        {
          fileId: "images-0",
          key: "report-sessions/superseded-cleanup-session/photo.jpg",
          fieldname: "images",
          originalname: "photo.jpg",
          mimetype: "image/jpeg",
          size: 2_048,
        },
      ],
      expectedFileCount: 1,
      expectedImageCount: 1,
      expectedVideoCount: 0,
      totalBytes: 2_048,
      cleanupStartedAt: new Date(Date.now() - 2 * 60 * 60 * 1_000),
      cleanupNotBefore: new Date(Date.now() + 60 * 60 * 1_000),
      supersededAt: new Date(Date.now() - 2 * 60 * 60 * 1_000),
      supersededByClientSubmissionId: "replacement-cleanup-session",
    });

    await expect(cleanupAbandonedSmartUploadSessions()).resolves.toEqual({
      sessions: 0,
      objects: 0,
      failedObjects: 0,
    });
    await expect(
      ReportUploadSession.exists({ _id: session._id }),
    ).resolves.toBeTruthy();
    expect(dependencyMocks.deleteFromR2Strict).not.toHaveBeenCalled();

    await ReportUploadSession.updateOne(
      { _id: session._id },
      { $set: { cleanupNotBefore: new Date(Date.now() - 60_000) } },
    );

    await expect(cleanupAbandonedSmartUploadSessions()).resolves.toEqual({
      sessions: 1,
      objects: 1,
      failedObjects: 0,
    });
    expect(dependencyMocks.deleteFromR2Strict).toHaveBeenCalledWith(
      "report-conflict-test",
      "report-sessions/superseded-cleanup-session/photo.jpg",
    );
    await expect(
      ReportUploadSession.exists({ _id: session._id }),
    ).resolves.toBeNull();
  });

  it("removes an expired legacy session tombstone without deleting legacy objects", async () => {
    const user = await createAdmin();
    const legacyKey =
      "report-sessions/legacy-superseded-cleanup-session/photo.jpg";
    const session = await ReportUploadSession.create({
      type: "asset",
      status: "uploading",
      user: user._id,
      jobId: "legacy-superseded-cleanup-job",
      clientSubmissionId: "legacy-superseded-cleanup-session",
      details: { contract_no: "LEGACY-SUPERSEDE-CLEANUP-100" },
      files: [
        {
          fileId: "images-0",
          key: legacyKey,
          fieldname: "images",
          originalname: "photo.jpg",
          mimetype: "image/jpeg",
          size: 2_048,
        },
      ],
      expectedFileCount: 1,
      expectedImageCount: 1,
      expectedVideoCount: 0,
      totalBytes: 2_048,
      cleanupStartedAt: new Date(Date.now() - 2 * 60 * 60 * 1_000),
      cleanupNotBefore: new Date(Date.now() - 60_000),
      supersededAt: new Date(Date.now() - 2 * 60 * 60 * 1_000),
      supersededByClientSubmissionId: "replacement-cleanup-session",
    });

    await expect(cleanupAbandonedSmartUploadSessions()).resolves.toEqual({
      sessions: 1,
      objects: 0,
      failedObjects: 0,
    });
    expect(dependencyMocks.deleteFromR2Strict).not.toHaveBeenCalled();
    await expect(
      ReportUploadSession.exists({ _id: session._id }),
    ).resolves.toBeNull();
  });

  it("keeps legacy Smart Uploads readable and verifiable without issuing new writes", async () => {
    const user = await createAdmin();
    const legacyKey = "uploads/report-sessions/asset/legacy-session/photo.jpg";
    const session = await ReportUploadSession.create({
      type: "asset",
      status: "uploading",
      user: user._id,
      jobId: "legacy-smart-upload-job",
      clientSubmissionId: "legacy-smart-upload-session",
      smartUpload: true,
      smartGrouping: {
        status: "uploading",
        progressPercent: 0,
        revision: 0,
        groups: [],
        dividerFileIds: [],
        unresolvedDividerIds: [],
        warnings: [],
        metrics: [],
      },
      details: {
        contract_no: "LEGACY-SMART-UPLOAD-100",
        grouping_mode: "mixed",
        smart_upload: true,
      },
      files: [
        {
          fileId: "images-0",
          key: legacyKey,
          fieldname: "images",
          originalname: "photo.jpg",
          mimetype: "image/jpeg",
          size: 2_048,
          imageIndex: 0,
          originalOrder: 0,
          role: "main",
        },
      ],
      expectedFileCount: 1,
      expectedImageCount: 1,
      expectedVideoCount: 0,
      totalBytes: 2_048,
    });

    const resumed = await request(app)
      .post("/api/asset/upload-session")
      .set(authHeader(String(user._id)))
      .send({
        details: {
          contract_no: "LEGACY-SMART-UPLOAD-100",
          grouping_mode: "mixed",
          smart_upload: true,
          client_submission_id: "legacy-smart-upload-session",
          progress_id: "legacy-smart-upload-session",
        },
        files: [
          {
            fileId: "images-0",
            name: "photo.jpg",
            type: "image/jpeg",
            size: 2_048,
            fieldname: "images",
            imageIndex: 0,
            originalOrder: 0,
            role: "main",
          },
        ],
      });

    expect(resumed.status).toBe(409);
    expect(resumed.body).toMatchObject({
      code: "LEGACY_UPLOAD_SESSION_READ_ONLY",
    });
    expect(dependencyMocks.createPutUrl).not.toHaveBeenCalled();

    const targets = await request(app)
      .get(`/api/asset/upload-session/${session._id}/targets`)
      .set(authHeader(String(user._id)));

    expect(targets.status).toBe(409);
    expect(targets.body).toMatchObject({
      code: "LEGACY_UPLOAD_SESSION_READ_ONLY",
    });
    expect(dependencyMocks.createPutUrl).not.toHaveBeenCalled();

    const fallback = await request(app)
      .post(`/api/asset/upload-session/${session._id}/files/images-0`)
      .set(authHeader(String(user._id)))
      .attach("file", Buffer.alloc(2_048), {
        filename: "photo.jpg",
        contentType: "image/jpeg",
      });

    expect(fallback.status).toBe(409);
    expect(fallback.body).toMatchObject({
      code: "LEGACY_UPLOAD_SESSION_READ_ONLY",
    });
    expect(dependencyMocks.uploadFilePathToR2).not.toHaveBeenCalled();

    const confirmed = await request(app)
      .post(`/api/asset/upload-session/${session._id}/confirm-files`)
      .set(authHeader(String(user._id)))
      .send({ fileIds: ["images-0"] });

    expect(confirmed.status).toBe(200);
    expect(dependencyMocks.headR2Object).toHaveBeenCalledWith(
      "legacy-report-conflict-test",
      legacyKey,
    );

    const grouping = await request(app)
      .get(`/api/asset/upload-session/${session._id}/smart-grouping`)
      .set(authHeader(String(user._id)));
    expect(grouping.status).toBe(200);
    expect(grouping.body.data.files[0].url).toBe(
      `https://images.sellsnap.test/${legacyKey}`,
    );
  });

  it("detects same-name file replacements in current manifests and preserves legacy retries", async () => {
    const user = await createAdmin();
    const requestBody = (clientSubmissionId: string, lastModified: number) => ({
      details: {
        contract_no: `MANIFEST-${clientSubmissionId}`,
        grouping_mode: "mixed",
        mixed_lots: [
          { count: 1, extra_count: 0, mode: "single_lot" },
        ],
        client_submission_id: clientSubmissionId,
        progress_id: clientSubmissionId,
      },
      files: [
        {
          fileId: "images-0",
          name: "photo.jpg",
          type: "image/jpeg",
          size: 1_024,
          lastModified,
          fieldname: "images",
          imageIndex: 0,
          originalOrder: 0,
          role: "main",
        },
      ],
    });

    const currentId = "current-manifest";
    const created = await request(app)
      .post("/api/asset/upload-session")
      .set(authHeader(String(user._id)))
      .send(requestBody(currentId, 100));
    expect(created.status).toBe(201);

    const replacement = await request(app)
      .post("/api/asset/upload-session")
      .set(authHeader(String(user._id)))
      .send(requestBody(currentId, 200));
    expect(replacement.status).toBe(409);
    expect(replacement.body.code).toBe("SUBMISSION_MANIFEST_CHANGED");
    expect(replacement.body.data).toMatchObject({ sessionId: created.body.data.sessionId,
      accepted: false, reportAvailable: null, canSupersede: true, canCreateSeparate: false });

    const currentSession = await ReportUploadSession.findOne({
      user: user._id,
      clientSubmissionId: currentId,
    }).lean();
    expect(currentSession?.manifestVersion).toBe(2);
    expect(currentSession?.files[0]?.lastModified).toBe(100);

    const legacyId = "legacy-manifest";
    const legacyCreated = await request(app)
      .post("/api/asset/upload-session")
      .set(authHeader(String(user._id)))
      .send(requestBody(legacyId, 300));
    expect(legacyCreated.status).toBe(201);

    const legacyHash = createHash("sha256")
      .update(
        JSON.stringify([
          {
            originalname: "photo.jpg",
            mimetype: "image/jpeg",
            size: 1_024,
            imageIndex: 0,
            role: "main",
            originalOrder: 0,
          },
        ]),
      )
      .digest("hex");
    await ReportUploadSession.updateOne(
      { user: user._id, clientSubmissionId: legacyId },
      {
        $set: { manifestHash: legacyHash },
        $unset: { manifestVersion: "", "files.0.lastModified": "" },
      },
    );

    const legacyRetry = await request(app)
      .post("/api/asset/upload-session")
      .set(authHeader(String(user._id)))
      .send(requestBody(legacyId, 999));
    expect(legacyRetry.status).toBe(200);
    expect(legacyRetry.body.data).toMatchObject({ resumed: true });
  });

  it.each(uploadSessionReportCases)("does not label a $label placeholder as an accepted manifest conflict", async ({ type, path }) => {
    const user = await createAdmin();
    const clientSubmissionId = `${type}-placeholder-conflict`;
    const body = uploadSessionRequestBody({ type, clientSubmissionId, coordinates: {} });
    const created = await request(app).post(path).set(authHeader(String(user._id))).send(body);
    expect(created.status).toBe(201);
    const Model = type === "asset" ? AssetReport : LotListing;
    const report = await Model.create({ user: user._id, client_submission_id: clientSubmissionId,
      contract_no: body.details.contract_no, grouping_mode: "single_lot", location: "Regina",
      sales_date: new Date(), status: "processing", job_status: "queued", job_id: clientSubmissionId,
      imageUrls: [], lots: [], valuation_methods: ["FML"] } as any);
    await ReportUploadSession.updateOne({ _id: created.body.data.sessionId }, { $set: { status: "completed", reportId: String(report._id) } });
    const conflict = await request(app).post(path).set(authHeader(String(user._id))).send({
      ...body, files: body.files.map((file) => ({ ...file, name: "changed.jpg", originalname: "changed.jpg" })),
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: "SUBMISSION_MANIFEST_CHANGED", data: {
      sessionId: created.body.data.sessionId, status: "preparing", accepted: false, reportAvailable: true,
      canSupersede: false, canCreateSeparate: false,
    } });
    expect(conflict.body.data).not.toHaveProperty("reportId");
    expect(await ReportJob.countDocuments()).toBe(0);
    expect(await Model.countDocuments()).toBe(1);
  });

  it.each(uploadSessionReportCases)("admits an explicitly separate $label identity without changing the unavailable accepted upload", async ({ type, path }) => {
    const user = await createAdmin();
    const clientSubmissionId = `${type}-removed-report`;
    const body = uploadSessionRequestBody({ type, clientSubmissionId, coordinates: {} });
    const created = await request(app).post(path).set(authHeader(String(user._id))).send(body);
    expect(created.status).toBe(201);
    await ReportUploadSession.updateOne({ _id: created.body.data.sessionId }, { $set: {
      status: "processed", reportId: String(new mongoose.Types.ObjectId()), uploadCompletedAt: new Date(),
    } });
    await ReportDraft.create({ user: user._id, type, clientDraftId: clientSubmissionId, revision: 8,
      formData: { retained: "Original saved work" } });
    const original = await ReportUploadSession.findById(created.body.data.sessionId).lean();
    const originalDraft = await ReportDraft.findOne({ clientDraftId: clientSubmissionId }).lean();
    const freshId = `${clientSubmissionId}-explicit-new`;
    const fresh = await request(app).post(path).set(authHeader(String(user._id))).send({
      ...body, details: { ...body.details, client_submission_id: freshId, progress_id: freshId },
    });
    expect(fresh.status).toBe(201);
    expect(fresh.body.data.sessionId).not.toBe(created.body.data.sessionId);
    expect(await ReportUploadSession.findById(created.body.data.sessionId).lean()).toEqual(original);
    expect(await ReportDraft.findOne({ clientDraftId: clientSubmissionId }).lean()).toEqual(originalDraft);
    expect(await ReportJob.countDocuments()).toBe(0);
    expect(dependencyMocks.deleteFromR2Strict).not.toHaveBeenCalled();
  });

  it("allows a separate upload session when another same-contract report is active", async () => {
    const user = await createAdmin();
    const hiddenPreview = await AssetReport.create({
      user: user._id,
      grouping_mode: "mixed",
      imageUrls: [],
      lots: [],
      contract_no: "HTTP-SESSION-100",
      client_submission_id: "saved-draft-preview",
      is_draft_preview: true,
      status: "processing",
      job_status: "queued",
    });
    const requestBody = (clientSubmissionId: string) => ({
      details: {
        contract_no: "HTTP-SESSION-100",
        grouping_mode: "mixed",
        mixed_lots: [
          { count: 1, extra_count: 0, mode: "single_lot" },
        ],
        client_submission_id: clientSubmissionId,
        progress_id: clientSubmissionId,
      },
      files: [
        {
          fileId: "images-0",
          name: "photo.jpg",
          type: "image/jpeg",
          size: 1_024,
          fieldname: "images",
          imageIndex: 0,
          originalOrder: 0,
          role: "main",
        },
      ],
    });

    const accepted = await request(app)
      .post("/api/asset/upload-session")
      .set(authHeader(String(user._id)))
      .send(requestBody("complete-submission"));
    expect(accepted.status).toBe(201);
    expect(accepted.body.code).not.toBe("ACTIVE_REPORT_EXISTS");

    const genuineActive = await AssetReport.create({
      user: user._id,
      grouping_mode: "mixed",
      imageUrls: [],
      lots: [],
      contract_no: "HTTP-SESSION-100",
      client_submission_id: "genuine-active-submission",
      status: "processing",
      job_status: "processing",
    });
    const second = await request(app)
      .post("/api/asset/upload-session")
      .set(authHeader(String(user._id)))
      .send(requestBody("second-complete-submission"));
    expect(second.status).toBe(201);
    expect(String(genuineActive._id)).not.toBe(String(hiddenPreview._id));
  });

  it("allows separate same-contract reports through the legacy Asset endpoint", async () => {
    const user = await createAdmin();
    await AssetReport.create({
      user: user._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      contract_no: "HTTP-LEGACY-HIDDEN",
      client_submission_id: "legacy-saved-preview",
      is_draft_preview: true,
      status: "processing",
      job_status: "queued",
    });

    const accepted = await request(app)
      .post("/api/asset")
      .set(authHeader(String(user._id)))
      .send({
        details: JSON.stringify({
          contract_no: "HTTP-LEGACY-HIDDEN",
          grouping_mode: "single_lot",
          client_submission_id: "legacy-complete-submission",
        }),
      });
    expect(accepted.status).toBe(202);
    expect(accepted.body.code).not.toBe("ACTIVE_REPORT_EXISTS");
    expect(dependencyMocks.queueAssetPreviewJob).toHaveBeenCalledTimes(1);

    const genuineActive = await AssetReport.create({
      user: user._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      contract_no: "HTTP-LEGACY-ACTIVE",
      client_submission_id: "legacy-genuine-active",
      status: "processing",
      job_status: "queued",
    });
    const second = await request(app)
      .post("/api/asset")
      .set(authHeader(String(user._id)))
      .send({
        details: JSON.stringify({
          contract_no: "HTTP-LEGACY-ACTIVE",
          grouping_mode: "single_lot",
          client_submission_id: "legacy-second-submission",
        }),
      });
    expect(second.status).toBe(202);
    expect(genuineActive).toBeTruthy();
    expect(dependencyMocks.queueAssetPreviewJob).toHaveBeenCalledTimes(2);
  });

  it("does not let an Asset draft preview block the complete submission", async () => {
    const userId = new mongoose.Types.ObjectId();
    await AssetReport.create({
      user: userId,
      grouping_mode: "mixed",
      imageUrls: [],
      lots: [],
      contract_no: "A-100",
      client_submission_id: "saved-draft-preview",
      is_draft_preview: true,
      status: "processing",
      job_status: "queued",
    });

    await expect(
      findActiveSameContractReport({
        reportType: "asset",
        userId,
        contractNo: " A-100 ",
        excludeClientSubmissionId: "final-submission",
      }),
    ).resolves.toBeNull();
  });

  it("does not let a Lot Listing draft preview block the complete submission", async () => {
    const userId = new mongoose.Types.ObjectId();
    await LotListing.create({
      user: userId,
      contract_no: "L-200",
      sales_date: new Date("2026-08-31T00:00:00.000Z"),
      location: "Calgary",
      imageUrls: [],
      videoUrls: [],
      lots: [],
      client_submission_id: "saved-draft-preview",
      is_draft_preview: true,
      status: "processing",
      job_status: "processing",
    });

    await expect(
      findActiveSameContractReport({
        reportType: "lotListing",
        userId,
        contractNo: "L-200",
      }),
    ).resolves.toBeNull();
  });

  it("never treats a genuine active same-contract report as an identity conflict", async () => {
    const userId = new mongoose.Types.ObjectId();
    const report = await AssetReport.create({
      user: userId,
      grouping_mode: "mixed",
      imageUrls: [],
      lots: [],
      contract_no: "A-300",
      client_submission_id: "active-submission",
      status: "processing",
      job_status: "queued",
    });

    await expect(findActiveSameContractReport({
      reportType: "asset",
      userId,
      contractNo: "A-300",
      excludeClientSubmissionId: "new-submission",
    })).resolves.toBeNull();
    expect(report).toBeTruthy();

    await expect(
      findActiveSameContractReport({
        reportType: "asset",
        userId,
        contractNo: "A-300",
        excludeClientSubmissionId: "active-submission",
      }),
    ).resolves.toBeNull();
  });

  it("promotes and submits an Asset draft preview from the exact edited snapshot", async () => {
    const user = await createAdmin();
    const revision = 4;
    const draft = await ReportDraft.create({
      user: user._id,
      type: "asset",
      clientDraftId: "promote-asset-draft",
      revision,
      contractNo: "DRAFT-ASSET-400",
      title: "Asset draft",
      previewStatus: "ready",
      previewProcessedRevision: revision,
      media: [
        {
          clientFileId: "source-image",
          lotId: "lot-1",
          slot: "main",
          r2Key: "report-drafts/source-image.jpg",
          uploadedAt: new Date(),
        },
      ],
    });
    const report = await AssetReport.create({
      user: user._id,
      grouping_mode: "mixed",
      imageUrls: ["https://assetinsight.test/uploads/asset/image.jpg"],
      lots: [{ lot_id: "lot-1", lot_number: "1", description: "Old description" }],
      contract_no: "DRAFT-ASSET-400",
      client_submission_id: "draft-preview:promote-asset-draft",
      is_draft_preview: true,
      source_draft_id: draft._id,
      source_draft_revision: revision,
      status: "preview",
      job_status: "done",
      preview_data: {
        contract_no: "DRAFT-ASSET-400",
        currency: "CAD",
        lots: [{ lot_id: "lot-1", lot_number: "1", description: "Old description" }],
      },
    });
    await ReportDraft.updateOne(
      { _id: draft._id },
      { $set: { previewReportId: report._id } }
    );
    const editedPreview = {
      contract_no: "DRAFT-ASSET-400",
      currency: "CAD",
      lots: [
        {
          lot_id: "lot-1",
          lot_number: "825291",
          title: "Edited asset",
          description: "Exact edited draft preview description",
          estimated_value: "CAD 100",
          image_indexes: [0],
          image_urls: ["https://assetinsight.test/uploads/asset/image.jpg"],
        },
      ],
    };

    const response = await request(app)
      .post(`/api/report-drafts/${draft._id}/promote-preview`)
      .set(authHeader(String(user._id)))
      .send({ submit: true, preview_data: editedPreview });

    expect(response.status).toBe(202);
    expect(response.body.data).toMatchObject({
      reportId: String(report._id),
      reportType: "asset",
      files_generating: true,
    });
    expect(dependencyMocks.queuePreviewFilesJob).toHaveBeenCalledTimes(1);
    expect(
      dependencyMocks.queuePreviewFilesJob.mock.calls[0]?.[1]
        ?.previewDataSnapshot?.lots?.[0]
    ).toMatchObject({
      lot_number: "825291",
      description: "Exact edited draft preview description",
    });

    const persistedReport: any = await AssetReport.findById(report._id).lean();
    expect(persistedReport.is_draft_preview).toBe(false);
    expect(persistedReport.preview_submitted_at).toBeTruthy();
    expect(persistedReport.preview_data.lots[0]).toMatchObject({
      lot_number: "825291",
      description: "Exact edited draft preview description",
    });
    const retainedDraft: any = await ReportDraft.findById(draft._id).lean();
    expect(String(retainedDraft.promotedReportId)).toBe(String(report._id));
    expect(retainedDraft.promotedAt).toBeTruthy();
    expect(retainedDraft.media[0].r2Key).toBe("report-drafts/source-image.jpg");

    const duplicateSubmit = await request(app)
      .post(`/api/report-drafts/${draft._id}/promote-preview`)
      .set(authHeader(String(user._id)))
      .send({ submit: true, preview_data: editedPreview });
    expect(duplicateSubmit.status).toBe(202);
    expect(dependencyMocks.queuePreviewFilesJob).toHaveBeenCalledTimes(1);

    const drafts = await request(app)
      .get("/api/report-drafts")
      .set(authHeader(String(user._id)));
    expect(drafts.status).toBe(200);
    expect(drafts.body.data).toEqual([]);
  });

  it("promotes an Asset draft when another report shares its contract", async () => {
    await AssetReport.syncIndexes();
    const user = await createAdmin();
    const revision = 2;
    const contractNo = "DRAFT-ASSET-CONTRACT-CLAIM";
    await AssetReport.create({
      user: user._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      contract_no: contractNo,
      submission_contract_claim: contractNo.toLowerCase(),
      client_submission_id: "active-contract-owner",
      status: "processing",
      job_id: "active-contract-job",
      job_status: "queued",
    });
    const draft = await ReportDraft.create({
      user: user._id,
      type: "asset",
      clientDraftId: "asset-draft-contract-claim",
      revision,
      contractNo,
      formData: { contract_no: contractNo },
      previewStatus: "ready",
      previewProcessedRevision: revision,
    });
    const hidden = await AssetReport.create({
      user: user._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      contract_no: contractNo,
      client_submission_id: "draft-preview:asset-draft-contract-claim",
      is_draft_preview: true,
      source_draft_id: draft._id,
      source_draft_revision: revision,
      status: "preview",
      job_status: "done",
      preview_data: { contract_no: contractNo, currency: "CAD", lots: [] },
    });
    await ReportDraft.updateOne(
      { _id: draft._id },
      { $set: { previewReportId: hidden._id } }
    );

    const response = await request(app)
      .post(`/api/report-drafts/${draft._id}/promote-preview`)
      .set(authHeader(String(user._id)))
      .send({
        submit: true,
        preview_data: { contract_no: contractNo, currency: "CAD", lots: [] },
      });

    expect(response.status).toBe(202);
    expect(dependencyMocks.queuePreviewFilesJob).toHaveBeenCalledTimes(1);
    const promotedReport: any = await AssetReport.findById(hidden._id)
      .select("+submission_contract_claim")
      .lean();
    expect(promotedReport).toMatchObject({
      is_draft_preview: false,
      job_status: "queued",
    });
    expect(promotedReport.submission_contract_claim).toBeUndefined();
    const promotedDraft: any = await ReportDraft.findById(draft._id).lean();
    expect(String(promotedDraft.promotedReportId)).toBe(String(hidden._id));
    expect(promotedDraft.promotedAt).toBeTruthy();
  });

  it("preserves a draft's explicit force-new override during Asset promotion", async () => {
    await AssetReport.syncIndexes();
    const user = await createAdmin();
    const revision = 1;
    const contractNo = "DRAFT-ASSET-FORCE-NEW";
    await AssetReport.create({
      user: user._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      contract_no: contractNo,
      submission_contract_claim: contractNo.toLowerCase(),
      client_submission_id: "force-new-existing-owner",
      status: "processing",
      job_id: "force-new-existing-job",
      job_status: "queued",
    });
    const draft = await ReportDraft.create({
      user: user._id,
      type: "asset",
      clientDraftId: "asset-draft-force-new",
      revision,
      contractNo,
      formData: { contract_no: contractNo, force_new: true },
      previewStatus: "ready",
      previewProcessedRevision: revision,
    });
    const hidden = await AssetReport.create({
      user: user._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      contract_no: contractNo,
      client_submission_id: "draft-preview:asset-draft-force-new",
      is_draft_preview: true,
      source_draft_id: draft._id,
      source_draft_revision: revision,
      status: "preview",
      job_status: "done",
      preview_data: { contract_no: contractNo, currency: "CAD", lots: [] },
    });
    await ReportDraft.updateOne(
      { _id: draft._id },
      { $set: { previewReportId: hidden._id } }
    );

    const response = await request(app)
      .post(`/api/report-drafts/${draft._id}/promote-preview`)
      .set(authHeader(String(user._id)))
      .send({
        submit: true,
        preview_data: { contract_no: contractNo, currency: "CAD", lots: [] },
      });

    expect(response.status).toBe(202);
    expect(dependencyMocks.queuePreviewFilesJob).toHaveBeenCalledTimes(1);
    const promoted: any = await AssetReport.findById(hidden._id)
      .select("+submission_contract_claim")
      .lean();
    expect(promoted.is_draft_preview).toBe(false);
    expect(promoted.submission_contract_claim).toBeUndefined();
  });

  it("ignores a legacy inactive claim while promoting a ready Asset draft", async () => {
    await AssetReport.syncIndexes();
    const user = await createAdmin();
    const revision = 3;
    const contractNo = "DRAFT-ASSET-INACTIVE-CLAIM";
    const completed = await AssetReport.create({
      user: user._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      contract_no: contractNo,
      submission_contract_claim: contractNo.toLowerCase(),
      client_submission_id: "inactive-contract-owner",
      status: "approved",
      job_id: "inactive-contract-job",
      job_status: "done",
    });
    const draft = await ReportDraft.create({
      user: user._id,
      type: "asset",
      clientDraftId: "asset-draft-inactive-claim",
      revision,
      contractNo,
      formData: { contract_no: contractNo },
      previewStatus: "ready",
      previewProcessedRevision: revision,
    });
    const hidden = await AssetReport.create({
      user: user._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      contract_no: contractNo,
      client_submission_id: "draft-preview:asset-draft-inactive-claim",
      is_draft_preview: true,
      source_draft_id: draft._id,
      source_draft_revision: revision,
      status: "preview",
      job_status: "done",
      preview_data: { contract_no: contractNo, currency: "CAD", lots: [] },
    });
    await ReportDraft.updateOne(
      { _id: draft._id },
      { $set: { previewReportId: hidden._id } }
    );

    const response = await request(app)
      .post(`/api/report-drafts/${draft._id}/promote-preview`)
      .set(authHeader(String(user._id)))
      .send({
        submit: true,
        preview_data: { contract_no: contractNo, currency: "CAD", lots: [] },
      });

    expect(response.status).toBe(202);
    expect(dependencyMocks.queuePreviewFilesJob).toHaveBeenCalledTimes(1);
    const [oldReport, promoted]: any[] = await Promise.all([
      AssetReport.findById(completed._id)
        .select("+submission_contract_claim")
        .lean(),
      AssetReport.findById(hidden._id)
        .select("+submission_contract_claim")
        .lean(),
    ]);
    expect(oldReport.submission_contract_claim).toBe(contractNo.toLowerCase());
    expect(promoted).toMatchObject({
      is_draft_preview: false,
      job_status: "queued",
    });
    expect(promoted.submission_contract_claim).toBeUndefined();
  });

  it("promotes and submits a Lot Listing draft preview from the exact edited snapshot", async () => {
    const user = await createAdmin();
    const revision = 2;
    const draft = await ReportDraft.create({
      user: user._id,
      type: "lotListing",
      clientDraftId: "promote-listing-draft",
      revision,
      contractNo: "DRAFT-LISTING-200",
      title: "Listing draft",
      previewStatus: "ready",
      previewProcessedRevision: revision,
    });
    const sourceLot = {
      lot_id: "listing-lot-1",
      lot_number: "1",
      title: "Old listing lot",
      description: "Old description",
      estimated_value: "CAD 500",
      condition_report_selections: {
        condition: "N/A",
        completeness: "N/A",
        legal: "N/A",
      },
    };
    const listing = await LotListing.create({
      user: user._id,
      contract_no: "DRAFT-LISTING-200",
      sales_date: new Date("2026-09-01T00:00:00.000Z"),
      location: "Regina, SK",
      imageUrls: ["https://assetinsight.test/uploads/lot-listing/image.jpg"],
      videoUrls: [],
      lots: [sourceLot],
      client_submission_id: "draft-preview:promote-listing-draft",
      is_draft_preview: true,
      source_draft_id: draft._id,
      source_draft_revision: revision,
      status: "preview",
      job_status: "done",
      valuation_methods: ["FML"],
      preview_data: {
        contract_no: "DRAFT-LISTING-200",
        sales_date: "2026-09-01T00:00:00.000Z",
        location: "Regina, SK",
        currency: "CAD",
        valuation_methods: ["FML"],
        lots: [sourceLot],
      },
    });
    await ReportDraft.updateOne(
      { _id: draft._id },
      { $set: { previewReportId: listing._id } }
    );

    const blockedDraftCrRefresh = await request(app)
      .post(`/api/lot-listing/${listing._id}/preview/spec-pdf`)
      .set(authHeader(String(user._id)));
    expect(blockedDraftCrRefresh.status).toBe(409);
    expect(blockedDraftCrRefresh.body.code).toBe(
      "DRAFT_PREVIEW_NOT_PROMOTED"
    );

    const editedPreview = {
      contract_no: "DRAFT-LISTING-200",
      sales_date: "2026-09-01T00:00:00.000Z",
      location: "Regina, SK",
      currency: "CAD",
      valuation_methods: ["FML"],
      lots: [
        {
          ...sourceLot,
          lot_number: "200",
          title: "Edited listing lot",
          description: "Exact edited listing draft description",
        },
      ],
    };

    const response = await request(app)
      .post(`/api/report-drafts/${draft._id}/promote-preview`)
      .set(authHeader(String(user._id)))
      .send({ submit: true, preview_data: editedPreview });

    expect(response.status).toBe(202);
    expect(response.body.data).toMatchObject({
      reportId: String(listing._id),
      reportType: "lotListing",
    });
    expect(dependencyMocks.regenerateLotListingFiles).toHaveBeenCalledTimes(1);
    expect(
      dependencyMocks.regenerateLotListingFiles.mock.calls[0]?.[0]
        ?.previewDataSnapshot?.lots?.[0]
    ).toMatchObject({
      lot_number: "200",
      title: "Edited listing lot",
      description: expect.stringContaining("Exact edited listing draft description"),
    });
    const persisted: any = await LotListing.findById(listing._id).lean();
    expect(persisted.is_draft_preview).toBe(false);
    expect(persisted.preview_submitted_at).toBeTruthy();
  });

  it("moves a ready draft preview into main previews without queueing files", async () => {
    const user = await createAdmin();
    const revision = 1;
    const draft = await ReportDraft.create({
      user: user._id,
      type: "asset",
      clientDraftId: "move-only-draft",
      revision,
      previewStatus: "ready",
      previewProcessedRevision: revision,
    });
    const report = await AssetReport.create({
      user: user._id,
      grouping_mode: "mixed",
      imageUrls: [],
      lots: [],
      contract_no: "MOVE-ONLY-1",
      client_submission_id: "draft-preview:move-only-draft",
      is_draft_preview: true,
      source_draft_id: draft._id,
      source_draft_revision: revision,
      status: "preview",
      job_status: "done",
      preview_data: { contract_no: "MOVE-ONLY-1", lots: [] },
    });
    await ReportDraft.updateOne(
      { _id: draft._id },
      { $set: { previewReportId: report._id } }
    );

    const moved = await request(app)
      .post(`/api/report-drafts/${draft._id}/promote-preview`)
      .set(authHeader(String(user._id)))
      .send({ submit: false });
    expect(moved.status).toBe(200);
    expect(moved.body.data).toMatchObject({
      reportId: String(report._id),
      reportType: "asset",
      status: "preview",
      files_generating: false,
    });
    expect(dependencyMocks.queuePreviewFilesJob).not.toHaveBeenCalled();
    expect((await AssetReport.findById(report._id).lean())?.is_draft_preview).toBe(false);

    const retried = await request(app)
      .post(`/api/report-drafts/${draft._id}/promote-preview`)
      .set(authHeader(String(user._id)))
      .send({ submit: false });
    expect(retried.status).toBe(200);
    expect(retried.body.data.reportId).toBe(String(report._id));
  });

  it("restores a stale promotion claim when its prepared report is missing", async () => {
    const user = await createAdmin();
    const missingReportId = new mongoose.Types.ObjectId();
    const draft = await ReportDraft.create({
      user: user._id,
      type: "asset",
      clientDraftId: "stale-missing-preview-claim",
      revision: 8,
      previewStatus: "ready",
      previewReportId: missingReportId,
      previewRequestedRevision: 8,
      previewProcessedRevision: 8,
      previewJobId: "missing-draft-preview-job",
      previewRequestedAt: new Date("2026-09-02T09:00:00.000Z"),
      previewReadyAt: new Date("2026-09-02T09:01:00.000Z"),
      promotedReportId: missingReportId,
      promotedSubmitted: true,
      promotionToken: "internal-stale-promotion-token",
      promotionClaimedAt: new Date(Date.now() - 3 * 60 * 1000),
    });

    const listed = await request(app)
      .get("/api/report-drafts")
      .set(authHeader(String(user._id)));
    expect(listed.status).toBe(200);
    const listedDraft = listed.body.data.find(
      (item: any) => String(item._id) === String(draft._id)
    );
    expect(listedDraft).toBeTruthy();
    expect(listedDraft).not.toHaveProperty("promotionToken");
    expect(listedDraft).not.toHaveProperty("promotionClaimedAt");

    const recovered = await request(app)
      .post(`/api/report-drafts/${draft._id}/promote-preview`)
      .set(authHeader(String(user._id)))
      .send({ submit: false });
    expect(recovered.status).toBe(409);
    expect(recovered.body.code).toBe("DRAFT_PREVIEW_MISSING");

    const persisted: any = await ReportDraft.findById(draft._id).lean();
    expect(persisted.previewStatus).toBe("idle");
    expect(persisted.previewReportId).toBeUndefined();
    expect(persisted.previewProcessedRevision).toBeUndefined();
    expect(persisted.promotedReportId).toBeUndefined();
    expect(persisted.promotionToken).toBeUndefined();
    expect(persisted.promotionClaimedAt).toBeUndefined();
  });

  it("keeps an approved Asset draft preview visible and retryable when file queueing fails", async () => {
    const user = await createAdmin();
    const revision = 3;
    const draft = await ReportDraft.create({
      user: user._id,
      type: "asset",
      clientDraftId: "approved-asset-queue-retry",
      revision,
      previewStatus: "ready",
      previewProcessedRevision: revision,
    });
    const report = await AssetReport.create({
      user: user._id,
      grouping_mode: "mixed",
      imageUrls: ["https://assetinsight.test/uploads/asset/retry.jpg"],
      lots: [{ lot_id: "retry-lot", lot_number: "1", description: "Before edit" }],
      contract_no: "DRAFT-ASSET-RETRY",
      client_submission_id: "draft-preview:approved-asset-queue-retry",
      is_draft_preview: true,
      source_draft_id: draft._id,
      source_draft_revision: revision,
      status: "approved",
      job_status: "done",
      preview_submitted_at: new Date("2026-09-01T09:00:00.000Z"),
      preview_data: {
        contract_no: "DRAFT-ASSET-RETRY",
        currency: "CAD",
        lots: [{ lot_id: "retry-lot", lot_number: "1", description: "Before edit" }],
      },
    });
    await ReportDraft.updateOne(
      { _id: draft._id },
      { $set: { previewReportId: report._id } }
    );
    const editedPreview = {
      contract_no: "DRAFT-ASSET-RETRY",
      currency: "CAD",
      lots: [
        {
          lot_id: "retry-lot",
          lot_number: "825295",
          title: "Recovered approved draft",
          description: "The exact saved approved draft edit",
          estimated_value: "CAD 250",
          image_indexes: [0],
          image_urls: ["https://assetinsight.test/uploads/asset/retry.jpg"],
        },
      ],
    };

    const blockedDraftCrRefresh = await request(app)
      .post(`/api/asset/${report._id}/preview/spec-pdf`)
      .set(authHeader(String(user._id)));
    expect(blockedDraftCrRefresh.status).toBe(409);
    expect(blockedDraftCrRefresh.body.code).toBe(
      "DRAFT_PREVIEW_NOT_PROMOTED"
    );

    const saved = await request(app)
      .put(`/api/asset/${report._id}/preview`)
      .set(authHeader(String(user._id)))
      .send({ preview_data: editedPreview });
    expect(saved.status).toBe(200);
    expect(saved.body.files_regeneration_queued).toBe(false);
    expect(dependencyMocks.queuePreviewFilesJob).not.toHaveBeenCalled();
    expect((await AssetReport.findById(report._id).lean())?.is_draft_preview).toBe(true);

    dependencyMocks.queuePreviewFilesJob
      .mockRejectedValueOnce(new Error("durable queue unavailable"))
      .mockResolvedValueOnce(undefined);

    const failed = await request(app)
      .post(`/api/report-drafts/${draft._id}/promote-preview`)
      .set(authHeader(String(user._id)))
      .send({ submit: true, preview_data: editedPreview });

    expect(failed.status).toBe(500);
    const afterFailure: any = await AssetReport.findById(report._id).lean();
    expect(afterFailure).toMatchObject({
      is_draft_preview: false,
      status: "approved",
      files_generating: false,
      files_regenerating: false,
      job_status: "error",
    });
    expect(afterFailure.preview_data.lots[0]).toMatchObject({
      lot_number: "825295",
      description: "The exact saved approved draft edit",
    });
    const consumedDraft: any = await ReportDraft.findById(draft._id).lean();
    expect(consumedDraft.promotedAt).toBeTruthy();
    expect(consumedDraft.promotionToken).toBeUndefined();

    const retried = await request(app)
      .post(`/api/report-drafts/${draft._id}/promote-preview`)
      .set(authHeader(String(user._id)))
      .send({ submit: true, preview_data: editedPreview });

    expect(retried.status).toBe(202);
    expect(dependencyMocks.queuePreviewFilesJob).toHaveBeenCalledTimes(2);
    expect(
      dependencyMocks.queuePreviewFilesJob.mock.calls[1]?.[1]
        ?.previewDataSnapshot?.lots?.[0]
    ).toMatchObject({
      lot_number: "825295",
      description: "The exact saved approved draft edit",
    });
  });

  it("does not re-list a promoted report when recovery loses its generation-state CAS", async () => {
    const user = await createAdmin();
    const revision = 6;
    const draft = await ReportDraft.create({
      user: user._id,
      type: "asset",
      clientDraftId: "promotion-recovery-cas",
      revision,
      previewStatus: "ready",
      previewProcessedRevision: revision,
    });
    const previewData = {
      contract_no: "PROMOTION-RECOVERY-CAS",
      currency: "CAD",
      lots: [{ lot_id: "cas-lot", lot_number: "6", description: "CAS recovery" }],
    };
    const report = await AssetReport.create({
      user: user._id,
      grouping_mode: "mixed",
      imageUrls: [],
      lots: previewData.lots,
      contract_no: "PROMOTION-RECOVERY-CAS",
      client_submission_id: "draft-preview:promotion-recovery-cas",
      is_draft_preview: false,
      source_draft_id: draft._id,
      source_draft_revision: revision,
      status: "approved",
      files_generating: true,
      files_regenerating: true,
      job_id: "missing-file-job",
      job_status: "queued",
      queued_at: new Date(),
      preview_submitted_at: new Date(),
      preview_data: previewData,
    });
    await ReportDraft.updateOne(
      { _id: draft._id },
      { $set: { previewReportId: report._id } }
    );
    const updateSpy = vi.spyOn(AssetReport, "updateOne").mockResolvedValueOnce({
      acknowledged: true,
      matchedCount: 0,
      modifiedCount: 0,
      upsertedCount: 0,
      upsertedId: null,
    } as any);

    try {
      const response = await request(app)
        .post(`/api/report-drafts/${draft._id}/promote-preview`)
        .set(authHeader(String(user._id)))
        .send({ submit: true, preview_data: previewData });

      expect(response.status).toBe(409);
      expect(response.body.code).toBe("DRAFT_PROMOTION_CONFLICT");
      const retained: any = await ReportDraft.findById(draft._id).lean();
      expect(String(retained.promotedReportId)).toBe(String(report._id));
      expect(retained.promotedAt).toBeTruthy();
      expect(retained.promotionToken).toBeUndefined();
      expect((await AssetReport.findById(report._id).lean())?.is_draft_preview).toBe(false);
      expect(dependencyMocks.queuePreviewFilesJob).not.toHaveBeenCalled();
    } finally {
      updateSpy.mockRestore();
    }
  });

  it("does not requeue when durable file generation completed before promotion was marked", async () => {
    const user = await createAdmin();
    const revision = 9;
    const jobId = "completed-before-promotion-marker";
    const draft = await ReportDraft.create({
      user: user._id,
      type: "asset",
      clientDraftId: "completed-before-marker",
      revision,
      previewStatus: "ready",
      previewProcessedRevision: revision,
      promotedSubmitted: true,
      promotionToken: "stale-completed-job-token",
      promotionClaimedAt: new Date(Date.now() - 3 * 60 * 1000),
    });
    const previewData = {
      contract_no: "COMPLETED-BEFORE-MARKER",
      currency: "CAD",
      lots: [{ lot_id: "completed-lot", lot_number: "9", description: "Done once" }],
    };
    const report = await AssetReport.create({
      user: user._id,
      grouping_mode: "mixed",
      imageUrls: [],
      lots: previewData.lots,
      contract_no: "COMPLETED-BEFORE-MARKER",
      client_submission_id: "draft-preview:completed-before-marker",
      is_draft_preview: false,
      source_draft_id: draft._id,
      source_draft_revision: revision,
      status: "approved",
      files_generating: false,
      files_regenerating: false,
      job_id: jobId,
      job_status: "done",
      queued_at: new Date(Date.now() - 60_000),
      preview_submitted_at: new Date(Date.now() - 60_000),
      preview_data: previewData,
    });
    await ReportDraft.updateOne(
      { _id: draft._id },
      {
        $set: {
          previewReportId: report._id,
          promotedReportId: report._id,
        },
      }
    );
    await ReportJob.create({
      type: "asset-preview-files",
      status: "completed",
      reportId: String(report._id),
      progressId: jobId,
      payload: {},
      completedAt: new Date(),
    });

    const response = await request(app)
      .post(`/api/report-drafts/${draft._id}/promote-preview`)
      .set(authHeader(String(user._id)))
      .send({ submit: true, preview_data: previewData });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      reportId: String(report._id),
      reportType: "asset",
      status: "approved",
      files_generating: false,
    });
    expect(dependencyMocks.queuePreviewFilesJob).not.toHaveBeenCalled();
    const retained: any = await ReportDraft.findById(draft._id).lean();
    expect(retained.promotedAt).toBeTruthy();
    expect(retained.promotionToken).toBeUndefined();
  });

  it("allows only one Lot Listing draft submit to claim and queue the report", async () => {
    const user = await createAdmin();
    const revision = 5;
    const draft = await ReportDraft.create({
      user: user._id,
      type: "lotListing",
      clientDraftId: "concurrent-lot-draft",
      revision,
      previewStatus: "ready",
      previewProcessedRevision: revision,
    });
    const lot = {
      lot_id: "concurrent-lot",
      lot_number: "5",
      title: "Concurrent listing lot",
      description: "Only one submission may queue this lot",
      estimated_value: "CAD 500",
      condition_report_selections: {
        condition: "N/A",
        completeness: "N/A",
        legal: "N/A",
      },
    };
    const listing = await LotListing.create({
      user: user._id,
      contract_no: "DRAFT-LISTING-CONCURRENT",
      sales_date: new Date("2026-09-01T00:00:00.000Z"),
      location: "Regina, SK",
      imageUrls: [],
      videoUrls: [],
      lots: [lot],
      client_submission_id: "draft-preview:concurrent-lot-draft",
      is_draft_preview: true,
      source_draft_id: draft._id,
      source_draft_revision: revision,
      status: "preview",
      job_status: "done",
      valuation_methods: ["FML"],
      preview_data: {
        contract_no: "DRAFT-LISTING-CONCURRENT",
        sales_date: "2026-09-01T00:00:00.000Z",
        location: "Regina, SK",
        currency: "CAD",
        valuation_methods: ["FML"],
        lots: [lot],
      },
    });
    await ReportDraft.updateOne(
      { _id: draft._id },
      { $set: { previewReportId: listing._id } }
    );

    let releaseQueue!: () => void;
    const blockedQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    dependencyMocks.regenerateLotListingFiles.mockImplementationOnce(
      () => blockedQueue
    );
    const body = {
      submit: true,
      preview_data: {
        contract_no: "DRAFT-LISTING-CONCURRENT",
        sales_date: "2026-09-01T00:00:00.000Z",
        location: "Regina, SK",
        currency: "CAD",
        valuation_methods: ["FML"],
        lots: [lot],
      },
    };

    const firstRequest = request(app)
      .post(`/api/report-drafts/${draft._id}/promote-preview`)
      .set(authHeader(String(user._id)))
      .send(body)
      .then((response) => response);
    await vi.waitFor(() => {
      expect(dependencyMocks.regenerateLotListingFiles).toHaveBeenCalledTimes(1);
    });

    const duplicate = await request(app)
      .post(`/api/report-drafts/${draft._id}/promote-preview`)
      .set(authHeader(String(user._id)))
      .send(body);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe("DRAFT_PROMOTION_IN_PROGRESS");
    expect(dependencyMocks.regenerateLotListingFiles).toHaveBeenCalledTimes(1);

    releaseQueue();
    const first = await firstRequest;
    expect(first.status).toBe(202);
    expect(dependencyMocks.regenerateLotListingFiles).toHaveBeenCalledTimes(1);
  });

  it("never exposes approved hidden draft derivatives through myreports", async () => {
    const user = await createAdmin();
    const commonAsset = {
      user: user._id,
      grouping_mode: "mixed",
      imageUrls: [],
      lots: [],
      status: "approved" as const,
      job_status: "done" as const,
      preview_data: { contract_no: "REPORT-VISIBILITY", lots: [] },
    };
    const hiddenAsset = await AssetReport.create({
      ...commonAsset,
      contract_no: "HIDDEN-ASSET",
      is_draft_preview: true,
    });
    const visibleAsset = await AssetReport.create({
      ...commonAsset,
      contract_no: "VISIBLE-ASSET",
      is_draft_preview: false,
    });
    const commonListing = {
      user: user._id,
      sales_date: new Date("2026-09-01T00:00:00.000Z"),
      location: "Regina, SK",
      imageUrls: [],
      videoUrls: [],
      lots: [],
      status: "approved" as const,
      job_status: "done" as const,
      preview_data: { contract_no: "REPORT-VISIBILITY", lots: [] },
    };
    const hiddenListing = await LotListing.create({
      ...commonListing,
      contract_no: "HIDDEN-LISTING",
      is_draft_preview: true,
    });
    const visibleListing = await LotListing.create({
      ...commonListing,
      contract_no: "VISIBLE-LISTING",
      is_draft_preview: false,
    });

    const response = await request(app)
      .get("/api/reports/myreports")
      .set(authHeader(String(user._id)));
    expect(response.status).toBe(200);
    const ids = response.body.map((item: any) => String(item._id));
    expect(ids).toContain(String(visibleAsset._id));
    expect(ids).toContain(String(visibleListing._id));
    expect(ids).not.toContain(String(hiddenAsset._id));
    expect(ids).not.toContain(String(hiddenListing._id));
  });

  it("does not expose or merge another user's hidden Asset draft derivative", async () => {
    const user = await createAdmin();
    const otherUser = await createAdmin();
    const visibleLot = {
      lot_id: "visible-merge-lot",
      lot_number: "1",
      title: "Visible merge source",
      description: "Visible source",
    };
    const hiddenLot = {
      lot_id: "hidden-merge-lot",
      lot_number: "2",
      title: "Hidden merge source",
      description: "Private draft source",
    };
    const anchor = await AssetReport.create({
      user: user._id,
      grouping_mode: "mixed",
      contract_no: "MERGE-HIDDEN-GUARD",
      contract_key: "merge-hidden-guard",
      imageUrls: [],
      lots: [visibleLot],
      preview_data: {
        contract_no: "MERGE-HIDDEN-GUARD",
        lots: [visibleLot],
      },
      status: "preview",
      job_status: "done",
    });
    const hidden = await AssetReport.create({
      user: otherUser._id,
      grouping_mode: "mixed",
      contract_no: "MERGE-HIDDEN-GUARD",
      contract_key: "merge-hidden-guard",
      imageUrls: [],
      lots: [hiddenLot],
      preview_data: {
        contract_no: "MERGE-HIDDEN-GUARD",
        lots: [hiddenLot],
      },
      is_draft_preview: true,
      status: "preview",
      job_status: "done",
    });

    const candidates = await request(app)
      .get(`/api/asset/${anchor._id}/merge-candidates`)
      .set(authHeader(String(user._id)));
    expect(candidates.status).toBe(200);
    expect(
      candidates.body.data.candidates.map((candidate: any) => String(candidate.id))
    ).not.toContain(String(hidden._id));

    const merge = await request(app)
      .post("/api/asset/merge")
      .set(authHeader(String(user._id)))
      .send({
        sourceReportIds: [String(anchor._id), String(hidden._id)],
        primaryReportId: String(anchor._id),
        mergeRequestId: "hidden-source-rejected",
      });
    expect(merge.status).toBe(404);
    expect(dependencyMocks.queuePreviewFilesJob).not.toHaveBeenCalled();
  });

  it("keeps one Lot Listing generation token across a double-click and rejects different active edits", async () => {
    const user = await createAdmin();
    const lot = {
      lot_id: "generation-claim-lot",
      lot_number: "8",
      title: "Generation claim lot",
      description: "The same snapshot must produce one durable job",
      estimated_value: "CAD 800",
      condition_report_selections: {
        condition: "N/A",
        completeness: "N/A",
        legal: "N/A",
      },
    };
    const previewData = {
      contract_no: "LOT-GENERATION-CLAIM",
      sales_date: "2026-09-01T00:00:00.000Z",
      location: "Regina, SK",
      currency: "CAD",
      watermark_images: true,
      valuation_methods: ["FML", "OLV"],
      lots: [lot],
    };
    const listing = await LotListing.create({
      user: user._id,
      contract_no: previewData.contract_no,
      sales_date: new Date(previewData.sales_date),
      location: previewData.location,
      imageUrls: [],
      videoUrls: [],
      lots: [lot],
      status: "preview",
      job_status: "done",
      valuation_methods: ["FML", "OLV"],
      preview_data: previewData,
    });

    let releaseQueue!: () => void;
    const blockedQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    dependencyMocks.regenerateLotListingFiles.mockImplementationOnce(
      () => blockedQueue
    );

    const firstRequest = request(app)
      .post(`/api/lot-listing/${listing._id}/submit-approval`)
      .set(authHeader(String(user._id)))
      .send({ preview_data: previewData })
      .then((response) => response);
    await vi.waitFor(() => {
      expect(dependencyMocks.regenerateLotListingFiles).toHaveBeenCalledTimes(1);
    });

    const claimed: any = await LotListing.findById(listing._id).lean();
    const liveToken = claimed.job_id;
    expect(liveToken).toMatch(/^ll-regenerate-/);

    const duplicate = await request(app)
      .post(`/api/lot-listing/${listing._id}/submit-approval`)
      .set(authHeader(String(user._id)))
      .send({ preview_data: previewData });
    expect(duplicate.status).toBe(202);
    expect(duplicate.body.data.job_id).toBe(liveToken);
    expect(dependencyMocks.regenerateLotListingFiles).toHaveBeenCalledTimes(1);

    const conflictingEdit = await request(app)
      .post(`/api/lot-listing/${listing._id}/resubmit`)
      .set(authHeader(String(user._id)))
      .send({
        preview_data: {
          ...previewData,
          lots: [{ ...lot, description: "A different active edit" }],
        },
      });
    expect(conflictingEdit.status).toBe(409);
    expect(conflictingEdit.body.code).toBe(
      "LOT_LISTING_GENERATION_IN_PROGRESS"
    );
    expect((await LotListing.findById(listing._id).lean())?.job_id).toBe(
      liveToken
    );
    expect(dependencyMocks.regenerateLotListingFiles).toHaveBeenCalledTimes(1);

    releaseQueue();
    expect((await firstRequest).status).toBe(202);
  });

  it("atomically claims Lot Listing generation when two submits read the same preview", async () => {
    const user = await createAdmin();
    const lot = {
      lot_id: "simultaneous-generation-claim-lot",
      lot_number: "18",
      title: "Simultaneous generation claim lot",
      description: "Both requests begin from the same persisted preview",
      estimated_value: "CAD 1,800",
      condition_report_selections: {
        condition: "N/A",
        completeness: "N/A",
        legal: "N/A",
      },
    };
    const previewData = {
      contract_no: "LOT-SIMULTANEOUS-GENERATION-CLAIM",
      sales_date: "2026-09-01T00:00:00.000Z",
      location: "Regina, SK",
      currency: "CAD",
      watermark_images: true,
      valuation_methods: ["FML"],
      lots: [lot],
    };
    const listing = await LotListing.create({
      user: user._id,
      contract_no: previewData.contract_no,
      sales_date: new Date(previewData.sales_date),
      location: previewData.location,
      imageUrls: [],
      videoUrls: [],
      lots: [lot],
      status: "preview",
      job_status: "done",
      valuation_methods: ["FML"],
      preview_data: previewData,
    });

    const originalSave = LotListing.prototype.save;
    let releaseSaveClaims!: () => void;
    let bothClaimsReached!: () => void;
    let claimCount = 0;
    const saveGate = new Promise<void>((resolve) => {
      releaseSaveClaims = resolve;
    });
    const bothClaims = new Promise<void>((resolve) => {
      bothClaimsReached = resolve;
    });
    const saveSpy = vi
      .spyOn(LotListing.prototype, "save")
      .mockImplementation(async function (...args: any[]) {
        if (
          String((this as any)._id) === String(listing._id) &&
          (this as any).status === "processing" &&
          (this as any).job_status === "queued"
        ) {
          claimCount += 1;
          if (claimCount === 2) {
            bothClaimsReached();
            releaseSaveClaims();
          }
          await saveGate;
        }
        return originalSave.apply(this, args as any);
      } as any);

    try {
      const first = request(app)
        .post(`/api/lot-listing/${listing._id}/submit-approval`)
        .set(authHeader(String(user._id)))
        .send({ preview_data: previewData })
        .then((response) => response);
      const second = request(app)
        .post(`/api/lot-listing/${listing._id}/submit-approval`)
        .set(authHeader(String(user._id)))
        .send({ preview_data: previewData })
        .then((response) => response);

      await bothClaims;
      const responses = await Promise.all([first, second]);
      expect(responses.map((response) => response.status)).toEqual([202, 202]);
      expect(dependencyMocks.regenerateLotListingFiles).toHaveBeenCalledTimes(1);

      const persisted: any = await LotListing.findById(listing._id).lean();
      expect(persisted.job_id).toMatch(/^ll-regenerate-/);
      expect(responses[0].body.data.job_id).toBe(persisted.job_id);
      expect(responses[1].body.data.job_id).toBe(persisted.job_id);
    } finally {
      releaseSaveClaims();
      saveSpy.mockRestore();
    }
  });

  it("does not let a resubmit replace the token during live Lot Listing artifact publication", async () => {
    const user = await createAdmin();
    const lot = {
      lot_id: "publication-lock-lot",
      lot_number: "28",
      title: "Publication lock lot",
      description: "Stable files are being promoted",
      estimated_value: "CAD 2,800",
      condition_report_selections: {
        condition: "N/A",
        completeness: "N/A",
        legal: "N/A",
      },
    };
    const listing = await LotListing.create({
      user: user._id,
      contract_no: "LOT-PUBLICATION-LOCK",
      sales_date: new Date("2026-09-01T00:00:00.000Z"),
      location: "Regina, SK",
      imageUrls: [],
      videoUrls: [],
      lots: [lot],
      status: "error",
      job_id: "live-publication-generation",
      job_status: "error",
      files_generating: false,
      files_regenerating: false,
      artifact_publish_token: "live-publication-lease",
      artifact_publish_generation_token: "live-publication-generation",
      artifact_publish_expires_at: new Date(Date.now() + 60_000),
      valuation_methods: ["FML"],
      preview_data: {
        contract_no: "LOT-PUBLICATION-LOCK",
        sales_date: "2026-09-01T00:00:00.000Z",
        location: "Regina, SK",
        currency: "CAD",
        valuation_methods: ["FML"],
        lots: [lot],
      },
    });

    const response = await request(app)
      .post(`/api/lot-listing/${listing._id}/resubmit`)
      .set(authHeader(String(user._id)))
      .send({
        preview_data: {
          ...(listing.preview_data as any),
          lots: [{ ...lot, title: "Must wait until publication finishes" }],
        },
      });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("LOT_LISTING_GENERATION_IN_PROGRESS");
    const persisted: any = await LotListing.findById(listing._id).lean();
    expect(persisted.job_id).toBe("live-publication-generation");
    expect(persisted.preview_data.lots[0].title).toBe("Publication lock lot");
    expect(dependencyMocks.regenerateLotListingFiles).not.toHaveBeenCalled();
  });

  it("retries a failed direct Lot Listing preview with a fresh durable identity", async () => {
    const user = await createAdmin();
    const details = {
      client_submission_id: "lot-preview-queue-failure",
      progress_id: "lot-preview-queue-failure",
      contract_no: "LOT-PREVIEW-QUEUE-FAILURE",
      sales_date: "2026-09-01T00:00:00.000Z",
      location: "Regina, SK",
      valuation_methods: ["fml", "OLV", "fml", "not-supported"],
    };
    dependencyMocks.queueLotListingJob.mockRejectedValueOnce(
      new Error("durable preview queue unavailable")
    );

    const response = await request(app)
      .post("/api/lot-listing")
      .set(authHeader(String(user._id)))
      .field("details", JSON.stringify(details))
      .attach("images", Buffer.from("first lot attempt"), {
        filename: "lot.jpg",
        contentType: "image/jpeg",
      });

    expect(response.status).toBe(500);
    const persisted: any = await LotListing.findOne({
      client_submission_id: "lot-preview-queue-failure",
    }).lean();
    expect(persisted).toMatchObject({
      status: "error",
      job_id: "lot-preview-queue-failure",
      job_status: "error",
      files_generating: false,
      files_regenerating: false,
      valuation_methods: ["FML", "OLV"],
    });
    expect(persisted.job_error).toContain("durable preview queue unavailable");

    dependencyMocks.queueLotListingJob.mockResolvedValueOnce(undefined);
    const retried = await request(app)
      .post("/api/lot-listing")
      .set(authHeader(String(user._id)))
      .field("details", JSON.stringify(details))
      .attach("images", Buffer.from("second lot attempt"), {
        filename: "lot.jpg",
        contentType: "image/jpeg",
      });

    expect(retried.status).toBe(202);
    const retryJobId = String(retried.body.jobId || "");
    expect(retryJobId).toMatch(/^ll-preview-retry-/);
    expect(retryJobId).not.toBe(details.progress_id);
    expect(retried.body).toMatchObject({
      resumed: true,
      status: "processing",
    });
    expect(dependencyMocks.queueLotListingJob).toHaveBeenCalledTimes(2);
    expect(dependencyMocks.queueLotListingJob.mock.calls[1]?.[0]).toMatchObject({
      progressId: retryJobId,
    });
    expect(await LotListing.findOne({
      client_submission_id: details.client_submission_id,
    }).lean()).toMatchObject({
      status: "processing",
      job_id: retryJobId,
      job_status: "queued",
    });
  });

  it("restores approved Lot Listing state when an edited-preview regeneration cannot be queued", async () => {
    const user = await createAdmin();
    const lot = {
      lot_id: "preview-queue-reconcile-lot",
      lot_number: "4",
      title: "Before edit",
      description: "Before edit",
      estimated_value: "CAD 400",
    };
    const previewData = {
      contract_no: "LOT-EDIT-QUEUE-FAILURE",
      sales_date: "2026-09-01T00:00:00.000Z",
      location: "Regina, SK",
      currency: "CAD",
      valuation_methods: ["FML"],
      lots: [lot],
    };
    const listing = await LotListing.create({
      user: user._id,
      contract_no: previewData.contract_no,
      sales_date: new Date(previewData.sales_date),
      location: previewData.location,
      imageUrls: [],
      videoUrls: [],
      lots: [lot],
      status: "approved",
      job_status: "done",
      preview_data: previewData,
    });
    dependencyMocks.regenerateLotListingFiles.mockRejectedValueOnce(
      new Error("durable file queue unavailable")
    );

    const response = await request(app)
      .put(`/api/lot-listing/${listing._id}/preview`)
      .set(authHeader(String(user._id)))
      .send({
        preview_data: {
          ...previewData,
          lots: [{ ...lot, title: "Saved even though queue failed" }],
        },
      });

    expect(response.status).toBe(500);
    const persisted: any = await LotListing.findById(listing._id).lean();
    expect(persisted).toMatchObject({
      status: "approved",
      job_status: "error",
      files_generating: false,
      files_regenerating: false,
    });
    expect(persisted.preview_data.lots[0].title).toBe(
      "Saved even though queue failed"
    );
  });

  it("binds a Lot Listing Smart Upload draft to its lotListing session", async () => {
    const user = await createAdmin();
    const session = await ReportUploadSession.create({
      type: "lotListing",
      user: user._id,
      jobId: "smart-lot-draft-session",
      clientSubmissionId: "smart-lot-draft-session",
      smartUpload: true,
      details: { contract_no: "SMART-LOT-DRAFT" },
      files: [],
    });

    const response = await request(app)
      .post("/api/report-drafts")
      .set(authHeader(String(user._id)))
      .send({
        clientDraftId: "smart-lot-draft",
        type: "lotListing",
        storageMode: "smart_upload",
        smartUploadSessionId: String(session._id),
        revision: 1,
        contractNo: "SMART-LOT-DRAFT",
        formData: {},
        lots: [],
      });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      type: "lotListing",
      storageMode: "smart_upload",
      smartUploadSession: String(session._id),
    });
  });

  it("coalesces an exact Asset submit retry and rejects different active edits", async () => {
    const user = await createAdmin();
    const lot = {
      lot_id: "asset-submit-retry-lot",
      lot_number: "8",
      title: "Asset submit retry",
      description: "The accepted Asset snapshot",
      estimated_value: "CAD 800",
    };
    const previewData = {
      contract_no: "ASSET-SUBMIT-RETRY",
      currency: "CAD",
      lots: [lot],
    };
    const report = await AssetReport.create({
      user: user._id,
      grouping_mode: "single_lot",
      contract_no: previewData.contract_no,
      imageUrls: [],
      lots: [lot],
      status: "preview",
      job_status: "done",
      preview_data: previewData,
    });

    let releaseQueue!: () => void;
    const blockedQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    dependencyMocks.queuePreviewFilesJob.mockImplementationOnce(
      () => blockedQueue
    );

    const firstRequest = request(app)
      .post(`/api/asset/${report._id}/submit-approval`)
      .set(authHeader(String(user._id)))
      .send({ preview_data: previewData })
      .then((response) => response);
    try {
      await vi.waitFor(() => {
        expect(dependencyMocks.queuePreviewFilesJob).toHaveBeenCalledTimes(1);
      });

      const claimed: any = await AssetReport.findById(report._id).lean();
      expect(claimed.job_id).toMatch(/^asset-files-/);
      expect(claimed.generation_progress.previewFingerprint).toMatch(
        /^[a-f0-9]{64}$/
      );

      const duplicate = await request(app)
        .post(`/api/asset/${report._id}/submit-approval`)
        .set(authHeader(String(user._id)))
        .send({
          preview_data: {
            lots: [lot],
            currency: "CAD",
            contract_no: previewData.contract_no,
          },
        });
      expect(duplicate.status).toBe(202);
      expect(duplicate.body.data.reportId).toBe(String(report._id));
      expect(dependencyMocks.queuePreviewFilesJob).toHaveBeenCalledTimes(1);

      const conflictingEdit = await request(app)
        .post(`/api/asset/${report._id}/submit-approval`)
        .set(authHeader(String(user._id)))
        .send({
          preview_data: {
            ...previewData,
            lots: [{ ...lot, description: "A different active edit" }],
          },
        });
      expect(conflictingEdit.status).toBe(409);
      expect(conflictingEdit.body.code).toBe(
        "ASSET_PREVIEW_GENERATION_IN_PROGRESS"
      );
      expect(dependencyMocks.queuePreviewFilesJob).toHaveBeenCalledTimes(1);
    } finally {
      releaseQueue();
    }
    expect((await firstRequest).status).toBe(202);
  });

  it.each(["asset", "lotListing"] as const)("rejects recovery writes for a failed %s without saved preview lots", async (kind) => {
    const user = await createAdmin();
    const Model = kind === "asset" ? AssetReport : LotListing;
    const path = kind === "asset" ? "/api/asset" : "/api/lot-listing";
    const report = await (Model as any).create({ user: user._id, grouping_mode: "single_lot", contract_no: "EMPTY-RECOVERY", sales_date: new Date(), location: "Regina, SK", status: "error", job_status: "error", lots: [], imageUrls: ["https://assetinsight.test/retained-photo.jpg"], preview_data: { lots: [] } });
    const headers = authHeader(String(user._id));
    for (const action of ["preview", "resubmit"]) {
      const req = action === "preview" ? request(app).put(`${path}/${report._id}/${action}`) : request(app).post(`${path}/${report._id}/${action}`);
      expect((await req.set(headers).send({ preview_data: { lots: [{ lot_number: "1", title: "Invented recovery" }] } })).status).toBe(400);
    }
    expect(dependencyMocks.queuePreviewFilesJob).not.toHaveBeenCalled();
    expect(dependencyMocks.regenerateLotListingFiles).not.toHaveBeenCalled();
    expect((await (Model as any).findById(report._id).lean()).imageUrls).toHaveLength(1);
  });

  it.each(["asset", "lotListing"] as const)("opens, saves and resubmits a failed %s on the same report without losing media", async (kind) => {
    const user = await createAdmin();
    const other = await createAdmin();
    const imageUrls = Array.from({ length: 419 }, (_, i) => `https://assetinsight.test/recovery/photo-${i}.jpg`);
    const lots = Array.from({ length: 8 }, (_, i) => ({
      lot_id: `saved-${i}`, lot_number: String(5507 + i), title: `Saved lot ${i}`,
      description: `Saved details ${i}`, estimated_value: "CAD 100",
      image_indexes: Array.from({ length: i === 7 ? 55 : 52 }, (_, j) => i * 52 + j),
      condition_report_selections: { condition: "N/A", completeness: "N/A", legal: "N/A" },
    }));
    const Model = kind === "asset" ? AssetReport : LotListing;
    const path = kind === "asset" ? "/api/asset" : "/api/lot-listing";
    const report = await (Model as any).create({
      user: user._id, grouping_mode: "single_lot", contract_no: "93530",
      sales_date: new Date(), location: "Regina, SK", currency: "CAD", imageUrls, lots,
      latitude: 50.45, longitude: -104.61, videoUrls: ["https://assetinsight.test/recovery/video.mp4"],
      status: "error", job_status: "error", files_generating: false, files_regenerating: false,
      job_error: "No active processing job or complete source upload was found. Reopen the saved draft and retry.",
      // Characterize both canonical Asset data and the legacy Lot root fallback.
      ...(kind === "asset" ? { preview_data: { lots, contract_no: "93530", currency: "CAD" } } : {}),
    });
    const url = `${path}/${report._id}`;
    expect((await request(app).get(`${url}/preview`).set(authHeader(String(other._id)))).status).toBe(404);
    const opened = await request(app).get(`${url}/preview`).set(authHeader(String(user._id)));
    expect(opened.status).toBe(200);
    expect(opened.body.data).toMatchObject({ status: "error", preview_available: true, downloadable: false });
    expect(opened.body.data.imageUrls).toEqual(imageUrls);
    expect(opened.body.data.preview_data.lots).toHaveLength(8);
    if (kind === "lotListing") {
      expect(opened.body.data.preview_data).toMatchObject({ latitude: 50.45, longitude: -104.61, videoUrls: ["https://assetinsight.test/recovery/video.mp4"] });
    }
    const edited = opened.body.data.preview_data;
    edited.lots[0].lot_number = "CUSTOM-5507";
    const fullDescription = "Websites for reference: https://www.freightfarms.com/\n\nOwner edited greenhouse details and a complete equipment inventory.\nIncludes racks, lighting, irrigation and climate controls.";
    edited.lots[0].description = fullDescription;
    const saved = await request(app).put(`${url}/preview`).set(authHeader(String(user._id))).send({ preview_data: edited });
    expect(saved.status).toBe(200);
    const persisted = await (Model as any).findById(report._id).lean();
    expect(persisted.status).toBe("error");
    expect(persisted.imageUrls).toEqual(imageUrls);
    expect(persisted.preview_data.lots[0]).toMatchObject({ lot_number: "CUSTOM-5507", description: fullDescription });
    expect(dependencyMocks.queuePreviewFilesJob).not.toHaveBeenCalled();
    expect(dependencyMocks.regenerateLotListingFiles).not.toHaveBeenCalled();
    const payload = { preview_data: persisted.preview_data };
    const submitted = await request(app).post(`${url}/resubmit`).set(authHeader(String(user._id))).send(payload);
    expect(submitted.status).toBe(202);
    const repeated = await request(app).post(`${url}/resubmit`).set(authHeader(String(user._id))).send(payload);
    expect(repeated.status).toBe(202);
    expect(kind === "asset" ? dependencyMocks.queuePreviewFilesJob : dependencyMocks.regenerateLotListingFiles).toHaveBeenCalledTimes(1);
    const queueOptions = kind === "asset"
      ? dependencyMocks.queuePreviewFilesJob.mock.calls[0][1]
      : dependencyMocks.regenerateLotListingFiles.mock.calls[0][0];
    expect(queueOptions.previewDataSnapshot.lots[0].description).toBe(fullDescription);
    expect(await (Model as any).countDocuments({ contract_no: "93530" })).toBe(1);
    expect((await (Model as any).findById(report._id).lean()).imageUrls).toEqual(imageUrls);
    expect((await request(app).put(`${url}/preview`).set(authHeader(String(user._id))).send(payload)).status).toBe(400);
  });

  it("coalesces an exact Asset resubmit retry and rejects different active edits", async () => {
    const user = await createAdmin();
    const lot = {
      lot_id: "asset-resubmit-retry-lot",
      lot_number: "19",
      title: "Asset resubmit retry",
      description: "The accepted approved Asset snapshot",
      estimated_value: "CAD 1,900",
    };
    const previewData = {
      contract_no: "ASSET-RESUBMIT-RETRY",
      currency: "CAD",
      lots: [lot],
    };
    const report = await AssetReport.create({
      user: user._id,
      grouping_mode: "single_lot",
      contract_no: previewData.contract_no,
      imageUrls: [],
      lots: [lot],
      status: "approved",
      job_status: "done",
      preview_submitted_at: new Date(),
      preview_data: previewData,
    });

    let releaseQueue!: () => void;
    const blockedQueue = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    dependencyMocks.queuePreviewFilesJob.mockImplementationOnce(
      () => blockedQueue
    );

    const firstRequest = request(app)
      .post(`/api/asset/${report._id}/resubmit`)
      .set(authHeader(String(user._id)))
      .send({ preview_data: previewData })
      .then((response) => response);
    try {
      await vi.waitFor(() => {
        expect(dependencyMocks.queuePreviewFilesJob).toHaveBeenCalledTimes(1);
      });

      const claimed: any = await AssetReport.findById(report._id).lean();
      expect(claimed.job_id).toMatch(/^asset-files-/);
      expect(claimed.files_regenerating).toBe(true);

      const duplicate = await request(app)
        .post(`/api/asset/${report._id}/resubmit`)
        .set(authHeader(String(user._id)))
        .send({ preview_data: previewData });
      expect(duplicate.status).toBe(202);
      expect(duplicate.body.data.reportId).toBe(String(report._id));
      expect(dependencyMocks.queuePreviewFilesJob).toHaveBeenCalledTimes(1);

      const conflictingEdit = await request(app)
        .post(`/api/asset/${report._id}/resubmit`)
        .set(authHeader(String(user._id)))
        .send({
          preview_data: {
            ...previewData,
            lots: [{ ...lot, description: "A different resubmit edit" }],
          },
        });
      expect(conflictingEdit.status).toBe(409);
      expect(conflictingEdit.body.code).toBe(
        "ASSET_PREVIEW_GENERATION_IN_PROGRESS"
      );
      expect(dependencyMocks.queuePreviewFilesJob).toHaveBeenCalledTimes(1);
    } finally {
      releaseQueue();
    }
    expect((await firstRequest).status).toBe(202);
  });

  it("atomically coalesces two Asset submits that read the same preview", async () => {
    const user = await createAdmin();
    const lot = {
      lot_id: "asset-simultaneous-submit-lot",
      lot_number: "28",
      title: "Simultaneous Asset submit",
      description: "Both requests begin from this snapshot",
      estimated_value: "CAD 2,800",
    };
    const previewData = {
      contract_no: "ASSET-SIMULTANEOUS-SUBMIT",
      currency: "CAD",
      lots: [lot],
    };
    const report = await AssetReport.create({
      user: user._id,
      grouping_mode: "single_lot",
      contract_no: previewData.contract_no,
      imageUrls: [],
      lots: [lot],
      status: "preview",
      job_status: "done",
      preview_data: previewData,
    });

    const originalSave = AssetReport.prototype.save;
    let releaseSaveClaims!: () => void;
    let claimCount = 0;
    const saveGate = new Promise<void>((resolve) => {
      releaseSaveClaims = resolve;
    });
    const saveSpy = vi
      .spyOn(AssetReport.prototype, "save")
      .mockImplementation(async function (...args: any[]) {
        if (
          String((this as any)._id) === String(report._id) &&
          (this as any).job_status === "queued" &&
          (this as any).files_generating === true
        ) {
          claimCount += 1;
          await saveGate;
        }
        return originalSave.apply(this, args as any);
      } as any);

    try {
      const first = request(app)
        .post(`/api/asset/${report._id}/submit-approval`)
        .set(authHeader(String(user._id)))
        .send({ preview_data: previewData })
        .then((response) => response);
      const second = request(app)
        .post(`/api/asset/${report._id}/submit-approval`)
        .set(authHeader(String(user._id)))
        .send({ preview_data: previewData })
        .then((response) => response);

      await vi.waitFor(() => expect(claimCount).toBe(2), {
        timeout: 5_000,
        interval: 25,
      });
      releaseSaveClaims();
      const responses = await Promise.all([first, second]);
      expect(responses.map((response) => response.status)).toEqual([202, 202]);
      expect(dependencyMocks.queuePreviewFilesJob).toHaveBeenCalledTimes(1);
      const stored: any = await AssetReport.findById(report._id).lean();
      expect(stored.job_id).toMatch(/^asset-files-/);
      expect(responses[0].body.data.reportId).toBe(String(report._id));
      expect(responses[1].body.data.reportId).toBe(String(report._id));
    } finally {
      releaseSaveClaims();
      saveSpy.mockRestore();
    }
  });

  it("resolves a concurrent direct Asset client_submission_id insert to one report", async () => {
    // dropDatabase() removes indexes between integration cases; recreate the
    // production idempotency constraint for this race regression.
    await Promise.all([
      AssetReport.syncIndexes(),
      ReportSubmissionAdmission.syncIndexes(),
    ]);
    const user = await createAdmin();
    const clientSubmissionId = "asset-direct-concurrent-idempotency";

    const makeRequest = (content: string) =>
      request(app)
        .post("/api/asset")
        .set(authHeader(String(user._id)))
        .field(
          "details",
          JSON.stringify({
            client_submission_id: clientSubmissionId,
            progress_id: clientSubmissionId,
            contract_no: "ASSET-DIRECT-CONCURRENT",
            grouping_mode: "single_lot",
          })
        )
        .attach("images", Buffer.from(content), {
          filename: `${content}.jpg`,
          contentType: "image/jpeg",
        })
        .then((response) => response);

    const responses = await Promise.all([
      makeRequest("first-request"),
      makeRequest("second-request"),
    ]);

    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    expect(String(responses[0].body.reportId)).toBe(
      String(responses[1].body.reportId)
    );
    expect(await AssetReport.countDocuments({
      user: user._id,
      client_submission_id: clientSubmissionId,
    })).toBe(1);
    // The second request verifies the same embedded outbox. The production
    // queue's immutable idempotency key still materializes only one job.
    expect(dependencyMocks.queueAssetPreviewJob).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: "Asset",
      type: "asset" as const,
      directPath: "/api/asset",
      uploadPath: "/api/asset/upload-session",
    },
    {
      label: "Lot Listing",
      type: "lotListing" as const,
      directPath: "/api/lot-listing",
      uploadPath: "/api/lot-listing/upload-session",
    },
  ])(
    "allows separate cross-transport $label submissions for the same contract",
    async ({ type, directPath, uploadPath }) => {
      await Promise.all([
        AssetReport.syncIndexes(),
        LotListing.syncIndexes(),
        ReportUploadSession.syncIndexes(),
        ReportSubmissionAdmission.syncIndexes(),
      ]);
      const user = await createAdmin();
      const contractNo = `${type}-CROSS-TRANSPORT-100`;
      const directId = `${type}-direct-cross-transport`;
      const sessionId = `${type}-session-cross-transport`;
      const uploadBody = uploadSessionRequestBody({
        type,
        clientSubmissionId: sessionId,
        coordinates: {},
      });
      uploadBody.details.contract_no = contractNo;

      const directDetails = type === "asset"
        ? {
            client_submission_id: directId,
            progress_id: directId,
            contract_no: contractNo,
            grouping_mode: "single_lot",
          }
        : {
            client_submission_id: directId,
            progress_id: directId,
            contract_no: contractNo,
            sales_date: "2026-09-01T00:00:00.000Z",
            location: "Regina, SK",
            valuation_methods: ["FML"],
          };
      const directRequest = request(app)
        .post(directPath)
        .set(authHeader(String(user._id)))
        .field("details", JSON.stringify(directDetails))
        .attach("images", Buffer.from("cross-transport"), {
          filename: "cross-transport.jpg",
          contentType: "image/jpeg",
        });
      const sessionRequest = request(app)
        .post(uploadPath)
        .set(authHeader(String(user._id)))
        .send(uploadBody);

      const responses = await Promise.all([directRequest, sessionRequest]);
      expect(responses.map(({ status }) => status).sort()).toEqual([201, 202]);
      const Model = type === "asset" ? AssetReport : LotListing;
      expect(
        await Model.countDocuments({
          user: user._id,
          contract_key: contractNo.toLowerCase(),
        }),
      ).toBe(1);
      expect(
        await ReportUploadSession.countDocuments({
          user: user._id,
          clientSubmissionId: sessionId,
        }),
      ).toBe(1);
      expect(
        await ReportUploadSession.countDocuments({
          user: user._id,
          activeContractClaim: { $exists: true },
        }),
      ).toBe(0);
    },
  );

  it.each([
    {
      label: "Asset",
      type: "asset" as const,
      path: "/api/asset",
      jobId: "asset-session-queue-retry",
    },
    {
      label: "Lot Listing",
      type: "lotListing" as const,
      path: "/api/lot-listing",
      jobId: "lot-session-queue-retry",
    },
  ])(
    "keeps verified $label upload-session files retryable after enqueue failure",
    async ({ type, path, jobId }) => {
      const user = await createAdmin();
      const session = await ReportUploadSession.create({
        type,
        status: "uploading",
        user: user._id,
        jobId,
        clientSubmissionId: jobId,
        details:
          type === "asset"
            ? {
                contract_no: `${jobId}-contract`,
                grouping_mode: "single_lot",
              }
            : {
                contract_no: `${jobId}-contract`,
                sales_date: "2026-09-01T00:00:00.000Z",
                location: "Regina, SK",
                valuation_methods: ["FML"],
              },
        r2Bucket: "report-conflict-test",
        r2PublicBaseUrl: "https://assetinsight.test",
        expectedFileCount: 1,
        expectedImageCount: 1,
        expectedVideoCount: 0,
        files: [
          {
            fileId: "images-0",
            key: `report-sessions/${jobId}/inspection.jpg`,
            fieldname: "images",
            originalname: "inspection.jpg",
            mimetype: "image/jpeg",
            size: 2_048,
            imageIndex: 0,
            originalOrder: 0,
            role: "main",
          },
        ],
      });
      const queueMock =
        type === "asset"
          ? dependencyMocks.queueAssetPreviewJob
          : dependencyMocks.queueLotListingJob;
      queueMock
        .mockRejectedValueOnce(new Error(`${type} durable queue unavailable`))
        .mockResolvedValueOnce(undefined);

      const failed = await request(app)
        .post(`${path}/upload-session/${session._id}/complete`)
        .set(authHeader(String(user._id)));
      expect(failed.status).toBe(500);

      const retryableSession: any = await ReportUploadSession.findById(
        session._id
      ).lean();
      expect(retryableSession).toMatchObject({
        status: "completed",
        jobId,
      });
      expect(retryableSession.lastError).toContain("durable queue unavailable");
      expect(retryableSession.files).toHaveLength(1);

      const ReportModel = type === "asset" ? AssetReport : LotListing;
      const failedReport: any = await ReportModel.findById(
        retryableSession.reportId
      ).lean();
      expect(failedReport).toMatchObject({
        status: "error",
        job_id: jobId,
        job_status: "error",
        files_generating: false,
        files_regenerating: false,
      });

      const retried = await request(app)
        .post(`${path}/upload-session/${session._id}/complete`)
        .set(authHeader(String(user._id)));
      expect(retried.status).toBe(202);
      expect(retried.body).toMatchObject({
        jobId,
        reportId: String(retryableSession.reportId),
        status: "processing",
      });
      expect(queueMock).toHaveBeenCalledTimes(2);
      const queuedSession: any = await ReportUploadSession.findById(
        session._id
      ).lean();
      expect(queuedSession).toMatchObject({ status: "queued" });
      expect(queuedSession.lastError).toBeUndefined();
      expect(await ReportModel.findById(retryableSession.reportId).lean()).toMatchObject({
        status: "processing",
        job_id: jobId,
        job_status: "queued",
      });
    }
  );

  it("accepts an upload-session completion when enqueue threw after creating its exact job", async () => {
    const user = await createAdmin();
    const jobId = "asset-session-ambiguous-acceptance";
    const session = await ReportUploadSession.create({
      type: "asset",
      status: "uploading",
      user: user._id,
      jobId,
      clientSubmissionId: jobId,
      details: {
        contract_no: "ASSET-SESSION-AMBIGUOUS",
        grouping_mode: "single_lot",
      },
      r2Bucket: "report-conflict-test",
      r2PublicBaseUrl: "https://assetinsight.test",
      expectedFileCount: 1,
      expectedImageCount: 1,
      expectedVideoCount: 0,
      files: [
        {
          fileId: "images-0",
          key: `report-sessions/${jobId}/inspection.jpg`,
          fieldname: "images",
          originalname: "inspection.jpg",
          mimetype: "image/jpeg",
          size: 2_048,
          imageIndex: 0,
          originalOrder: 0,
          role: "main",
        },
      ],
    });
    dependencyMocks.queueAssetPreviewJob.mockImplementationOnce(
      async (input: any) => {
        await ReportJob.create({
          type: "asset-preview",
          reportId: String(input.reportId),
          progressId: jobId,
          status: "queued",
          payload: { reportId: String(input.reportId) },
        });
        throw new Error("connection dropped after durable acceptance");
      }
    );

    const response = await request(app)
      .post(`/api/asset/upload-session/${session._id}/complete`)
      .set(authHeader(String(user._id)));

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      jobId,
      status: "processing",
      phase: "processing",
    });
    const queuedSession: any = await ReportUploadSession.findById(
      session._id
    ).lean();
    expect(queuedSession).toMatchObject({ status: "queued" });
    expect(queuedSession.lastError).toBeUndefined();
    expect(await AssetReport.findById(response.body.reportId).lean()).toMatchObject({
      status: "processing",
      job_id: jobId,
      job_status: "queued",
    });
  });
});
