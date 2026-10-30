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

const generationMocks = vi.hoisted(() => ({
  docx: vi.fn(),
  xlsx: vi.fn(),
  scheduleA: vi.fn(),
  schedulePdf: vi.fn(),
  specPdf: vi.fn(),
  specDocx: vi.fn(),
  imagesZip: vi.fn(),
  upload: vi.fn(),
  enrich: vi.fn(),
}));

vi.mock("../src/service/lotListingSpecEnrichmentService.js", () => ({
  enrichAuctioneerImportSpecs: generationMocks.enrich,
}));

vi.mock("../src/service/assetDocxService.js", () => ({
  generateAssetDocxFromReport: generationMocks.docx,
}));
vi.mock("../src/service/xlsx/assetXlsxService.js", () => ({
  generateAssetXlsxFromReport: generationMocks.xlsx,
}));
vi.mock("../src/service/scheduleAReportPdfService.js", () => ({
  generateScheduleAPdfFromReport: generationMocks.scheduleA,
}));
vi.mock("../src/service/assetSchedulePdfService.js", () => ({
  generateAssetSchedulePdfFromReport: generationMocks.schedulePdf,
}));
vi.mock("../src/service/auctioneerSpecSheetPdfService.js", () => ({
  generateAuctioneerSpecSheetPdfFromReport: generationMocks.specPdf,
}));
vi.mock("../src/service/auctioneerSpecSheetDocxService.js", () => ({
  generateAuctioneerSpecSheetDocxFromReport: generationMocks.specDocx,
}));
vi.mock("../src/jobs/assetReportJob/imagesZip.js", () => ({
  generateImagesZip: generationMocks.imagesZip,
}));
vi.mock("../src/utils/r2Storage/r2Upload.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/utils/r2Storage/r2Upload.js")
  >();
  return {
    ...actual,
    uploadBufferToR2: generationMocks.upload,
  };
});

let mongo: MongoMemoryServer;
let AssetReport: typeof import("../src/models/asset.model.js")["default"];
let runPreviewFilesJob: typeof import("../src/jobs/assetReportJob/previewFilesJob.js")["runPreviewFilesJob"];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: AssetReport } = await import("../src/models/asset.model.js"));
  ({ runPreviewFilesJob } = await import(
    "../src/jobs/assetReportJob/previewFilesJob.js"
  ));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  generationMocks.enrich.mockReset().mockImplementation(async ({ lots }) => ({ lots, analyses: [] }));
  generationMocks.docx.mockReset().mockResolvedValue(Buffer.from("docx"));
  generationMocks.xlsx.mockReset().mockResolvedValue(Buffer.from("xlsx"));
  generationMocks.scheduleA
    .mockReset()
    .mockResolvedValue(Buffer.from("schedule-a-content"));
  generationMocks.schedulePdf
    .mockReset()
    .mockResolvedValue(Buffer.from("schedule-pdf"));
  generationMocks.specPdf
    .mockReset()
    .mockResolvedValue(Buffer.from("spec-pdf"));
  generationMocks.specDocx
    .mockReset()
    .mockResolvedValue(Buffer.from("spec-docx"));
  generationMocks.imagesZip
    .mockReset()
    .mockResolvedValue(Buffer.from("images-zip"));
  generationMocks.upload
    .mockReset()
    .mockImplementation(async (_buffer, _type, _bucket, key) =>
      `https://assetinsight.test/${String(key)}`
    );
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe.sequential("Asset preview file generation", () => {
  it("renders the current evaluator average across file regenerations without persisting it over AI estimates", async () => {
    const { buildScheduleRows } = await vi.importActual<typeof import("../src/service/assetSchedulePdfService.js")>("../src/service/assetSchedulePdfService.js");
    const { resolveSelectedAssetValuationMethods } = await import("../src/service/docx/builders/certificate.js");
    const lot = { lot_id: "evaluator-fixture", lot_number: "1", title: "Saved evaluator fixture", estimated_value: "CAD 12,637.79",
      image_urls: [], image_indexes: [], condition_report_specs: {}, condition_report_specs_reviewed: true };
    const sheet = { evaluator_columns: [{ id: "owner", name: "Owner" }, { id: "peer", name: "Peer" }, { id: "blank", name: "Blank" }],
      rows: [{ lot_id: lot.lot_id, asset_insight: lot.estimated_value, evaluator_values: { owner: 13500, peer: 13500, blank: null } }], file_summary: {} };
    const report = await AssetReport.create({ user: new mongoose.Types.ObjectId(), grouping_mode: "per_item", imageUrls: [],
      lots: [lot], status: "preview", is_merged_report: true, currency: "CAD", include_valuation_table: false, valuation_methods: [],
      proposal_valuation_revision: 1, total_value: 12637.79,
      preview_data: { lots: [lot], currency: "CAD", total_value: 12637.79, admin_schedule_sheet: sheet } });
    for (const [index, peer] of [13500, 14500].entries()) {
      const token = `evaluator-artifacts-${index}`;
      await AssetReport.updateOne({ _id: report._id }, { $set: {
        "preview_data.admin_schedule_sheet.rows.0.evaluator_values.peer": peer,
        proposal_valuation_revision: index + 1, files_generating: true, files_regenerating: index > 0,
        job_id: token, job_status: "queued", generation_target_status: "preview",
      } });
      await runPreviewFilesJob(String(report._id), { jobId: token, targetStatus: "preview" });
      const expected = index === 0 ? 13500 : 14000;
      for (const generator of [generationMocks.docx, generationMocks.schedulePdf]) {
        const data = generator.mock.calls.at(-1)?.[0];
        expect(buildScheduleRows(data)[0].fmv_value).toBe(index === 0 ? "CAD 13,500.00" : "CAD 14,000.00");
        expect(resolveSelectedAssetValuationMethods(data)[0].value).toBe(expected);
      }
      const stored: any = await AssetReport.findById(report._id).lean();
      expect(stored.job_status).toBe("done");
      expect(stored.proposal_valuation_published_revision).toBe(index + 1);
      expect(stored.total_value).toBe(12637.79);
      expect(stored.lots[0].estimated_value).toBe(lot.estimated_value);
      expect(stored.preview_data.lots[0].estimated_value).toBe(lot.estimated_value);
      expect(stored.preview_data.admin_schedule_sheet.rows[0]).toMatchObject({
        asset_insight: lot.estimated_value, evaluator_values: { owner: 13500, peer, blank: null },
      });
      expect(generationMocks.enrich).not.toHaveBeenCalled();
    }
  });

  it("FMV update review: regenerates table-off FMV and honours later explicit choices without changing lots", async () => {
    const { buildScheduleRows } = await vi.importActual<typeof import("../src/service/assetSchedulePdfService.js")>("../src/service/assetSchedulePdfService.js");
    const reportLot = { lot_id: "fmv-review-1", lot_number: "1", title: "Reviewed short title",
      description: "Retained long narrative", estimated_value: "CAD 160", image_urls: [], image_indexes: [], condition_report_specs_reviewed: true };
    const report = await AssetReport.create({ user: new mongoose.Types.ObjectId(), grouping_mode: "single_lot",
      lots: [reportLot], imageUrls: [], status: "preview", is_merged_report: true, include_valuation_table: false,
      valuation_methods: [], valuation_data: { methods: [{ method: "OLV", percentage: 77 }] },
      preview_data: { lots: [reportLot], valuation_methods: [], include_valuation_table: false } });
    const sourceBefore: any = await AssetReport.findById(report._id).lean();
    const rounds = [{ table: false, methods: [], expected: ["FMV"], amount: "CAD 160.00" },
      { table: true, methods: ["OLV"], expected: ["OLV"], amount: "CAD 123.20" },
      { table: true, methods: [], expected: [], amount: undefined }];
    for (const [index, round] of rounds.entries()) {
      const token = `fmv-review-${index}`;
      await AssetReport.updateOne({ _id: report._id }, { $set: {
        "preview_data.valuation_methods": round.methods, "preview_data.include_valuation_table": round.table,
        files_generating: true, files_regenerating: index > 0, job_id: token, job_status: "queued", generation_target_status: "preview",
      } });
      await runPreviewFilesJob(String(report._id), { jobId: token, targetStatus: "preview" });
      for (const generator of [generationMocks.docx, generationMocks.schedulePdf]) {
        const data = generator.mock.calls.at(-1)?.[0];
        const row = buildScheduleRows(data)[0];
        expect(row.description).toBe(reportLot.title);
        expect(row.valuations.map((value) => value.code)).toEqual(round.expected);
        expect(row.valuations[0]?.value).toBe(round.amount);
      }
      const stored: any = await AssetReport.findById(report._id).lean();
      expect(stored.job_status).toBe("done");
      expect(stored.status).toBe("preview");
      expect(stored.lots).toEqual(sourceBefore.lots);
      expect(stored.imageUrls).toEqual(sourceBefore.imageUrls);
      expect(stored.preview_data.lots).toEqual(sourceBefore.preview_data.lots);
    }
  });

  it("carries exact Title and selected methods into real Schedule A rows across two generations", async () => {
    const { buildScheduleRows } = await vi.importActual<typeof import("../src/service/assetSchedulePdfService.js")>("../src/service/assetSchedulePdfService.js");
    const reportLot = { lot_id: "stools-1", lot_number: "1", title: "(8) Chrome Bar Stools",
      description: "Retained long narrative", estimated_value: "CAD 160", image_urls: [], image_indexes: [], condition_report_specs_reviewed: true };
    const report = await AssetReport.create({ user: new mongoose.Types.ObjectId(), grouping_mode: "single_lot",
      lots: [reportLot], imageUrls: [], status: "preview", is_merged_report: true,
      valuation_methods: ["FLV", "OLV"], valuation_data: { methods: [{ method: "FLV", percentage: 52 }, { method: "OLV", percentage: 77 }] },
      preview_data: { lots: [reportLot], valuation_methods: ["FML"] } });
    for (const round of [1, 2]) {
      const title = round === 1 ? reportLot.title : "(8) Chrome Bar Stools - reviewed";
      const methods = round === 1 ? ["FML"] : ["OLV"];
      const token = `title-methods-${round}`;
      await AssetReport.updateOne({ _id: report._id }, { $set: {
        "preview_data.lots.0.title": title, "preview_data.valuation_methods": methods,
        files_generating: true, files_regenerating: round === 2, job_id: token, job_status: "queued", generation_target_status: "preview",
      } });
      await runPreviewFilesJob(String(report._id), { jobId: token, targetStatus: "preview" });
      for (const generator of [generationMocks.docx, generationMocks.schedulePdf]) {
        const data = generator.mock.calls.at(-1)?.[0];
        const row = buildScheduleRows(data)[0];
        expect(row.description).toBe(title);
        expect(row.valuations.map((v) => v.code)).toEqual(round === 1 ? ["FMV"] : ["OLV"]);
        expect(row.valuations[0].value).toBe(round === 1 ? "CAD 160.00" : "CAD 123.20");
      }
      const stored: any = await AssetReport.findById(report._id).lean();
      expect(stored.job_status).toBe("done");
      expect(stored.preview_data.lots[0].description).toBe(reportLot.description);
      expect(stored.preview_data.lots[0].title).toBe(title);
    }
  });

  it.each([{}, { "Overall Width": "18 ft", Manufacturer: "" }])(
    "preserves a reviewed spec snapshot for first generation, retry and regeneration (%j)", async (specs) => {
      const imageUrl = "https://assetinsight.test/uploads/reviewed-structure.jpg";
      const lot = { lot_id: "structure-1826", lot_number: "1826", title: "Portable structure",
        description: "Width: 20 ft; Manufacturer: Old Co", categories: "Portable Structures", estimated_value: "CAD 1000",
        condition_report_specs: specs, condition_report_specs_manual_overrides: specs,
        condition_report_specs_deleted: ["Overall Height"], image_urls: [imageUrl], image_indexes: [0] };
      const snapshot = { contract_no: "REVIEWED-SPEC-FIXTURE", lots: [lot] };
      const originalSnapshot = structuredClone(snapshot);
      const report = await AssetReport.create({ user: new mongoose.Types.ObjectId(), grouping_mode: "single_lot",
        imageUrls: [imageUrl], lots: [lot], status: "preview", preview_data: snapshot });
      for (const round of [1, 2]) {
        const token = `reviewed-asset-specs-${round}`;
        await AssetReport.updateOne({ _id: report._id }, { $set: {
          files_generating: true, files_regenerating: round === 2, status: "processing",
          job_id: token, job_status: "queued", generation_target_status: "preview",
        } });
        const options = { jobId: token, targetStatus: "preview" as const, previewDataSnapshot: snapshot, willRetryOnError: true };
        if (round === 1) {
          generationMocks.imagesZip.mockRejectedValueOnce(new Error("Fixture archive interruption"));
          await expect(runPreviewFilesJob(String(report._id), options)).rejects.toThrow("Fixture archive interruption");
          await AssetReport.updateOne({ _id: report._id }, { $set: { job_status: "queued", status: "processing" } });
        }
        await runPreviewFilesJob(String(report._id), options);
        const completed: any = await AssetReport.findById(report._id).lean();
        expect(completed.job_status).toBe("done");
        for (const lots of [completed.lots, completed.preview_data.lots]) {
          expect(lots[0].condition_report_specs || {}).toEqual(specs);
          expect(lots[0].condition_report_specs_manual_overrides || {}).toEqual(specs);
          expect(lots[0].condition_report_specs_reviewed).toBe(true);
        }
        for (const generator of [generationMocks.docx, generationMocks.xlsx, generationMocks.scheduleA,
          generationMocks.schedulePdf, generationMocks.specPdf, generationMocks.specDocx]) {
          expect(generator).toHaveBeenCalled();
          expect(generator.mock.calls.at(-1)?.[0].lots[0]).toMatchObject({ condition_report_specs: specs, condition_report_specs_reviewed: true });
        }
        expect(generationMocks.enrich).not.toHaveBeenCalled();
        expect(completed.imageUrls).toEqual([imageUrl]);
        expect(snapshot).toEqual(originalSnapshot);
      }
      expect(await AssetReport.countDocuments()).toBe(1);
    }
  );

  it.each([
    "Caterpillar 420E IT 4WD Backhoe Loader\nAppraiser's saved inspection notes.",
    "",
    "Owner-authored historical note\nRunning Condition: Does not Start or Run; Completeness: Missing Parts; Legal: No Title",
  ])("preserves saved descriptions and separate selections through repeated generation (%j)", async (description) => {
    const selections = { condition: "Starts and Runs", completeness: "Has Keys", legal: "N/A" };
    const lot = {
      lot_id: "backhoe-278", lot_number: "278", title: "Caterpillar 420E IT 4WD Backhoe Loader",
      description, estimated_value: "CAD 42500", condition_report_selections: selections,
      image_urls: [], image_indexes: [],
    };
    const report = await AssetReport.create({
      user: new mongoose.Types.ObjectId(), grouping_mode: "single_lot", imageUrls: [],
      lots: [lot], is_merged_report: true, contract_no: "ASSET-DESCRIPTION-278",
      status: "approved", preview_data: { lots: [lot] },
    });
    for (const round of [1, 2]) {
      const token = `asset-description-selections-${round}`;
      const currentSelections = round === 1 ? selections : { condition: "N/A", completeness: "N/A", legal: "N/A" };
      await AssetReport.updateOne({ _id: report._id }, { $set: {
        "preview_data.lots.0.condition_report_selections": currentSelections,
        files_generating: true, files_regenerating: true,
        job_id: token, job_status: "queued", generation_target_status: "approved",
      } });
      await runPreviewFilesJob(String(report._id), { jobId: token, targetStatus: "approved" });
      const stored: any = await AssetReport.findById(report._id).lean();
      expect(stored.job_status).toBe("done");
      for (const lots of [stored.lots, stored.preview_data.lots]) {
        expect(lots[0].description).toBe(description);
        expect(lots[0].condition_report_selections).toEqual(currentSelections);
        expect(lots[0].lot_number).toBe("278");
      }
      for (const generator of [generationMocks.docx, generationMocks.xlsx, generationMocks.scheduleA,
        generationMocks.schedulePdf, generationMocks.specPdf, generationMocks.specDocx]) {
        expect(generator).toHaveBeenCalledTimes(round);
        expect(generator.mock.calls.at(-1)?.[0].lots[0]).toMatchObject({
          description, condition_report_selections: currentSelections,
        });
      }
    }
    expect(await AssetReport.countDocuments()).toBe(1);
  });

  it("merges trusted source video manifests and retains every clip in regenerated ZIP", async () => {
    const previousQueue = process.env.REPORT_QUEUE_BACKEND;
    process.env.REPORT_QUEUE_BACKEND = "mongo";
    try {
      const { mergeAssetReports } = await import("../src/service/assetReportMergeService.js");
      const ownerId = new mongoose.Types.ObjectId();
      const clips = ["first.mp4", "unassigned.mov", "second.mp4"].map((name) => `https://assetinsight.test/uploads/${name}`);
      const sources = await Promise.all([0, 1].map((index) => AssetReport.create({
        user: ownerId, grouping_mode: "single_lot", imageUrls: [],
        videoUrls: index === 0 ? clips.slice(0, 2) : [clips[0], clips[2]],
        lots: [], status: "preview", job_status: "done", contract_no: "MERGE-VIDEO",
        preview_data: { contract_no: "MERGE-VIDEO", videoUrls: ["https://untrusted.invalid/not-an-original.mp4"], lots: [{
          lot_id: `source-${index}`, lot_number: index === 0 ? "20" : "10", title: `Vehicle ${index}`,
          description: "Reviewed vehicle", image_indexes: [], estimated_value: "CAD 1000",
          video_urls: [clips[index === 0 ? 0 : 2], "https://untrusted.invalid/not-an-original.mp4"],
        }] },
      })));
      const input = { userId: String(ownerId), sourceReportIds: sources.map((source) => String(source._id)), primaryReportId: String(sources[0]._id), mergeRequestId: "media-merge-stable" };
      const { report: merged } = await mergeAssetReports(input);
      expect(merged.videoUrls).toEqual(clips);
      expect(merged.preview_data.videoUrls).toEqual(clips);
      expect(merged.preview_data.lots.map((lot: any) => lot.video_urls)).toEqual([[clips[2]], [clips[0]]]);
      expect(String((await mergeAssetReports(input)).report._id)).toBe(String(merged._id));
      await runPreviewFilesJob(String(merged._id), { jobId: merged.job_id, targetStatus: "preview" });
      const rawFiles = generationMocks.imagesZip.mock.calls.at(-1)?.[2]?.rawFiles;
      expect(rawFiles.map((entry: any) => entry.url)).toEqual([clips[2], clips[0], clips[1]]);
      expect(rawFiles[2].filename).toContain("Unassigned-Video.mov");
      expect(await AssetReport.countDocuments()).toBe(3);
      expect((await AssetReport.findById(sources[0]._id).lean())?.videoUrls).toEqual(clips.slice(0, 2));
      expect(generationMocks.upload.mock.calls.every(([, mime]) => !/^(image|video)\//.test(String(mime)))).toBe(true);
    } finally {
      if (previousQueue === undefined) delete process.env.REPORT_QUEUE_BACKEND;
      else process.env.REPORT_QUEUE_BACKEND = previousQueue;
    }
  });

  it.each([true, false])(
    "reuses saved photos across condition edits and submissions when watermark_images is %s",
    async (watermarkImages) => {
      const imageUrl = "https://assetinsight.test/uploads/asset/prepared-trailer.jpg";
      const videoUrl = "https://assetinsight.test/uploads/asset/camera-trailer.mp4";
      const firstToken = "asset-media-first-submission";
      const lot = {
        lot_id: "trailer-158",
        lot_number: "158",
        title: "2014 Prime Time Avenger Travel Trailer",
        description: "Original condition details",
        image_indexes: [0],
        image_urls: [imageUrl],
        video_urls: [videoUrl],
      };
      const report = await AssetReport.create({
        user: new mongoose.Types.ObjectId(),
        grouping_mode: "single_lot",
        imageUrls: [imageUrl],
        videoUrls: [videoUrl],
        lots: [lot],
        // Skip unrelated AI spec enrichment; this test uses already reviewed lots.
        is_merged_report: true,
        contract_no: "ASSET-MEDIA-158",
        watermark_images: watermarkImages,
        status: "approved",
        preview_data: {
          contract_no: "ASSET-MEDIA-158",
          watermark_images: watermarkImages,
          lots: [lot],
        },
        files_generating: true,
        job_id: firstToken,
        job_status: "queued",
        generation_target_status: "approved",
      });

      await runPreviewFilesJob(String(report._id), {
        jobId: firstToken,
        targetStatus: "approved",
      });

      const secondToken = "asset-media-condition-edit";
      const editedDescription = "Desktop review: awning damaged, otherwise complete";
      await AssetReport.updateOne(
        { _id: report._id },
        {
          $set: {
            "preview_data.lots.0.description": editedDescription,
            files_generating: true,
            files_regenerating: true,
            job_id: secondToken,
            job_status: "queued",
            generation_target_status: "approved",
          },
        },
      );

      await runPreviewFilesJob(String(report._id), {
        jobId: secondToken,
        targetStatus: "approved",
      });

      expect(generationMocks.imagesZip).toHaveBeenCalledTimes(2);
      for (const [urls, , options] of generationMocks.imagesZip.mock.calls) {
        expect(urls).toEqual([imageUrl]);
        expect(options).toMatchObject({ watermark: false });
        expect(options.filenames).toHaveLength(1);
        expect(options.rawFiles).toEqual([{ url: videoUrl, filename: expect.stringMatching(/Lot-001_Video-001_.*\.mp4$/) }]);
      }
      expect(generationMocks.docx).toHaveBeenLastCalledWith(
        expect.objectContaining({
          lots: [expect.objectContaining({ description: editedDescription })],
        }),
      );
      const stored: any = await AssetReport.findById(report._id).lean();
      expect(stored.imageUrls).toEqual([imageUrl]);
      expect(stored.videoUrls).toEqual([videoUrl]);
      expect(stored.preview_data.lots[0].video_urls).toEqual([videoUrl]);
      expect(stored.job_status).toBe("done");
      expect(stored.preview_files.images).toBeTruthy();
      expect(generationMocks.upload.mock.calls.every(
        ([, contentType]) => !/^(image|video)\//.test(String(contentType)),
      )).toBe(true);
    },
  );

  it("embeds the exact immutable published Schedule A URL in DOCX and XLSX", async () => {
    const generationToken = "asset-schedule-a-immutable-url";
    const report = await AssetReport.create({
      user: new mongoose.Types.ObjectId(),
      grouping_mode: "single_lot",
      imageUrls: [],
      lots: [],
      is_merged_report: true,
      contract_no: "ASSET-SCHEDULE-A-100",
      status: "approved",
      preview_data: {
        contract_no: "ASSET-SCHEDULE-A-100",
        lots: [],
      },
      files_generating: true,
      files_regenerating: true,
      job_id: generationToken,
      job_status: "queued",
      generation_target_status: "approved",
      proposal_valuation_revision: 3,
    });

    await runPreviewFilesJob(String(report._id), {
      jobId: generationToken,
      targetStatus: "approved",
    });

    const stored: any = await AssetReport.findById(report._id).lean();
    const publishedScheduleA = stored.preview_files.schedule_a_pdf;
    expect(generationMocks.upload).toHaveBeenCalled();
    expect(generationMocks.upload.mock.calls.every(
      call => call[4]?.multipart === true,
    )).toBe(true);
    expect(publishedScheduleA).toMatch(
      new RegExp(
        `^https://assetinsight\\.test/previews/asset-generations/${String(
          report._id
        )}/revision-3/[a-f0-9]{64}-.+\\.pdf\\?v=\\d+$`
      )
    );
    expect(generationMocks.docx).toHaveBeenCalledWith(
      expect.objectContaining({ schedule_a_pdf_url: publishedScheduleA })
    );
    expect(generationMocks.xlsx).toHaveBeenCalledWith(
      expect.objectContaining({ schedule_a_pdf_url: publishedScheduleA }),
    );
  });
});
