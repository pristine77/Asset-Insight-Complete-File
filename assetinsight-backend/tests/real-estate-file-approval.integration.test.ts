import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const effects = vi.hoisted(() => ({ docx: vi.fn(), xlsx: vi.fn(), upload: vi.fn(), email: vi.fn(), notify: vi.fn() }));
vi.mock("../src/service/realEstateDocxService.js", () => ({ generateRealEstateDocxFromReport: effects.docx }));
vi.mock("../src/service/xlsx/realEstateXlsxService.js", () => ({ generateRealEstateXlsx: effects.xlsx }));
vi.mock("../src/utils/r2Storage/r2Upload.js", () => ({
  uploadBufferToR2: effects.upload,
  getR2PublicUrl: (key: string) => `https://assetinsight.test/${key}`,
  uploadToR2: vi.fn(() => { throw new Error("Source uploads are not used by this file-only test"); }),
}));
vi.mock("../src/utils/sendVerificationEmail.js", () => ({ sendEmail: effects.email }));
vi.mock("../src/service/notificationService.js", () => ({ notifyUser: effects.notify }));
vi.mock("../src/utils/openaiClient.js", () => ({ default: { responses: { create: vi.fn(() => { throw new Error("File-only regeneration must not call OpenAI"); }) } } }));

import RealEstateReport from "../src/models/realEstate.model.js";
import User from "../src/models/user.model.js";
import { runRealEstateFilesJob } from "../src/jobs/realEstateReportJob.js";

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  vi.clearAllMocks();
  effects.docx.mockResolvedValue(Buffer.from("test Word bytes"));
  effects.xlsx.mockResolvedValue(Buffer.from("test Excel bytes"));
  effects.upload.mockResolvedValue("https://assetinsight.test/fixture");
  effects.email.mockResolvedValue(undefined);
  effects.notify.mockResolvedValue(undefined);
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });

async function fixture() {
  const manager = await User.create({ username: "Release manager", email: "manager@example.test", password: "not-a-login-fixture", role: "admin" });
  const owner = await User.create({ username: "Appraiser", email: "appraiser@example.test", password: "not-a-login-fixture", releaseManager: manager._id });
  const report = await RealEstateReport.create({
    user: owner._id, status: "preview", files_generating: true, job_status: "queued",
    release_status: "pending_release", release_assigned_to: manager._id,
    property_details: { address: "Original address" },
    preview_data: { property_details: { address: "Saved reviewed address" }, valuation: { fair_market_value: "CA$120,000" } },
    imageUrls: [], extraImageUrls: [], videoUrls: [],
  });
  return { report, owner, manager };
}

describe("Real Estate generation approval and release", () => {
  it.each([true, false])("only releases completed files when approval was already authorized (%s)", async (approveAfterGeneration) => {
    const { report, manager } = await fixture();
    await runRealEstateFilesJob(String(report._id), { approveAfterGeneration });
    const saved = await RealEstateReport.findById(report._id).lean();
    expect(saved).toMatchObject({
      status: approveAfterGeneration ? "approved" : "pending_approval",
      release_status: approveAfterGeneration ? "released" : "pending_release",
      files_generating: false, job_status: "done",
      preview_files: { docx: expect.any(String), excel: expect.any(String), images: expect.any(String) },
    });
    expect(effects.docx).toHaveBeenCalledWith(expect.objectContaining({ property_details: { address: "Saved reviewed address" } }));
    expect(effects.xlsx).toHaveBeenCalledWith(expect.objectContaining({ property_details: { address: "Saved reviewed address" } }));
    expect(effects.upload).toHaveBeenCalledTimes(3);
    expect(effects.email.mock.calls.some(([to]) => to === manager.email)).toBe(false);
    if (approveAfterGeneration) {
      expect(saved).toMatchObject({ release_assigned_to: null, release_assigned_source: "auto_released" });
      expect(saved?.released_at).toBeInstanceOf(Date);
      expect(effects.email).toHaveBeenCalledTimes(1);
    }
  });

  it("does not approve or release when an output upload fails", async () => {
    const { report } = await fixture();
    effects.upload.mockRejectedValueOnce(new Error("Isolated test upload failure"));
    await expect(runRealEstateFilesJob(String(report._id), { approveAfterGeneration: true })).rejects.toThrow("Isolated test upload failure");
    expect(await RealEstateReport.findById(report._id).lean()).toMatchObject({ status: "preview", release_status: "pending_release", job_status: "error" });
    expect(effects.email).not.toHaveBeenCalled();
    expect(effects.notify).not.toHaveBeenCalled();
  });
});
