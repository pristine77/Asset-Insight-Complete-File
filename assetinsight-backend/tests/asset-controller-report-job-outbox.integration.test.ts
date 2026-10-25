import { access } from "node:fs/promises";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
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
import ReportJob from "../src/models/reportJob.model.js";
import User from "../src/models/user.model.js";
import { buildAssetPreviewFilesJobOutbox } from "../src/jobs/assetReportJob.js";
import { buildDefaultAssetAdminScheduleSheet } from "../src/service/assetAdminScheduleSheetService.js";
import { ensureReportJobOutbox } from "../src/utils/reportJobMongoQueue.js";
import { cleanupReportJobSourceFiles } from "../src/utils/reportTempFiles.js";
import { assetPreviewFingerprint } from "../src/utils/assetGenerationIdentity.js";

const jobMocks = vi.hoisted(() => ({
  queueAssetPreviewJob: vi.fn(),
  queuePreviewFilesJob: vi.fn(),
  uploadBufferToR2: vi.fn(),
}));

vi.mock("../src/jobs/assetReportJob.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/jobs/assetReportJob.js")
  >();
  return {
    ...actual,
    queueAssetPreviewJob: jobMocks.queueAssetPreviewJob,
    queuePreviewFilesJob: jobMocks.queuePreviewFilesJob,
  };
});

vi.mock("../src/utils/r2Storage/r2Upload.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/utils/r2Storage/r2Upload.js")
  >();
  return {
    ...actual,
    uploadBufferToR2: jobMocks.uploadBufferToR2,
  };
});

let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
const previousEnvironment = {
  DEVICE_APPROVAL_ENFORCEMENT: process.env.DEVICE_APPROVAL_ENFORCEMENT,
  REPORT_QUEUE_BACKEND: process.env.REPORT_QUEUE_BACKEND,
};

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function authHeader(userId: string) {
  return {
    Authorization: `Bearer ${jwt.sign(
      { id: userId, role: "user" },
      process.env.JWT_SECRET!,
      { expiresIn: "30m" }
    )}`,
  };
}

async function createUser(label: string) {
  const suffix = new mongoose.Types.ObjectId().toHexString();
  return User.create({
    email: `${label}-${suffix}@example.test`,
    username: `${label}-${suffix}`,
    password: "Password123!",
    authProvider: "email",
    isVerified: true,
    role: "user",
  });
}

function previewData(title: string) {
  return {
    contract_no: "ASSET-OUTBOX-100",
    currency: "CAD",
    lots: [
      {
        lot_id: "lot-001",
        lot_number: "1",
        title,
        description: `${title} description`,
        image_urls: [],
      },
    ],
  };
}

function withStoredProposalValuationSheet(data: ReturnType<typeof previewData>) {
  return {
    ...data,
    admin_schedule_sheet: buildDefaultAssetAdminScheduleSheet({
      lots: data.lots,
      preview_data: data,
    } as any),
  };
}

beforeAll(async () => {
  process.env.DEVICE_APPROVAL_ENFORCEMENT = "off";
  process.env.REPORT_QUEUE_BACKEND = "mongo";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await Promise.all([
    AssetReport.syncIndexes(),
    ReportJob.syncIndexes(),
    User.syncIndexes(),
  ]);
  jobMocks.queueAssetPreviewJob.mockReset();
  jobMocks.queuePreviewFilesJob.mockReset();
  jobMocks.uploadBufferToR2.mockReset();
  jobMocks.queueAssetPreviewJob.mockRejectedValue(
    new Error("simulated lost initial queue acknowledgement")
  );
  jobMocks.queuePreviewFilesJob.mockRejectedValue(
    new Error("simulated lost files queue acknowledgement")
  );
  jobMocks.uploadBufferToR2.mockImplementation(
    async (_buffer, _type, _bucket, key) =>
      `https://assetinsight.test/${String(key)}`
  );
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  restoreEnvironment(
    "DEVICE_APPROVAL_ENFORCEMENT",
    previousEnvironment.DEVICE_APPROVAL_ENFORCEMENT
  );
  restoreEnvironment(
    "REPORT_QUEUE_BACKEND",
    previousEnvironment.REPORT_QUEUE_BACKEND
  );
});

describe.sequential("Asset controller durable report-job handoff", () => {
  it("keeps uploaded sources in the embedded outbox until restart reconciliation", async () => {
    const user = await createUser("initial-asset-outbox");
    const clientSubmissionId = "asset-outbox-initial-1";
    const response = await request(app)
      .post("/api/asset")
      .set(authHeader(String(user._id)))
      .field(
        "details",
        JSON.stringify({
          client_submission_id: clientSubmissionId,
          progress_id: clientSubmissionId,
          contract_no: "ASSET-OUTBOX-INITIAL",
          grouping_mode: "single_lot",
        })
      )
      .attach("images", Buffer.from("queued image bytes"), {
        filename: "inspection.jpg",
        contentType: "image/jpeg",
      });

    expect(response.status).toBe(202);
    const report: any = await AssetReport.findOne({
      user: user._id,
      client_submission_id: clientSubmissionId,
    })
      .select("+report_job_outbox")
      .lean();
    expect(report).toMatchObject({
      job_status: "queued",
      report_job_outbox: {
        type: "asset-preview",
        reportId: String(report._id),
        progressId: clientSubmissionId,
        payload: {
          reportId: String(report._id),
          progressId: clientSubmissionId,
          images: [expect.objectContaining({ originalname: "inspection.jpg" })],
        },
      },
    });
    expect(await ReportJob.countDocuments()).toBe(0);
    const sourcePath = report.report_job_outbox.payload.images[0].path;
    await expect(access(sourcePath)).resolves.toBeUndefined();

    const recovered = await ensureReportJobOutbox(
      "asset",
      String(report._id),
      report.report_job_outbox.token
    );
    expect(recovered).toMatchObject({
      type: "asset-preview",
      reportId: String(report._id),
      progressId: clientSubmissionId,
    });
    expect(
      await AssetReport.findById(report._id)
        .select("+report_job_outbox")
        .lean()
    ).not.toHaveProperty("report_job_outbox");
    await cleanupReportJobSourceFiles(
      report.report_job_outbox.payload.images
    );
  });

  it("persists a failed direct submission retry before redispatching its sources", async () => {
    const user = await createUser("retry-asset-outbox");
    const clientSubmissionId = "asset-outbox-retry-1";
    const report = await AssetReport.create({
      user: user._id,
      client_submission_id: clientSubmissionId,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      contract_no: "ASSET-OUTBOX-RETRY",
      status: "error",
      job_id: clientSubmissionId,
      job_status: "error",
      job_error: "previous worker failed",
    });

    const response = await request(app)
      .post("/api/asset")
      .set(authHeader(String(user._id)))
      .field(
        "details",
        JSON.stringify({
          client_submission_id: clientSubmissionId,
          progress_id: clientSubmissionId,
          contract_no: "ASSET-OUTBOX-RETRY",
          grouping_mode: "single_lot",
        })
      )
      .attach("images", Buffer.from("retry image bytes"), {
        filename: "retry.jpg",
        contentType: "image/jpeg",
      });

    expect(response.status).toBe(202);
    const persisted: any = await AssetReport.findById(report._id)
      .select("+report_job_outbox")
      .lean();
    expect(persisted.job_id).toMatch(/^asset-preview-retry-/);
    expect(persisted.job_id).not.toBe(clientSubmissionId);
    expect(persisted).toMatchObject({
      status: "processing",
      job_status: "queued",
      report_job_outbox: {
        type: "asset-preview",
        reportId: String(report._id),
        progressId: persisted.job_id,
        payload: {
          progressId: persisted.job_id,
          submissionAttemptId: persisted.job_id,
          details: {
            client_submission_id: clientSubmissionId,
            contract_no: "ASSET-OUTBOX-RETRY",
          },
          images: [expect.objectContaining({ originalname: "retry.jpg" })],
        },
      },
    });
    const sourcePath = persisted.report_job_outbox.payload.images[0].path;
    await expect(access(sourcePath)).resolves.toBeUndefined();
    expect(await ReportJob.countDocuments()).toBe(0);

    await expect(
      ensureReportJobOutbox(
        "asset",
        String(report._id),
        persisted.report_job_outbox.token
      )
    ).resolves.toMatchObject({ type: "asset-preview" });
    await cleanupReportJobSourceFiles(
      persisted.report_job_outbox.payload.images
    );
  });

  it("atomically retains the edited preview snapshot when file dispatch is ambiguous", async () => {
    const user = await createUser("asset-preview-outbox");
    const original = previewData("Before edit");
    const report = await AssetReport.create({
      user: user._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      contract_no: "ASSET-OUTBOX-100",
      status: "approved",
      job_status: "done",
      proposal_valuation_revision: 4,
      preview_data: withStoredProposalValuationSheet(original),
      preview_files: {
        docx: "https://files.example/previous.docx",
        excel: "https://files.example/previous.xlsx",
        images: "https://files.example/previous.zip",
      },
    });

    const edited = previewData("After edit");
    const response = await request(app)
      .put(`/api/asset/${report._id}/preview`)
      .set(authHeader(String(user._id)))
      .send({ preview_data: edited });

    expect(response.status).toBe(200);
    const persisted: any = await AssetReport.findById(report._id)
      .select("+report_job_outbox")
      .lean();
    expect(persisted).toMatchObject({
      job_status: "queued",
      files_generating: true,
      files_regenerating: true,
      proposal_valuation_revision: 5,
      preview_data: { lots: [expect.objectContaining({ title: "After edit" })] },
      report_job_outbox: {
        type: "asset-preview-files",
        reportId: String(report._id),
        payload: {
          reportId: String(report._id),
          previewDataSnapshot: {
            lots: [expect.objectContaining({ title: "After edit" })],
          },
        },
      },
    });
    expect(persisted.preview_data.admin_schedule_sheet.rows[0].cr_details).toBe(
      "After edit description"
    );
    expect(assetPreviewFingerprint(persisted.preview_data)).toBe(
      assetPreviewFingerprint(
        persisted.report_job_outbox.payload.previewDataSnapshot
      )
    );
    expect(await ReportJob.countDocuments()).toBe(0);

    await expect(
      ensureReportJobOutbox(
        "asset",
        String(report._id),
        persisted.report_job_outbox.token
      )
    ).resolves.toMatchObject({ type: "asset-preview-files" });
  });

  it("atomically retains a preview image edit and its exact regeneration snapshot", async () => {
    const user = await createUser("asset-preview-image-outbox");
    const initialPreview = {
      ...previewData("Image edit"),
      watermark_images: false,
    };
    const report = await AssetReport.create({
      user: user._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: initialPreview.lots,
      contract_no: "ASSET-OUTBOX-IMAGE",
      status: "approved",
      job_status: "done",
      watermark_images: false,
      preview_data: initialPreview,
      preview_files: {
        docx: "https://files.example/previous.docx",
        excel: "https://files.example/previous.xlsx",
        images: "https://files.example/previous.zip",
      },
    });

    const response = await request(app)
      .post(`/api/asset/${report._id}/preview/lots/lot-001/images`)
      .set(authHeader(String(user._id)))
      .field("preview_data", JSON.stringify(initialPreview))
      .attach(
        "images",
        Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        { filename: "added.jpg", contentType: "image/jpeg" }
      );

    expect(response.status).toBe(200);
    const persisted: any = await AssetReport.findById(report._id)
      .select("+report_job_outbox")
      .lean();
    const addedUrl = persisted.imageUrls[0];
    expect(addedUrl).toMatch(
      /^https:\/\/assetinsight\.test\/uploads\/asset\/preview-additions\//
    );
    expect(persisted).toMatchObject({
      job_status: "queued",
      files_generating: true,
      files_regenerating: true,
      preview_data: {
        lots: [
          expect.objectContaining({
            lot_id: "lot-001",
            extra_image_urls: [addedUrl],
          }),
        ],
      },
      report_job_outbox: {
        type: "asset-preview-files",
        payload: {
          previewDataSnapshot: {
            lots: [
              expect.objectContaining({
                lot_id: "lot-001",
                extra_image_urls: [addedUrl],
              }),
            ],
          },
        },
      },
    });
    expect(await ReportJob.countDocuments()).toBe(0);

    await expect(
      ensureReportJobOutbox(
        "asset",
        String(report._id),
        persisted.report_job_outbox.token
      )
    ).resolves.toMatchObject({ type: "asset-preview-files" });
  });

  it.each([
    {
      label: "submission",
      status: "preview" as const,
      path: "submit-approval",
    },
    {
      label: "resubmission",
      status: "approved" as const,
      path: "resubmit",
    },
  ])(
    "persists an exact owner $label file-generation handoff before dispatch",
    async ({ label, status, path }) => {
      const user = await createUser(`asset-owner-${label}-outbox`);
      const original = previewData(`Owner ${label} before`);
      const report = await AssetReport.create({
        user: user._id,
        grouping_mode: "single_lot",
        imageUrls: [],
        lots: original.lots,
        contract_no: `ASSET-OUTBOX-${label.toUpperCase()}`,
        status,
        job_status: "done",
        proposal_valuation_revision: 8,
        preview_data: withStoredProposalValuationSheet(original),
        ...(status === "approved"
          ? {
              preview_submitted_at: new Date(),
              preview_files: {
                docx: "https://files.example/previous.docx",
                excel: "https://files.example/previous.xlsx",
                images: "https://files.example/previous.zip",
              },
            }
          : {}),
      });
      const edited = previewData(`Owner ${label} after`);

      const response = await request(app)
        .post(`/api/asset/${report._id}/${path}`)
        .set(authHeader(String(user._id)))
        .send({ preview_data: edited });

      expect(response.status).toBe(202);
      const persisted: any = await AssetReport.findById(report._id)
        .select("+report_job_outbox")
        .lean();
      expect(persisted).toMatchObject({
        job_status: "queued",
        files_generating: true,
        generation_target_status: "approved",
        proposal_valuation_revision: 9,
        preview_data: {
          lots: [
            expect.objectContaining({ title: `Owner ${label} after` }),
          ],
        },
        report_job_outbox: {
          type: "asset-preview-files",
          reportId: String(report._id),
          progressId: persisted.job_id,
          targetStatus: "approved",
          payload: {
            generationToken: persisted.job_id,
            targetStatus: "approved",
            previewDataSnapshot: {
              lots: [
                expect.objectContaining({ title: `Owner ${label} after` }),
              ],
            },
          },
        },
      });
      expect(
        persisted.preview_data.admin_schedule_sheet.rows[0].cr_details
      ).toBe(`Owner ${label} after description`);
      expect(assetPreviewFingerprint(persisted.preview_data)).toBe(
        assetPreviewFingerprint(
          persisted.report_job_outbox.payload.previewDataSnapshot
        )
      );
      expect(await ReportJob.countDocuments()).toBe(0);

      await expect(
        ensureReportJobOutbox(
          "asset",
          String(report._id),
          persisted.report_job_outbox.token
        )
      ).resolves.toMatchObject({ type: "asset-preview-files" });
    }
  );

  it("repairs a missing durable file handoff when an active Asset request is retried", async () => {
    const user = await createUser("asset-active-handoff-recovery");
    const generationToken = "asset-files-recover-exact-request";
    const snapshot = previewData("Recover exact snapshot");
    const report = await AssetReport.create({
      user: user._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: snapshot.lots,
      contract_no: "ASSET-OUTBOX-RECOVERY",
      status: "approved",
      job_id: generationToken,
      job_status: "queued",
      files_generating: false,
      files_regenerating: false,
      generation_target_status: "approved",
      generation_progress: {
        stage: "generating_files",
        previewFingerprint: assetPreviewFingerprint(snapshot),
      },
      preview_data: snapshot,
      preview_submitted_at: new Date(),
    });
    jobMocks.queuePreviewFilesJob.mockImplementation(
      async (reportId: string, options: any) =>
        ensureReportJobOutbox(
          "asset",
          reportId,
          String(options?.reportJobOutboxToken || "")
        )
    );

    const response = await request(app)
      .post(`/api/asset/${report._id}/resubmit`)
      .set(authHeader(String(user._id)))
      .send({});

    expect(response.status).toBe(202);
    expect(jobMocks.queuePreviewFilesJob).toHaveBeenCalledWith(
      String(report._id),
      expect.objectContaining({
        generationToken,
        targetStatus: "approved",
        reportJobOutboxToken: expect.any(String),
        previewDataSnapshot: snapshot,
      })
    );
    await expect(
      ReportJob.findOne({
        type: "asset-preview-files",
        reportId: String(report._id),
        progressId: generationToken,
      }).lean()
    ).resolves.toMatchObject({
      payload: {
        reportId: String(report._id),
        generationToken,
        targetStatus: "approved",
        previewDataSnapshot: snapshot,
      },
    });
    await expect(
      AssetReport.findById(report._id).select("+report_job_outbox").lean()
    ).resolves.not.toHaveProperty("report_job_outbox");
  });

  it("refuses to guess a missing workflow target while recovering an active Asset", async () => {
    const user = await createUser("asset-recovery-missing-target");
    const snapshot = previewData("Missing generation target");
    const report = await AssetReport.create({
      user: user._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: snapshot.lots,
      contract_no: "ASSET-OUTBOX-MISSING-TARGET",
      status: "approved",
      job_id: "asset-files-missing-target",
      job_status: "queued",
      generation_progress: {
        stage: "generating_files",
        previewFingerprint: assetPreviewFingerprint(snapshot),
      },
      preview_data: snapshot,
    });

    const response = await request(app)
      .post(`/api/asset/${report._id}/resubmit`)
      .set(authHeader(String(user._id)))
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("ASSET_QUEUE_HANDOFF_IDENTITY_INVALID");
    expect(jobMocks.queuePreviewFilesJob).not.toHaveBeenCalled();
    expect(await ReportJob.countDocuments()).toBe(0);
  });

  it("acknowledges a valid smaller outbox from a non-submission Asset producer", async () => {
    const user = await createUser("asset-recovery-secondary-producer");
    const snapshot = previewData("Secondary producer snapshot");
    const reportId = new mongoose.Types.ObjectId();
    const generationToken = "asset-files-secondary-producer";
    const outbox = buildAssetPreviewFilesJobOutbox(String(reportId), {
      generationToken,
    });
    await AssetReport.create({
      _id: reportId,
      user: user._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: snapshot.lots,
      contract_no: "ASSET-OUTBOX-SECONDARY",
      status: "approved",
      job_id: generationToken,
      job_status: "queued",
      files_generating: true,
      files_regenerating: true,
      generation_progress: { stage: "generating_files" },
      preview_data: snapshot,
      report_job_outbox: outbox,
    });

    const response = await request(app)
      .post(`/api/asset/${reportId}/resubmit`)
      .set(authHeader(String(user._id)))
      .send({});

    expect(response.status).toBe(202);
    await expect(
      ReportJob.findOne({
        type: "asset-preview-files",
        reportId: String(reportId),
        progressId: generationToken,
      }).lean()
    ).resolves.toMatchObject({
      idempotencyKey: `asset-preview-files:${String(reportId)}:${generationToken}`,
      payload: {
        reportId: String(reportId),
        generationToken,
        approveAfterGeneration: false,
      },
    });
  });

  it("does not rebuild an Asset job from preview data that drifted from its accepted fingerprint", async () => {
    const user = await createUser("asset-recovery-snapshot-drift");
    const acceptedSnapshot = previewData("Accepted generation snapshot");
    const driftedSnapshot = previewData("Unaccepted later edit");
    const report = await AssetReport.create({
      user: user._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: driftedSnapshot.lots,
      contract_no: "ASSET-OUTBOX-SNAPSHOT-DRIFT",
      status: "approved",
      job_id: "asset-files-snapshot-drift",
      job_status: "queued",
      generation_target_status: "approved",
      generation_progress: {
        stage: "generating_files",
        previewFingerprint: assetPreviewFingerprint(acceptedSnapshot),
      },
      preview_data: driftedSnapshot,
    });

    const response = await request(app)
      .post(`/api/asset/${report._id}/resubmit`)
      .set(authHeader(String(user._id)))
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("ASSET_QUEUE_HANDOFF_SNAPSHOT_MISMATCH");
    expect(jobMocks.queuePreviewFilesJob).not.toHaveBeenCalled();
    expect(await ReportJob.countDocuments()).toBe(0);
  });

  it("rejects a stale embedded outbox that belongs to another Asset generation", async () => {
    const user = await createUser("asset-recovery-stale-outbox");
    const snapshot = previewData("Current generation snapshot");
    const reportId = new mongoose.Types.ObjectId();
    const currentToken = "asset-files-current-token";
    const staleOutbox = buildAssetPreviewFilesJobOutbox(String(reportId), {
      previewDataSnapshot: snapshot,
      targetStatus: "approved",
      generationToken: "asset-files-stale-token",
    });
    await AssetReport.create({
      _id: reportId,
      user: user._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: snapshot.lots,
      contract_no: "ASSET-OUTBOX-STALE",
      status: "approved",
      job_id: currentToken,
      job_status: "queued",
      generation_target_status: "approved",
      generation_progress: {
        stage: "generating_files",
        previewFingerprint: assetPreviewFingerprint(snapshot),
      },
      preview_data: snapshot,
      report_job_outbox: staleOutbox,
    });

    const response = await request(app)
      .post(`/api/asset/${reportId}/resubmit`)
      .set(authHeader(String(user._id)))
      .send({});

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("ASSET_QUEUE_HANDOFF_IDENTITY_MISMATCH");
    expect(jobMocks.queuePreviewFilesJob).not.toHaveBeenCalled();
    expect(await ReportJob.countDocuments()).toBe(0);
  });

  it("persists the assigned approver regeneration intent before dispatch", async () => {
    const [creator, approver] = await Promise.all([
      createUser("asset-creator"),
      createUser("asset-approver"),
    ]);
    const report = await AssetReport.create({
      user: creator._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      contract_no: "ASSET-OUTBOX-ASSIGNED",
      status: "pending_approval",
      job_status: "done",
      approval_assigned_to: approver._id,
      approval_requested_at: new Date(),
      preview_data: previewData("Assigned before edit"),
      preview_files: {
        docx: "https://files.example/previous.docx",
        excel: "https://files.example/previous.xlsx",
        images: "https://files.example/previous.zip",
      },
    });

    const response = await request(app)
      .post(`/api/reports/assigned-approvals/${report._id}/preview/resubmit`)
      .set(authHeader(String(approver._id)))
      .send({ preview_data: previewData("Assigned after edit") });

    expect(response.status).toBe(202);
    const persisted: any = await AssetReport.findById(report._id)
      .select("+report_job_outbox")
      .lean();
    expect(persisted).toMatchObject({
      status: "pending_approval",
      job_status: "queued",
      generation_target_status: "approved",
      report_job_outbox: {
        type: "asset-preview-files",
        reportId: String(report._id),
        targetStatus: "approved",
        payload: {
          targetStatus: "approved",
          approveAfterGeneration: true,
          previewDataSnapshot: {
            lots: [
              expect.objectContaining({ title: "Assigned after edit" }),
            ],
          },
        },
      },
    });
    expect(await ReportJob.countDocuments()).toBe(0);

    await expect(
      ensureReportJobOutbox(
        "asset",
        String(report._id),
        persisted.report_job_outbox.token
      )
    ).resolves.toMatchObject({ type: "asset-preview-files" });
  });

  it("repairs an assigned Asset report's missing durable handoff on an exact retry", async () => {
    const [creator, approver] = await Promise.all([
      createUser("assigned-asset-recovery-creator"),
      createUser("assigned-asset-recovery-approver"),
    ]);
    const generationToken = "asset-files-assigned-recovery";
    const snapshot = previewData("Assigned recovery snapshot");
    const report = await AssetReport.create({
      user: creator._id,
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: snapshot.lots,
      contract_no: "ASSET-OUTBOX-ASSIGNED-RECOVERY",
      status: "pending_approval",
      approval_assigned_to: approver._id,
      approval_requested_at: new Date(),
      job_id: generationToken,
      job_status: "queued",
      files_generating: false,
      files_regenerating: false,
      generation_target_status: "approved",
      generation_progress: {
        stage: "generating_files",
        previewFingerprint: assetPreviewFingerprint(snapshot),
      },
      preview_data: snapshot,
    });
    jobMocks.queuePreviewFilesJob.mockImplementation(
      async (reportId: string, options: any) =>
        ensureReportJobOutbox(
          "asset",
          reportId,
          String(options?.reportJobOutboxToken || "")
        )
    );

    const response = await request(app)
      .post(`/api/reports/assigned-approvals/${report._id}/preview/resubmit`)
      .set(authHeader(String(approver._id)))
      .send({});

    expect(response.status).toBe(202);
    expect(response.body.data).toMatchObject({
      reportId: String(report._id),
      reportType: "Asset",
      job_id: generationToken,
      files_generating: true,
    });
    expect(jobMocks.queuePreviewFilesJob).toHaveBeenCalledWith(
      String(report._id),
      expect.objectContaining({
        generationToken,
        targetStatus: "approved",
        reportJobOutboxToken: expect.any(String),
        previewDataSnapshot: snapshot,
      })
    );
    await expect(
      ReportJob.findOne({
        type: "asset-preview-files",
        reportId: String(report._id),
        progressId: generationToken,
      }).lean()
    ).resolves.toBeTruthy();
  });
});
