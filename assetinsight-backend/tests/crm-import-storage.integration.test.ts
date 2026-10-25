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

const r2Mocks = vi.hoisted(() => ({
  uploadFilePathToR2: vi.fn(),
  deleteFromR2: vi.fn(),
}));

vi.mock("../src/utils/r2Storage/r2Upload.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/utils/r2Storage/r2Upload.js")
  >();
  return {
    ...actual,
    uploadFilePathToR2: r2Mocks.uploadFilePathToR2,
    deleteFromR2: r2Mocks.deleteFromR2,
  };
});

let mongo: MongoMemoryServer;
let app: Awaited<typeof import("../src/app.js")>["default"];
let User: typeof import("../src/models/user.model.js")["default"];
let CrmImportJob: typeof import("../src/models/crmImportJob.model.js")["default"];
let CrmLead: typeof import("../src/models/crmLead.model.js")["default"];
let ReportJob: typeof import("../src/models/reportJob.model.js")["default"];

const environmentNames = [
  "DEVICE_APPROVAL_ENFORCEMENT",
  "R2_BUCKET_NAME",
  "R2_PUBLIC_URL",
  "R2_LEGACY_BUCKET_NAME",
  "R2_LEGACY_PUBLIC_URL",
] as const;
const originalEnvironment = Object.fromEntries(
  environmentNames.map((name) => [name, process.env[name]])
);

function restoreEnvironment() {
  for (const name of environmentNames) {
    const value = originalEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function adminHeaders(id: string) {
  return {
    Authorization: `Bearer ${jwt.sign(
      { id, role: "superadmin" },
      process.env.JWT_SECRET!,
      { expiresIn: "30m" }
    )}`,
  };
}

async function createSuperadmin() {
  const unique = new mongoose.Types.ObjectId();
  return User.create({
    email: `crm-storage-${unique}@example.test`,
    username: `crm-storage-${unique}`,
    password: "Password123!",
    authProvider: "email",
    isVerified: true,
    role: "superadmin",
  });
}

beforeAll(async () => {
  process.env.DEVICE_APPROVAL_ENFORCEMENT = "off";
  process.env.R2_BUCKET_NAME = "crm-current-test";
  process.env.R2_PUBLIC_URL = "https://crm-current.example.test";
  process.env.R2_LEGACY_BUCKET_NAME = "crm-legacy-test";
  process.env.R2_LEGACY_PUBLIC_URL = "https://crm-legacy.example.test";

  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: app } = await import("../src/app.js"));
  ({ default: User } = await import("../src/models/user.model.js"));
  ({ default: CrmImportJob } = await import(
    "../src/models/crmImportJob.model.js"
  ));
  ({ default: CrmLead } = await import("../src/models/crmLead.model.js"));
  ({ default: ReportJob } = await import("../src/models/reportJob.model.js"));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  r2Mocks.uploadFilePathToR2.mockReset();
  r2Mocks.deleteFromR2.mockReset();
  r2Mocks.uploadFilePathToR2.mockImplementation(
    async (_filePath, _contentType, bucketName, key) =>
      `https://crm-current.example.test/${key}`
  );
  r2Mocks.deleteFromR2.mockResolvedValue(undefined);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  restoreEnvironment();
});

describe.sequential("CRM import storage generation persistence", () => {
  it("snapshots the current generation on the import record and durable job payload", async () => {
    const admin = await createSuperadmin();
    const csv = Buffer.from(
      "Client Name,Company Name,Email\nJane Buyer,Northstar Ltd,jane@example.test\n"
    );

    const response = await request(app)
      .post("/api/crm/admin/leads/import")
      .set(adminHeaders(String(admin._id)))
      .field("duplicateMode", "skip")
      .attach("file", csv, {
        filename: "northstar-import.csv",
        contentType: "text/csv",
      });

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      status: "queued",
      progress: 0,
    });

    const importJob: any = await CrmImportJob.findOne({
      jobId: response.body.jobId,
    }).lean();
    expect(importJob).toMatchObject({
      sourceBatchId: response.body.sourceBatchId,
      sourceFileName: "northstar-import.csv",
      sourceFileBucket: "crm-current-test",
      sourceFilePublicBaseUrl: "https://crm-current.example.test",
      status: "queued",
    });
    expect(importJob.sourceFileKey).toMatch(
      /^crm\/imports\/[^/]+-northstar-import\.csv$/
    );
    expect(importJob.sourceFileUrl).toBe(
      `https://crm-current.example.test/${importJob.sourceFileKey}`
    );

    const durableJob: any = await ReportJob.findOne({
      type: "crm-import",
      progressId: response.body.jobId,
    }).lean();
    expect(durableJob).toBeTruthy();
    expect(String(importJob.durableJobId)).toBe(String(durableJob._id));
    expect(durableJob.payload).toMatchObject({
      jobId: response.body.jobId,
      sourceBatchId: response.body.sourceBatchId,
      sourceFileName: "northstar-import.csv",
      sourceFileUrl: importJob.sourceFileUrl,
      sourceFileKey: importJob.sourceFileKey,
      sourceFileBucket: "crm-current-test",
      sourceFilePublicBaseUrl: "https://crm-current.example.test",
      assignedBy: String(admin._id),
      duplicateMode: "skip",
    });
    expect(r2Mocks.uploadFilePathToR2).toHaveBeenCalledWith(
      expect.any(String),
      "text/csv",
      "crm-current-test",
      importJob.sourceFileKey,
      csv.length
    );
  });

  it("deletes metadata for a legacy import batch without deleting its R2 source", async () => {
    const admin = await createSuperadmin();
    const sourceBatchId = "crm-batch-before-storage-cutover";
    const legacyKey = "crm/imports/legacy-import.csv";
    await CrmLead.create({
      clientName: "Legacy Buyer",
      assignedTo: admin._id,
      assignedBy: admin._id,
      sourceBatchId,
      sourceFileName: "legacy-import.csv",
      sourceFileUrl: `https://crm-legacy.example.test/${legacyKey}`,
      sourceFileKey: legacyKey,
    });

    const response = await request(app)
      .delete(`/api/crm/admin/import-files/${sourceBatchId}`)
      .set(adminHeaders(String(admin._id)));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      sourceBatchId,
      deletedLeads: 1,
    });
    expect(r2Mocks.deleteFromR2).not.toHaveBeenCalled();
    expect(await CrmLead.countDocuments({ sourceBatchId })).toBe(0);
  });
});
