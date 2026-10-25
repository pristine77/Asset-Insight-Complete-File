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
import AssetReport from "../src/models/asset.model.js";
import LotListing from "../src/models/lotListing.model.js";

const generationMocks = vi.hoisted(() => ({
  pdf: vi.fn(),
  docx: vi.fn(),
  upload: vi.fn(),
  deleteObject: vi.fn(),
}));

vi.mock("../src/service/auctioneerSpecSheetPdfService.js", () => ({
  generateAuctioneerSpecSheetPdfFromReport: generationMocks.pdf,
}));
vi.mock("../src/service/auctioneerSpecSheetDocxService.js", () => ({
  generateAuctioneerSpecSheetDocxFromReport: generationMocks.docx,
}));
vi.mock("../src/utils/r2Storage/r2Upload.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/utils/r2Storage/r2Upload.js")
  >();
  return {
    ...actual,
    uploadBufferToR2: generationMocks.upload,
    deleteFromR2: generationMocks.deleteObject,
  };
});

let mongo: MongoMemoryServer;
let buildCrArtifactSourceFingerprint: typeof import("../src/service/auctioneerSpecPdfRefreshService.js")["buildCrArtifactSourceFingerprint"];
let buildSpecReportData: typeof import("../src/service/auctioneerSpecPdfRefreshService.js")["buildSpecReportData"];
let generateAndStoreAssetCrArtifacts: typeof import("../src/service/auctioneerSpecPdfRefreshService.js")["generateAndStoreAssetCrArtifacts"];
let generateAndStoreLotListingCrArtifacts: typeof import("../src/service/auctioneerSpecPdfRefreshService.js")["generateAndStoreLotListingCrArtifacts"];
const originalBucket = process.env.R2_BUCKET_NAME;

beforeAll(async () => {
  process.env.R2_BUCKET_NAME = "cr-refresh-test";
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({
    buildCrArtifactSourceFingerprint,
    buildSpecReportData,
    generateAndStoreAssetCrArtifacts,
    generateAndStoreLotListingCrArtifacts,
  } = await import("../src/service/auctioneerSpecPdfRefreshService.js"));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  generationMocks.pdf.mockReset().mockResolvedValue(Buffer.from("spec-pdf"));
  generationMocks.docx.mockReset().mockResolvedValue(Buffer.from("cr-docx"));
  generationMocks.upload
    .mockReset()
    .mockImplementation(
      async (
        _buffer: Buffer,
        _contentType: string,
        _bucket: string,
        key: string
      ) => `https://assetinsight.test/${key}`
    );
  generationMocks.deleteObject.mockReset().mockResolvedValue(undefined);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
  if (originalBucket === undefined) delete process.env.R2_BUCKET_NAME;
  else process.env.R2_BUCKET_NAME = originalBucket;
});

async function createAsset() {
  return AssetReport.create({
    user: new mongoose.Types.ObjectId(),
    grouping_mode: "single_lot",
    imageUrls: [],
    lots: [],
    contract_no: "CR-ASSET-100",
    status: "preview",
    job_status: "done",
    proposal_valuation_revision: 4,
    preview_data: {
      contract_no: "CR-ASSET-100",
      lots: [],
    },
    preview_files: {
      spec_pdf: "https://assetinsight.test/old-asset.pdf",
      cr_docx: "https://assetinsight.test/old-asset.docx",
    },
  });
}

async function createListing(status: "preview" | "approved" = "preview") {
  return LotListing.create({
    user: new mongoose.Types.ObjectId(),
    contract_no: "CR-LOT-100",
    sales_date: new Date("2026-09-01T00:00:00.000Z"),
    location: "Regina, SK",
    imageUrls: [],
    videoUrls: [],
    lots: [],
    status,
    job_status: "done",
    valuation_methods: ["FML"],
    preview_data: {
      contract_no: "CR-LOT-100",
      location: "Regina, SK",
      valuation_methods: ["FML"],
      lots: [],
    },
    preview_files: {
      spec_pdf: "https://assetinsight.test/old-listing.pdf",
      cr_docx: "https://assetinsight.test/old-listing.docx",
    },
    ...(status === "approved"
      ? {
          files: {
            spec_pdf: "https://assetinsight.test/old-listing.pdf",
            cr_docx: "https://assetinsight.test/old-listing.docx",
          },
        }
      : {}),
  });
}

describe.sequential("request-scoped CR artifact publication", () => {
  it("includes reviewed spec authority in the CR publication fingerprint", () => {
    const source = { lots: [{ lot_id: "reviewed-lot", condition_report_specs: {},
      description: "Width: 20 ft", categories: "Portable Structures" }] };
    expect(buildCrArtifactSourceFingerprint({ ...source, lots: source.lots.map((lot) => ({
      ...lot, condition_report_specs_reviewed: true,
    })) })).not.toBe(buildCrArtifactSourceFingerprint(source));
    const reportData = buildSpecReportData({ preview_data: source });
    expect(reportData.lots[0].condition_report_specs).toEqual({});
    expect(reportData.lots[0].condition_report_specs_reviewed).toBe(true);
  });

  it("fingerprints normalized renderer inputs without publication metadata", () => {
    const source = {
      _id: new mongoose.Types.ObjectId(),
      updatedAt: new Date("2026-09-01T00:00:00.000Z"),
      status: "preview",
      user: { name: "Femi John", email: "femi@example.test" },
      imageUrls: ["https://assetinsight.test/photo.jpg"],
      preview_data: {
        contract_no: "CR-FINGERPRINT-1",
        lots: [
          {
            lot_number: "8",
            title: "Loader",
            description: "Edited CR description",
            updatedAt: new Date("2026-09-01T00:00:00.000Z"),
          },
        ],
      },
      preview_files: { spec_pdf: "https://assetinsight.test/old.pdf" },
    };
    const first = buildCrArtifactSourceFingerprint(
      buildSpecReportData(source)
    );
    const metadataOnlyChange = buildCrArtifactSourceFingerprint(
      buildSpecReportData(
        {
          ...source,
          updatedAt: new Date("2026-09-03T00:00:00.000Z"),
          preview_files: {
            spec_pdf: "https://assetinsight.test/new.pdf",
            cr_docx: "https://assetinsight.test/new.docx",
          },
          proposal_valuation_artifact_publish_token: "different-lease",
          preview_data: {
            ...source.preview_data,
            lots: source.preview_data.lots.map((lot) => ({
              ...lot,
              updatedAt: new Date("2026-09-03T00:00:00.000Z"),
            })),
          },
        }
      )
    );
    const userVisibleChange = buildCrArtifactSourceFingerprint(
      buildSpecReportData(
        { ...source, user: { ...source.user, name: "Another Appraiser" } }
      )
    );

    expect(metadataOnlyChange).toBe(first);
    expect(userVisibleChange).not.toBe(first);
  });

  it("rejects an Asset double refresh before duplicate generation and publishes the pair atomically", async () => {
    const asset = await createAsset();
    const competingSnapshot = await AssetReport.findById(asset._id);
    let releaseDocxUpload!: () => void;
    const docxUploadGate = new Promise<void>((resolve) => {
      releaseDocxUpload = resolve;
    });
    generationMocks.upload.mockImplementation(
      async (
        _buffer: Buffer,
        contentType: string,
        _bucket: string,
        key: string
      ) => {
        if (contentType.includes("wordprocessingml")) await docxUploadGate;
        return `https://assetinsight.test/${key}`;
      }
    );

    const first = generateAndStoreAssetCrArtifacts(asset);
    await vi.waitFor(() => {
      expect(generationMocks.upload).toHaveBeenCalledTimes(2);
    });

    const whileUploading: any = await AssetReport.findById(asset._id).lean();
    expect(whileUploading.preview_files).toMatchObject({
      spec_pdf: "https://assetinsight.test/old-asset.pdf",
      cr_docx: "https://assetinsight.test/old-asset.docx",
    });
    await expect(
      generateAndStoreAssetCrArtifacts(competingSnapshot)
    ).rejects.toMatchObject({
      code: "CR_ARTIFACT_PUBLISH_IN_PROGRESS",
      statusCode: 409,
    });
    expect(generationMocks.pdf).toHaveBeenCalledTimes(1);
    expect(generationMocks.docx).toHaveBeenCalledTimes(1);

    releaseDocxUpload();
    const result = await first;
    const persisted: any = await AssetReport.findById(asset._id).lean();
    expect(persisted.preview_files).toMatchObject({
      spec_pdf: result.specPdf,
      cr_docx: result.crDocx,
    });
    expect(result.specPdf).toMatch(
      new RegExp(
        `^https://assetinsight\\.test/previews/asset-cr/${String(
          asset._id
        )}/[a-f0-9]{64}/[a-f0-9]{64}-.+\\.pdf\\?v=\\d+$`
      )
    );
    expect(result.crDocx).toMatch(
      new RegExp(
        `^https://assetinsight\\.test/previews/asset-cr/${String(
          asset._id
        )}/[a-f0-9]{64}/[a-f0-9]{64}-.+\\.docx\\?v=\\d+$`
      )
    );
    expect(persisted.proposal_valuation_artifact_publish_token).toBeUndefined();

    const fresh = await AssetReport.findById(asset._id);
    const retry = await generateAndStoreAssetCrArtifacts(fresh);
    expect(retry).toEqual(result);
    expect(generationMocks.pdf).toHaveBeenCalledTimes(1);
    expect(generationMocks.docx).toHaveBeenCalledTimes(1);
    expect(generationMocks.upload).toHaveBeenCalledTimes(2);
  });

  it("rejects a stale Lot Listing snapshot before generating or uploading", async () => {
    const listing = await createListing();
    const stale = await LotListing.findById(listing._id);
    await LotListing.updateOne(
      { _id: listing._id },
      { $set: { "preview_data.location": "Saskatoon, SK" } }
    );

    await expect(
      generateAndStoreLotListingCrArtifacts(stale)
    ).rejects.toMatchObject({
      code: "REPORT_REVISION_CHANGED",
      statusCode: 409,
    });
    expect(generationMocks.pdf).not.toHaveBeenCalled();
    expect(generationMocks.docx).not.toHaveBeenCalled();
    expect(generationMocks.upload).not.toHaveBeenCalled();
  });

  it("publishes approved Lot Listing CR pointers as one immutable pair", async () => {
    const listing = await createListing("approved");
    const competingSnapshot = await LotListing.findById(listing._id);
    let releaseDocxUpload!: () => void;
    const docxUploadGate = new Promise<void>((resolve) => {
      releaseDocxUpload = resolve;
    });
    generationMocks.upload.mockImplementation(
      async (
        _buffer: Buffer,
        contentType: string,
        _bucket: string,
        key: string
      ) => {
        if (contentType.includes("wordprocessingml")) await docxUploadGate;
        return `https://assetinsight.test/${key}`;
      }
    );

    const publication = generateAndStoreLotListingCrArtifacts(listing);
    await vi.waitFor(() => {
      expect(generationMocks.upload).toHaveBeenCalledTimes(2);
    });
    const beforeCommit: any = await LotListing.findById(listing._id).lean();
    expect(beforeCommit.preview_files).toMatchObject({
      spec_pdf: "https://assetinsight.test/old-listing.pdf",
      cr_docx: "https://assetinsight.test/old-listing.docx",
    });
    expect(beforeCommit.files).toMatchObject(beforeCommit.preview_files);
    await expect(
      generateAndStoreLotListingCrArtifacts(competingSnapshot)
    ).rejects.toMatchObject({
      code: "CR_ARTIFACT_PUBLISH_IN_PROGRESS",
      statusCode: 409,
    });
    expect(generationMocks.pdf).toHaveBeenCalledTimes(1);
    expect(generationMocks.docx).toHaveBeenCalledTimes(1);

    releaseDocxUpload();
    const result = await publication;
    const persisted: any = await LotListing.findById(listing._id).lean();
    expect(persisted.preview_files).toMatchObject({
      spec_pdf: result.specPdf,
      cr_docx: result.crDocx,
    });
    expect(persisted.files).toMatchObject({
      spec_pdf: result.specPdf,
      cr_docx: result.crDocx,
    });
    expect(result.specPdf).toContain(
      `lot-listings/lot-listing-cr/${String(listing._id)}/`
    );
    expect(result.crDocx).toContain(
      `lot-listings/lot-listing-cr/${String(listing._id)}/`
    );
    expect(persisted.artifact_publish_token).toBeUndefined();

    const fresh = await LotListing.findById(listing._id);
    const retry = await generateAndStoreLotListingCrArtifacts(fresh);
    expect(retry).toEqual(result);
    expect(generationMocks.pdf).toHaveBeenCalledTimes(1);
    expect(generationMocks.docx).toHaveBeenCalledTimes(1);
    expect(generationMocks.upload).toHaveBeenCalledTimes(2);

    await LotListing.updateOne(
      { _id: listing._id },
      { $unset: { "files.spec_pdf": 1, "files.cr_docx": 1 } }
    );
    const missingApprovedPointers = await LotListing.findById(listing._id);
    const repaired = await generateAndStoreLotListingCrArtifacts(
      missingApprovedPointers
    );
    const afterRepair: any = await LotListing.findById(listing._id).lean();
    expect(repaired).toEqual(result);
    expect(afterRepair.files).toMatchObject(afterRepair.preview_files);
    expect(generationMocks.pdf).toHaveBeenCalledTimes(1);
    expect(generationMocks.docx).toHaveBeenCalledTimes(1);
    expect(generationMocks.upload).toHaveBeenCalledTimes(2);
  });

  it("retains the previous Lot Listing pair and releases its lease after a partial upload failure", async () => {
    const listing = await createListing("approved");
    generationMocks.deleteObject.mockRejectedValueOnce(
      new Error("R2 cleanup unavailable")
    );
    generationMocks.upload.mockImplementation(
      async (
        _buffer: Buffer,
        contentType: string,
        _bucket: string,
        key: string
      ) => {
        if (contentType.includes("wordprocessingml")) {
          throw new Error("R2 DOCX upload unavailable");
        }
        return `https://assetinsight.test/${key}`;
      }
    );

    await expect(
      generateAndStoreLotListingCrArtifacts(listing)
    ).rejects.toThrow("R2 DOCX upload unavailable");

    const persisted: any = await LotListing.findById(listing._id).lean();
    expect(persisted.preview_files).toMatchObject({
      spec_pdf: "https://assetinsight.test/old-listing.pdf",
      cr_docx: "https://assetinsight.test/old-listing.docx",
    });
    expect(persisted.files).toMatchObject(persisted.preview_files);
    expect(persisted.artifact_publish_token).toBeUndefined();
    expect(persisted.artifact_publish_expires_at).toBeUndefined();
    expect(generationMocks.deleteObject).toHaveBeenCalledTimes(2);
  });

  it("never deletes deterministic keys that are already published pointers", async () => {
    const listing = await createListing("approved");
    const published = await generateAndStoreLotListingCrArtifacts(listing);
    await LotListing.updateOne(
      { _id: listing._id },
      { $unset: { cr_artifact_source_fingerprint: 1 } }
    );
    generationMocks.deleteObject.mockClear();
    generationMocks.upload.mockImplementation(
      async (
        _buffer: Buffer,
        contentType: string,
        _bucket: string,
        key: string
      ) => {
        if (contentType.includes("wordprocessingml")) {
          throw new Error("R2 DOCX retry unavailable");
        }
        return `https://assetinsight.test/${key}`;
      }
    );

    const retryWithoutFingerprint = await LotListing.findById(listing._id);
    await expect(
      generateAndStoreLotListingCrArtifacts(retryWithoutFingerprint)
    ).rejects.toThrow("R2 DOCX retry unavailable");

    const persisted: any = await LotListing.findById(listing._id).lean();
    expect(persisted.preview_files).toMatchObject({
      spec_pdf: published.specPdf,
      cr_docx: published.crDocx,
    });
    expect(persisted.files).toMatchObject(persisted.preview_files);
    expect(persisted.artifact_publish_token).toBeUndefined();
    expect(generationMocks.deleteObject).not.toHaveBeenCalled();
  });
});
