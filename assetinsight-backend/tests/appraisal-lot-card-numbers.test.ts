/**
 * Appraisal lot numbers (owner, 2026-11-03). Tanner's appraisal 95131 came out
 * with random and repeated lot numbers: the AI took a number from anything in
 * the photos and nothing checked for repeats. The owner chose: "Use a number
 * only when a lot-number card is photographed; every other lot gets the next
 * number in capture order. Never two lots with the same number in one report."
 * See src/jobs/assetReportJob/lotOrdering.ts.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  keepLotCardNumbersOnly,
  lotNumberIsFromLotCard,
  normalizeLotsForReportOrdering,
} from "../src/jobs/assetReportJob/lotOrdering.js";
import { initialLotNumberFallbackIndexes, markInitialLotNumberFallback } from "../src/service/initialLotNumberProvenance.js";
import { lotItemSchema } from "../src/service/assetOpenAIService/schemas.js";

/** The first analysis, as previewJob numbers it. */
const firstAnalysis = (lots: any[], mode = "mixed") =>
  normalizeLotsForReportOrdering(keepLotCardNumbersOnly(lots).map(markInitialLotNumberFallback), mode, { includeMixed: true });

const card = (lot_number: string, extra: Record<string, unknown> = {}) => ({ lot_number, lot_number_source: "lot_card", ...extra });
const sticker = (lot_number: string) => ({ lot_number, lot_number_source: "none" });

describe("an appraisal's lot numbers", () => {
  it("numbers lots without a lot card in the order they were photographed", () => {
    const lots = firstAnalysis([sticker("2008"), sticker("101"), { lot_number: null, lot_number_source: "none" }]);
    expect(lots.map(lot => lot.lot_number)).toEqual(["1", "2", "3"]);
    expect(lots[0].analysis_metadata.lot_number_dropped).toMatchObject({ value: "2008", reason: "not_a_lot_card" });
  });

  it("keeps a number read from a lot card, and fills around it", () => {
    const lots = firstAnalysis([sticker("55"), card("2"), sticker("9")]);
    expect(lots.map(lot => lot.lot_number)).toEqual(["1", "2", "3"]);
    expect(lots[1].analysis_metadata?.lot_number_dropped).toBeUndefined();
  });

  it("never gives two lots the same number", () => {
    const lots = firstAnalysis([card("7"), card("7"), card("7")]);
    expect(lots.map(lot => lot.lot_number)).toEqual(["7", "1", "2"]);
    expect(lots[1].analysis_metadata.lot_number_dropped.reason).toBe("repeated");
    expect(new Set(lots.map(lot => lot.lot_number)).size).toBe(3);
  });

  it("treats the bundle lot-number photo and a reviewed Lot Number Upload as lot cards", () => {
    const detected = (numberSource: string) => ({ lot_number: "40", analysis_metadata: { bundle_lot_number_detection: { numberSource } } });
    expect(lotNumberIsFromLotCard(detected("first_main_photo"))).toBe(true);
    expect(lotNumberIsFromLotCard(detected("last_main_photo"))).toBe(true);
    expect(lotNumberIsFromLotCard(detected("reviewed_upload"))).toBe(true);
    expect(lotNumberIsFromLotCard(detected("sequential_fallback"))).toBe(false);
    expect(lotNumberIsFromLotCard({ lot_number: "40" })).toBe(false);
  });

  it("does not pass the AI's source on as a lot field", () => {
    const [lot] = keepLotCardNumbersOnly([card("3")]);
    expect(lot).not.toHaveProperty("lot_number_source");
    expect(lot.lot_number).toBe("3");
  });

  it("gives a cleared lot the next number in the sale on an Auctioneer 2.0 contract", () => {
    const lots = firstAnalysis([card("12"), sticker("12")]);
    expect(initialLotNumberFallbackIndexes(lots)).toEqual([1]);
  });

  it("leaves a mixed report alone when its files are regenerated", () => {
    const reviewed = [{ lot_number: null }, { lot_number: "8" }];
    expect(normalizeLotsForReportOrdering(reviewed, "mixed")).toBe(reviewed);
  });
});

describe("what the AI is asked", () => {
  it("must say where each lot number came from", () => {
    expect(lotItemSchema.properties.lot_number_source).toEqual({ type: "string", enum: ["lot_card", "none"] });
    expect(lotItemSchema.required).toContain("lot_number_source");
  });

  it("is shown no sample lot numbers to copy", () => {
    const prompt = readFileSync(new URL("../src/utils/assetPrompts.ts", import.meta.url), "utf8");
    expect(prompt).not.toMatch(/"lot_number":\s*"\d+"/);
  });

  it("reads staff lot stickers and tags, never the item's own markings", () => {
    // Owner 2026-11-03: "Yes, lot stickers count".
    const prompt = readFileSync(new URL("../src/utils/assetPrompts.ts", import.meta.url), "utf8");
    expect(prompt).toContain("a lot-number sticker or tag staff put on the item");
    expect(prompt).toContain("The item's own markings are never lot numbers: manufacturer decals and labels, unit or fleet numbers, model or serial numbers");
    expect(prompt).not.toContain("Numbers on the item itself are never lot numbers: stickers");
  });
});
