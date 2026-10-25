import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateMixedDocx: vi.fn(),
  generateRealEstateDocx: vi.fn(),
  prefetchImages: vi.fn(),
  clearImageCache: vi.fn(),
}));

vi.mock("../src/service/docx/mixedDocxBuilder.js", () => ({
  generateMixedDocx: mocks.generateMixedDocx,
}));

vi.mock("../src/service/docx/realEstateDocxBuilder.js", () => ({
  generateRealEstateDocx: mocks.generateRealEstateDocx,
}));

vi.mock("../src/service/docx/builders/utils.js", () => ({
  createSimpleHeadingDocx: vi.fn(),
  prefetchImages: mocks.prefetchImages,
  clearImageCache: mocks.clearImageCache,
}));

import { generateAssetDocxFromReport } from "../src/service/assetDocxService.js";
import { generateRealEstateDocxFromReport } from "../src/service/realEstateDocxService.js";
import { shouldUseGroupDocsMerge } from "../src/utils/docxMergeMode.js";
import {
  formatErrorSummary,
  summarizeError,
} from "../src/utils/errorSummary.js";

beforeEach(() => {
  delete process.env.REPORT_DOCX_MERGE_MODE;
  vi.clearAllMocks();
});

describe("DOCX generation mode", () => {
  it("only enables the cloud merger when explicitly requested", () => {
    expect(shouldUseGroupDocsMerge(undefined)).toBe(false);
    expect(shouldUseGroupDocsMerge("local")).toBe(false);
    expect(shouldUseGroupDocsMerge(" GroupDocs ")).toBe(true);
  });

  it("generates Asset DOCX locally with the native cover by default", async () => {
    const expected = Buffer.from("asset-docx");
    mocks.generateMixedDocx.mockResolvedValue(expected);
    mocks.prefetchImages.mockResolvedValue(undefined);

    const result = await generateAssetDocxFromReport({
      custom_cover: true,
      imageUrls: ["https://images.example.test/one.jpg"],
      lots: [],
    });

    expect(result).toBe(expected);
    expect(mocks.prefetchImages).toHaveBeenCalledWith([
      "https://images.example.test/one.jpg",
    ]);
    expect(mocks.generateMixedDocx).toHaveBeenCalledWith(
      expect.objectContaining({ custom_cover: false })
    );
    expect(mocks.clearImageCache).toHaveBeenCalledTimes(1);
  });

  it("generates Real Estate DOCX locally with the native cover by default", async () => {
    const expected = Buffer.from("real-estate-docx");
    mocks.generateRealEstateDocx.mockResolvedValue(expected);

    const result = await generateRealEstateDocxFromReport({
      custom_cover: true,
    });

    expect(result).toBe(expected);
    expect(mocks.generateRealEstateDocx).toHaveBeenCalledWith(
      expect.objectContaining({ custom_cover: false })
    );
    expect(mocks.clearImageCache).toHaveBeenCalledTimes(1);
  });
});

describe("safe error summaries", () => {
  it("keeps useful provider details without serializing request secrets", () => {
    const error = {
      message: "Request failed",
      response: {
        status: 429,
        data: {
          message: "API call quota reached",
          code: "accessRestricted",
        },
      },
      config: {
        headers: { Authorization: "Bearer secret" },
        data: { token: "private-push-token" },
      },
    };

    expect(summarizeError(error)).toEqual({
      message: "API call quota reached",
      code: "accessRestricted",
      status: "429",
    });
    expect(formatErrorSummary(error)).toBe(
      "API call quota reached | code=accessRestricted | status=429"
    );
    expect(JSON.stringify(summarizeError(error))).not.toContain("secret");
    expect(JSON.stringify(summarizeError(error))).not.toContain(
      "private-push-token"
    );
  });
});
