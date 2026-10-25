import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

let mongo: MongoMemoryServer;
let AssetReport: typeof import("../src/models/asset.model.js")["default"];
let runExcelCrRegenerationJob: typeof import("../src/jobs/excelCrRegenerationJob.js")["runExcelCrRegenerationJob"];
let uploadBufferToR2: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: AssetReport } = await import("../src/models/asset.model.js"));

  const xlsx = await import("../src/service/xlsx/assetXlsxService.js");
  vi.spyOn(xlsx, "generateAssetXlsxFromReport").mockResolvedValue(
    Buffer.from("excel bytes")
  );
  const specPdf = await import(
    "../src/service/auctioneerSpecSheetPdfService.js"
  );
  vi.spyOn(specPdf, "generateAuctioneerSpecSheetPdfFromReport").mockResolvedValue(
    Buffer.from("cr pdf bytes")
  );
  const specDocx = await import(
    "../src/service/auctioneerSpecSheetDocxService.js"
  );
  vi.spyOn(specDocx, "generateAuctioneerSpecSheetDocxFromReport").mockResolvedValue(
    Buffer.from("cr docx bytes")
  );
  const scheduleA = await import("../src/service/scheduleAReportPdfService.js");
  vi.spyOn(scheduleA, "generateScheduleAPdfFromReport").mockResolvedValue(
    Buffer.from("schedule a bytes")
  );
  const r2 = await import("../src/utils/r2Storage/r2Upload.js");
  uploadBufferToR2 = vi
    .spyOn(r2, "uploadBufferToR2")
    .mockResolvedValue("https://assetinsight.test/generated-file");

  ({ runExcelCrRegenerationJob } = await import(
    "../src/jobs/excelCrRegenerationJob.js"
  ));
});

beforeEach(async () => {
  process.env.R2_BUCKET_NAME = "asset-test";
  uploadBufferToR2.mockReset();
  uploadBufferToR2.mockResolvedValue("https://assetinsight.test/generated-file");
  await mongoose.connection.db!.dropDatabase();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await mongoose.disconnect();
  await mongo.stop();
});

describe.sequential("Asset Excel/CR execution ownership", () => {
  it("keeps a reclaimed attempt isolated from stale artifact publication", async () => {
    const logicalToken = "asset-excel-logical-generation";
    const firstExecutionToken = "asset-excel-attempt-one";
    const secondExecutionToken = "asset-excel-attempt-two";
    const report = await AssetReport.create({
      user: new mongoose.Types.ObjectId(),
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      status: "approved",
      preview_data: { lots: [], contract_no: "EXCEL-ATTEMPT" },
      files_generating: true,
      files_regenerating: true,
      job_id: logicalToken,
      job_status: "queued",
      proposal_valuation_revision: 0,
    });

    uploadBufferToR2.mockImplementationOnce(async () => {
      await AssetReport.updateOne(
        {
          _id: report._id,
          job_id: logicalToken,
          job_execution_token: firstExecutionToken,
        },
        { $set: { job_execution_token: secondExecutionToken } }
      );
      return "https://assetinsight.test/stale-schedule-a";
    });

    await expect(
      runExcelCrRegenerationJob({
        kind: "asset",
        reportId: String(report._id),
        generationToken: logicalToken,
        executionContext: {
          executionToken: firstExecutionToken,
          signal: new AbortController().signal,
          assertOwned: async () => undefined,
        },
      })
    ).rejects.toMatchObject({ code: "EXCEL_CR_EXECUTION_OWNERSHIP_LOST" });

    const afterStale: any = await AssetReport.findById(report._id).lean();
    expect(afterStale).toMatchObject({
      job_id: logicalToken,
      job_execution_token: secondExecutionToken,
      job_status: "processing",
    });
    expect(afterStale.preview_files?.excel).toBeUndefined();

    const uploadedKeys: string[] = [];
    uploadBufferToR2.mockImplementation(async (_buffer, _type, _bucket, key) => {
      uploadedKeys.push(String(key));
      return `https://assetinsight.test/${String(key)}`;
    });
    await runExcelCrRegenerationJob({
      kind: "asset",
      reportId: String(report._id),
      generationToken: logicalToken,
      executionContext: {
        executionToken: secondExecutionToken,
        signal: new AbortController().signal,
        assertOwned: async () => undefined,
      },
    });

    expect(uploadedKeys).toHaveLength(4);
    expect(uploadedKeys).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^previews\/.*-[a-f0-9]{64}\.(pdf|xlsx|docx)$/
        ),
      ])
    );
    const completed: any = await AssetReport.findById(report._id).lean();
    expect(completed).toMatchObject({
      job_id: logicalToken,
      job_status: "done",
      files_generating: false,
      files_regenerating: false,
      preview_files: {
        excel: expect.stringContaining(".xlsx"),
        spec_pdf: expect.stringContaining(".pdf"),
        cr_docx: expect.stringContaining(".docx"),
        schedule_a_pdf: expect.stringContaining(".pdf"),
      },
    });
    expect(completed.job_execution_token).toBeUndefined();
  });
});
