import axios from "axios";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ chat: vi.fn(), responses: vi.fn() }));
vi.mock("../src/utils/openaiClient.js", () => ({ default: { chat: { completions: { create: mocks.chat } }, responses: { create: mocks.responses } } }));
import { analyzeSalvageImages } from "../src/service/salvageOpenAIService.js";
import { findComparableSalvageItems } from "../src/service/salvageWebSearchService.js";
import { calculateSalvageValue } from "../src/service/salvageValuationService.js";
import { prepareSalvagePhotos } from "../src/service/salvageImagePreparation.js";

const assessment = { item_type: "Truck", item_condition: "Visible front damage", damage_description: "Dent", is_repairable: "Unknown",
  repair_estimate: { parts_items: [{ name: "Panel", quantity: 2, unit_price: 40, line_total: 999 }], labour_breakdown: [] } };
const chatResponse = (result: unknown) => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }] });
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("Salvage image analysis", () => {
  it("prepares all 30 images with at most four active downloads, preserving order and JPEG MIME", async () => {
    const png = await sharp({ create: { width: 64, height: 32, channels: 3, background: '#1557ed' } }).png().toBuffer();
    let active = 0, peak = 0;
    const download = vi.spyOn(axios, "get").mockImplementation(async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2)); active -= 1;
      return { data: png };
    });
    const urls = Array.from({ length: 30 }, (_, i) => `https://assetinsight.test/photo-${i}.png`);
    mocks.chat.mockResolvedValue(chatResponse(assessment));
    vi.stubEnv("OPENAI_PRIMARY_MODEL", "fixture-shared-model");
    const result = await analyzeSalvageImages(urls, "fr", "EUR", { vin: "REVIEWED-VIN", item_model: "User model", appraiser_email: "private@example.test" });
    expect(peak).toBeLessThanOrEqual(4);
    expect(download.mock.calls.map(([url]) => url)).toEqual(urls);
    expect(download.mock.calls[0][1]).toMatchObject({ timeout: 30000, maxContentLength: 30 * 1024 * 1024 });
    const request = mocks.chat.mock.calls[0][0];
    expect(request.model).toBe("fixture-shared-model");
    const photos = request.messages[1].content.filter((item: any) => item.type === "image_url");
    expect(photos).toHaveLength(30);
    expect(photos.every((photo: any) => photo.image_url.url.startsWith('data:image/jpeg;base64,') && photo.image_url.detail === 'high')).toBe(true);
    expect(JSON.stringify(request)).toContain("REVIEWED-VIN");
    expect(JSON.stringify(request)).not.toContain("private@example.test");
    expect(result.repair_estimate.total).toBe(80);
    expect(result.is_repairable).toBe("To Be Determined");
    expect(urls).toHaveLength(30);
  });

  it("does not discard photos when conversion fails and does not leak storage URLs", async () => {
    vi.spyOn(axios, "get").mockResolvedValue({ data: Buffer.from("invalid") });
    await expect(analyzeSalvageImages(["https://assetinsight.test/private?token=secret"])).rejects.toThrow("Original photos are retained");
    expect(mocks.chat).not.toHaveBeenCalled();
  });

  it("rejects zero and over-limit images before any provider call", async () => {
    await expect(analyzeSalvageImages([])).rejects.toThrow("No image URLs");
    await expect(prepareSalvagePhotos(Array(51).fill("unused"))).rejects.toThrow("at most 50");
    expect(mocks.chat).not.toHaveBeenCalled();
  });

  it.each([null, [], {}, { item_type: "Truck", repair_estimate: [] }])("rejects invalid model data %j", async (result) => {
    const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#fff' } }).png().toBuffer();
    vi.spyOn(axios, "get").mockResolvedValue({ data: png });
    mocks.chat.mockResolvedValue(chatResponse(result));
    await expect(analyzeSalvageImages(["https://assetinsight.test/photo.png"])).rejects.toThrow("Failed to analyze");
  });
});

describe("Salvage comparable evidence and valuation", () => {
  it("accepts only attributable unique listings and retains the existing shared model", async () => {
    vi.stubEnv("OPENAI_PRIMARY_MODEL", "fixture-shared-model");
    mocks.responses.mockResolvedValue({ status: "completed", output_text: JSON.stringify([
      { title: "Verified listing", link: "https://market.example.test/lot/1", price: "CAD 4000", price_numeric: 4000, currency: "CAD" },
      { title: "Duplicate listing", link: "https://market.example.test/lot/1" },
      { title: "Invented listing", link: "https://market.example.test/missing" },
      { title: "Unsafe link", link: "javascript:alert(1)" },
    ]), output: [{ type: "web_search_call", action: { sources: [{ type: "url", url: "https://market.example.test/lot/1" }] } }] });
    const result = await findComparableSalvageItems({ item_type: "Truck", year: "2010", make: "Ford", item_model: "F150" });
    expect(result).toHaveLength(1);
    expect(result[0].price_numeric).toBe(4000);
    expect(mocks.responses.mock.calls[0][0]).toMatchObject({ model: "fixture-shared-model", include: ["web_search_call.action.sources"] });
  });

  it("does not request comparables with no usable subject identity", async () => {
    expect(await findComparableSalvageItems({ item_type: "Not Found", year: "", make: "", item_model: "" })).toEqual([]);
    expect(mocks.responses).not.toHaveBeenCalled();
  });

  it("does not invent a value when no priced comparable evidence exists", async () => {
    const value = await calculateSalvageValue("Damaged truck", [], { language: "fr", currency: "EUR" });
    expect(value.fairMarketValue).toBe("Unavailable");
    expect(value.confidence_level).toBe("Low");
    expect(value.summary).toContain("évaluateur");
    expect(mocks.chat).not.toHaveBeenCalled();
  });

  it("passes language/currency evidence and rejects malformed valuation output", async () => {
    const comparable = { link: "https://market.example.test/lot/1", price_numeric: 4000, currency: "CAD" };
    mocks.chat.mockResolvedValue(chatResponse({ fairMarketValue: "CAD 2500", confidence_level: "Low", summary: "Damage adjustment requires review." }));
    const value = await calculateSalvageValue("Damaged truck", [comparable], { language: "es", currency: "CAD" });
    expect(value.fairMarketValue).toBe("CAD 2500");
    expect(mocks.chat.mock.calls[0][0].messages[0].content).toContain("Use es for the summary");
    mocks.chat.mockResolvedValue(chatResponse({ fairMarketValue: "5000", confidence_level: "Definitely" }));
    await expect(calculateSalvageValue("Truck", [comparable])).rejects.toThrow("Failed to calculate");
  });
});
