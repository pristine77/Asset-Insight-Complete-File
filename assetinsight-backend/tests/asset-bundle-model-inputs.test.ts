import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeBundle } from "../src/service/assetOpenAIService/bundle.js";

const { createResponse, convertImage, getSystemPrompt } = vi.hoisted(() => ({
  createResponse: vi.fn(),
  convertImage: vi.fn(),
  getSystemPrompt: vi.fn(() => "existing-system-prompt"),
}));
vi.mock("../src/utils/openaiClient.js", () => ({
  default: { responses: { create: createResponse } },
}));
vi.mock("../src/service/assetOpenAIService/imageUtils.js", () => ({
  imageUrlToBase64WithMime: convertImage,
}));
vi.mock("../src/utils/assetPrompts.js", () => ({
  getAssetSystemPrompt: getSystemPrompt,
}));

beforeEach(() => {
  vi.clearAllMocks();
  createResponse.mockResolvedValue({ output_text: JSON.stringify({ lots: [] }) });
  convertImage.mockImplementation(async (url: string) => ({
    base64: Buffer.from(url).toString("base64"), mime: "image/jpeg",
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Bundle model input preparation", () => {
  it("does not call the provider for an empty image list", async () => {
    expect(await analyzeBundle([], "single_lot", "en", "CAD")).toEqual({
      lots: [], language: "en", currency: "CAD",
    });
    expect(convertImage).not.toHaveBeenCalled();
    expect(createResponse).not.toHaveBeenCalled();
  });

  it("identifies first/last roles while preserving sampled input indexes and all model results", async () => {
    const source = ["photo-1", "photo-2", "photo-104"];
    const lots = [{ lot_number: "157", image_indexes: [0, 2], specs: { serial: "ABC123" } }];
    createResponse.mockResolvedValue({ output_text: JSON.stringify({
      lots, summary: "Trailer", language: "en", currency: "CAD",
    }) });
    expect(await analyzeBundle(source, "single_lot", "en", "CAD", false)).toEqual({
      lots, summary: "Trailer", language: "en", currency: "CAD",
    });
    const request = createResponse.mock.calls[0]![0];
    expect(request.instructions).toBe("existing-system-prompt");
    expect(getSystemPrompt).toHaveBeenCalledWith("single_lot", "en", "CAD", false);
    const content = request.input[0].content;
    const text = content.filter((part: any) => part.type === "input_text").map((part: any) => part.text).join("\n");
    expect(text).toContain("#0: photo-1\n#1: photo-2\n#2: photo-104");
    expect(text).toContain("first supplied image is the original first main photo");
    expect(text).toContain("final supplied image is the original last main photo");
    expect(text).toContain("serial-number/VIN reference");
    expect(text).toContain("only from readable evidence");
    expect(text).toContain("zero-based");
    expect(content.filter((part: any) => part.type === "input_image")).toEqual(source.map((url) => ({
      type: "input_image", image_url: `data:image/jpeg;base64,${Buffer.from(url).toString("base64")}`, detail: "high",
    })));
    expect(source).toEqual(["photo-1", "photo-2", "photo-104"]);
  });

  it("keeps catalogue instructions free of Bundle positional identity assumptions", async () => {
    await analyzeBundle(["photo-1", "photo-2"], "catalogue", "en", "CAD");
    const content = createResponse.mock.calls[0]![0].input[0].content;
    expect(content.filter((part: any) => part.type === "input_text")).toHaveLength(1);
    expect(content[0].text).toContain("Grouping mode: catalogue");
    expect(content[0].text).not.toContain("lot-number reference");
    expect(content[0].text).not.toContain("serial-number/VIN reference");
  });

  it.each([
    [undefined, 4], ["100", 4], ["2", 2], ["0", 4], ["invalid", 4],
  ])("bounds image preparation with ASSET_AI_IMAGE_CONCURRENCY=%s and preserves order", async (setting, expected) => {
    vi.stubEnv("ASSET_AI_IMAGE_CONCURRENCY", setting);
    let active = 0;
    let peak = 0;
    const source = Array.from({ length: 100 }, (_, index) => `photo-${index}`);
    const completionOrder: string[] = [];
    convertImage.mockImplementation(async (url: string) => {
      active += 1;
      peak = Math.max(peak, active);
      const index = Number(url.split("-")[1]);
      await new Promise((resolve) => setTimeout(resolve, index % 2 === 0 ? 2 : 0));
      completionOrder.push(url);
      active -= 1;
      return { base64: Buffer.from(url).toString("base64"), mime: "image/jpeg" };
    });
    await analyzeBundle(source, "single_lot", "en", "CAD");
    expect(peak).toBe(expected);
    expect(active).toBe(0);
    expect(completionOrder).toHaveLength(100);
    const content = createResponse.mock.calls[0]![0].input[0].content;
    const sent = content.filter((part: any) => part.type === "input_image").map((part: any) =>
      Buffer.from(part.image_url.split(",")[1], "base64").toString(),
    );
    expect(sent).toEqual(source);
  });

  it("rejects an oversized Bundle request before provider use without dropping photos", async () => {
    const byteLength = Buffer.byteLength;
    vi.spyOn(Buffer, "byteLength").mockImplementation((value: any, encoding?: any) =>
      value === "oversized-fixture" ? 129 * 1024 * 1024 : byteLength(value, encoding),
    );
    convertImage.mockResolvedValue({ base64: "oversized-fixture", mime: "image/jpeg" });
    const source = ["lot-sticker", "serial-photo"];
    await expect(analyzeBundle(source, "single_lot", "en", "CAD")).rejects.toThrow("safe encoded request size");
    expect(createResponse).not.toHaveBeenCalled();
    expect(source).toEqual(["lot-sticker", "serial-photo"]);
  });

  it("does not impose the new Bundle payload guard on catalogue mode", async () => {
    const byteLength = Buffer.byteLength;
    vi.spyOn(Buffer, "byteLength").mockImplementation((value: any, encoding?: any) =>
      value === "oversized-fixture" ? 129 * 1024 * 1024 : byteLength(value, encoding),
    );
    convertImage.mockResolvedValue({ base64: "oversized-fixture", mime: "image/jpeg" });
    await analyzeBundle(["catalogue-photo"], "catalogue", "en", "CAD");
    expect(createResponse).toHaveBeenCalledOnce();
  });
});
