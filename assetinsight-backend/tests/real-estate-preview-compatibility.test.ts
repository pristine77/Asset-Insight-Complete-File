import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/utils/openaiClient.js", () => ({ default: { responses: { create: vi.fn() } } }));
vi.mock("../src/utils/r2Storage/r2Upload.js", () => ({
  uploadBufferToR2: vi.fn(), uploadToR2: vi.fn(),
  getR2PublicUrl: (key: string) => `https://assetinsight.test/${key}`,
}));
vi.mock("../src/utils/imageProcessing.js", () => ({
  prepareImageWithoutWatermark: async (buffer: Buffer, mimetype: string) => ({ buffer, mimetype, extension: ".jpg" }),
}));
vi.mock("../src/service/openAIService.js", () => ({
  analyzeFarmlandImages: vi.fn().mockResolvedValue({ notes: "Observed farmland" }),
  analyzeCommercialImages: vi.fn(), analyzeRealEstateImages: vi.fn(),
}));
vi.mock("../src/service/webSearchService.js", () => ({
  findFarmlandComparables: vi.fn(), findComparableProperties: vi.fn(), findCommercialComparables: vi.fn(),
}));
vi.mock("../src/service/marketTrendSebSearch.js", () => ({ marketTrendSearch: vi.fn().mockResolvedValue([]) }));
vi.mock("../src/service/realEstateAIContent.js", () => ({ generateRealEstateReportContent: vi.fn().mockResolvedValue({}) }));
vi.mock("../src/service/farmlandValuationService.js", async (original) => ({
  ...await original<typeof import("../src/service/farmlandValuationService.js")>(),
  calculateCostApproachAI: vi.fn(),
}));

import RealEstateReport from "../src/models/realEstate.model.js";
import { calculateCostApproachAI } from "../src/service/farmlandValuationService.js";
import { findFarmlandComparables } from "../src/service/webSearchService.js";
import { calculatePreviewFarmlandValuation, runRealEstatePreviewJob, runRealEstateReportJob } from "../src/jobs/realEstateReportJob.js";
import { createRealEstate, getPreviewData, getSubmittedPreviewData } from "../src/controller/realEstate.controller.js";

const comparable = {
  comp_id: "F-1", address: "Comparable", sale_date: "2026-09-01", rm_area: "Example RM",
  distance_km: 0, title_acres: 160, cultivated_acres: 100,
  sale_price: 100000, price_per_cultivated_acre: 1000, data_source: "Fixture", notes: "typical",
};
const cost = {
  land_value: 150000, replacement_cost_new: 60000, physical_depreciation: 10000,
  functional_obsolescence: 0, external_obsolescence: 0, total_depreciation: 10000,
  depreciated_cost_of_improvements: 50000, indicated_value: 200000,
};
const details = (flags: Record<string, unknown> = {}) => ({
  property_type: "agricultural",
  property_details: { address: "Subject farm", municipality: "Example RM", property_type: "agricultural" },
  report_dates: { effective_date: "2026-09-01" },
  farmland_details: {
    total_title_acres: 160, cultivated_acres: 100, soil_class: "2", access_quality: "good",
    market_rent_per_acre: 100, vacancy_loss_percent: 0, operating_expense_ratio: 0, cap_rate: 10,
    ...flags,
  },
});

let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  vi.clearAllMocks();
  await RealEstateReport.deleteMany({});
  vi.mocked(calculateCostApproachAI).mockResolvedValue(cost);
  vi.mocked(findFarmlandComparables).mockResolvedValue([comparable]);
});

describe("queued farmland preview selected approaches", () => {
  it.each([
    [true, false, false, 100, 0, 0, 100000],
    [false, true, false, 0, 100, 0, 100000],
    [false, false, true, 0, 0, 100, 200000],
    [true, true, false, 70, 30, 0, 100000],
    [true, false, true, 70, 0, 30, 130000],
    [false, true, true, 0, 60, 40, 140000],
    [true, true, true, 50, 30, 20, 120000],
  ])("honors selected methods %s/%s/%s with existing reconciliation weights", async (direct, income, costSelected, directWeight, incomeWeight, costWeight, expected) => {
    const result = await calculatePreviewFarmlandValuation(details({
      use_direct_comparable: direct, use_income_approach: income, use_cost_approach: costSelected,
    }), {}, [comparable]);
    expect(result).toMatchObject({
      approaches_used: { direct_comparable: direct, income_capitalization: income, cost_approach: costSelected },
      fair_market_value: expected,
      reconciliation: { direct_comparison_weight: directWeight, income_weight: incomeWeight, final_reconciled_value: expected },
    });
    expect(result?.reconciliation.cost_weight || 0).toBe(costWeight);
    expect(Boolean(result?.income_capitalization)).toBe(income);
    if (!income) expect(result?.reconciliation.income_value).toBe(0);
    if (!direct) expect(result?.comparables).toEqual([]);
    expect(calculateCostApproachAI).toHaveBeenCalledTimes(costSelected ? 1 : 0);
    if (direct) expect(result?.comparables[0].distance_to_subject_km).toBe(0);
  });

  it("does not select valuation methods when all flags are explicitly off", async () => {
    expect(await calculatePreviewFarmlandValuation(details({
      use_direct_comparable: false, use_income_approach: false, use_cost_approach: false,
    }), {}, [comparable])).toBeNull();
    expect(calculateCostApproachAI).not.toHaveBeenCalled();
  });

  it("retains legacy default 70/30 and rental behavior for payloads without flags", async () => {
    const legacy = details();
    const result = await calculatePreviewFarmlandValuation(legacy, {}, [comparable]);
    expect(result?.fair_market_value).toBe(107632);
    expect(result?.income_capitalization?.market_rent_per_acre).toBe(80);
    const rented = await calculatePreviewFarmlandValuation(details({ is_rented: true, annual_rent_per_acre: 100 }), {}, [comparable]);
    expect(rented?.income_capitalization?.market_rent_per_acre).toBe(100);
  });

  it("preserves explicit zero rent, loss and expense values and the subject/date/notes", async () => {
    const result = await calculatePreviewFarmlandValuation(details({
      use_income_approach: true, market_rent_per_acre: 0, annual_rent_per_acre: 500,
      subject_name: "Named farm", valuation_date: "2026-08-15", notes: "User notes",
    }), {}, []);
    expect(result).toMatchObject({ subject_name: "Named farm", notes: "User notes", fair_market_value: 0,
      income_capitalization: { market_rent_per_acre: 0, vacancy_loss_percent: 0, operating_expense_ratio: 0, cap_rate: 10 } });
    expect(result?.valuation_date.toISOString()).toBe("2026-08-15T00:00:00.000Z");
  });

  it("preserves zero acreage for a direct-only subject without substituting defaults", async () => {
    const result = await calculatePreviewFarmlandValuation(details({
      use_direct_comparable: true, cultivated_acres: 0, total_title_acres: 0,
    }), {}, []);
    expect(result).toMatchObject({ cultivated_acres: 0, total_title_acres: 0, fair_market_value: 0 });
    expect(result?.income_capitalization).toBeUndefined();
    expect(result?.reconciliation).toMatchObject({ income_value: 0, income_weighted: 0, final_reconciled_value: 0 });
    const assertFiniteNumbers = (value: unknown): void => {
      if (typeof value === "number") expect(Number.isFinite(value)).toBe(true);
      else if (value && typeof value === "object") Object.values(value).forEach(assertFiniteNumbers);
    };
    assertFiniteNumbers(result);
  });

  it("rejects non-finite comparable calculations rather than persisting NaN", async () => {
    await expect(calculatePreviewFarmlandValuation(details({ use_direct_comparable: true }), {}, [
      { ...comparable, distance_km: Number.NaN },
    ])).rejects.toThrow("finite result");
  });

  it.each([{ cap_rate: 0 }, { cap_rate: -1 }, { cultivated_acres: 0 }, { vacancy_loss_percent: 101 }])("rejects invalid income input %j rather than defaulting it", async (invalid) => {
    await expect(calculatePreviewFarmlandValuation(details({ use_income_approach: true, ...invalid }), {}, [])).rejects.toThrow();
  });

  it("does not publish a partial value if the selected cost method fails", async () => {
    vi.mocked(calculateCostApproachAI).mockRejectedValue(new Error("Cost unavailable"));
    await expect(calculatePreviewFarmlandValuation(details({ use_direct_comparable: true, use_cost_approach: true }), {}, [comparable])).rejects.toThrow("Cost unavailable");
  });

  it("persists selected valuation through the actual preview job without generating artifacts", async () => {
    const owner = new mongoose.Types.ObjectId();
    const file = (name: string) => ({ originalname: name, mimetype: "image/jpeg", buffer: Buffer.from(name) } as Express.Multer.File);
    await runRealEstatePreviewJob({
      user: { id: String(owner) }, images: [file("main.jpg")], extraImages: [file("map.jpg")],
      details: { ...details({ use_income_approach: true, use_cost_approach: true }), user: String(new mongoose.Types.ObjectId()) },
    });
    const report = await RealEstateReport.findOne({ user: owner }).lean();
    expect(report?.preview_data.farmland_valuation).toMatchObject({ fair_market_value: 140000,
      approaches_used: { direct_comparable: false, income_capitalization: true, cost_approach: true } });
    expect(report?.preview_data.fair_market_value).toContain("140,000");
    expect(report?.status).toBe("preview");
    expect(report?.imageUrls).toHaveLength(1);
    expect(report?.extraImageUrls).toHaveLength(1);
    expect(report?.imageUrls[0]).toMatch(/^https:\/\/assetinsight\.test\//);
    expect(report?.preview_files?.docx).toBeUndefined();
    expect(report?.preview_data.valuation_warning).toBeUndefined();
  });

  it("persists a safe preview warning when a selected method fails without provider details or a partial estimate", async () => {
    vi.mocked(calculateCostApproachAI).mockRejectedValue(new Error("PRIVATE_PROVIDER_DETAILS"));
    const owner = new mongoose.Types.ObjectId();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runRealEstatePreviewJob({ user: { id: String(owner) }, images: [],
        details: details({ use_direct_comparable: true, use_cost_approach: true }) });
    } finally {
      log.mockRestore();
    }
    const report = await RealEstateReport.findOne({ user: owner }).lean();
    expect(report?.preview_data.valuation_warning).toContain("could not be completed");
    expect(report?.preview_data.valuation_warning).not.toContain("PRIVATE_PROVIDER_DETAILS");
    expect(report?.preview_data.farmland_valuation).toBeNull();
    expect(report?.preview_data.fair_market_value).toBe("");
    expect(report?.status).toBe("preview");
  });

  it("explains an explicitly unselected valuation in the preview", async () => {
    const owner = new mongoose.Types.ObjectId();
    await runRealEstatePreviewJob({ user: { id: String(owner) }, images: [], details: details({
      use_direct_comparable: false, use_income_approach: false, use_cost_approach: false,
    }) });
    const report = await RealEstateReport.findOne({ user: owner }).lean();
    expect(report?.preview_data.valuation_warning).toContain("No valuation approach was selected");
    expect(report?.preview_data.fair_market_value).toBe("");
  });
});

describe("real estate authenticated report ownership", () => {
  it.each(["sync", "legacy-job"])("ignores details.user in %s creation before generating artifacts", async (path) => {
    const owner = new mongoose.Types.ObjectId();
    const untrustedOwner = new mongoose.Types.ObjectId();
    const input = { user: String(untrustedOwner), property_type: "residential", property_details: {}, house_details: {} };
    let savedOwner: string | undefined;
    const save = vi.spyOn(RealEstateReport.prototype, "save").mockImplementation(function (this: any) {
      savedOwner = String(this.user);
      return Promise.reject(new Error("TEST_STOP_BEFORE_ARTIFACTS"));
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      if (path === "sync") {
        const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
        await createRealEstate({ user: { _id: owner }, body: { details: JSON.stringify(input) }, files: [] } as any, response as any);
        expect(response.status).toHaveBeenCalledWith(500);
      } else {
        await expect(runRealEstateReportJob({ user: { id: String(owner) }, images: [], details: input })).rejects.toThrow("TEST_STOP_BEFORE_ARTIFACTS");
      }
      expect(save).toHaveBeenCalledOnce();
      expect(savedOwner).toBe(String(owner));
      expect(savedOwner).not.toBe(String(untrustedOwner));
    } finally {
      save.mockRestore();
      log.mockRestore();
      error.mockRestore();
    }
  });
});

describe("real estate preview API compatibility", () => {
  it.each([getPreviewData, getSubmittedPreviewData])("returns canonical agricultural type, media and generation flags (%s)", async (handler) => {
    const owner = new mongoose.Types.ObjectId();
    const report = await RealEstateReport.create({
      user: owner, status: "pending_approval", property_details: { property_type: "commercial" },
      preview_data: { property_type: "agricultural" }, files_generating: true, files_regenerating: true,
      imageUrls: ["https://assetinsight.test/main.jpg"], extraImageUrls: ["https://assetinsight.test/map.jpg"],
    });
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler({ params: { id: String(report._id) }, userId: String(owner) } as any, response as any);
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      property_type: "agricultural", files_generating: true, files_regenerating: true,
      image_count: 1, extra_image_count: 1,
    }) }));
  });

  it.each([getPreviewData, getSubmittedPreviewData])("retains old property-details type and false flags (%s)", async (handler) => {
    const owner = new mongoose.Types.ObjectId();
    const report = await RealEstateReport.create({ user: owner, status: "approved", property_details: { property_type: "commercial" } });
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await handler({ params: { id: String(report._id) }, userId: String(owner) } as any, response as any);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      property_type: "commercial", files_generating: false, files_regenerating: false,
    }) }));
  });
});
