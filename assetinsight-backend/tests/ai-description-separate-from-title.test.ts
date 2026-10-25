/*
 * Title and Description are separate fields (owner decision 2026-10-11).
 * The AI used to be told to write the Description as a 60-character
 * "title-style phrase", so every new lot came back with the Title repeated in
 * the Description. It now writes the Title as the headline and the
 * Description as one or two sentences, up to 250 characters, and the
 * AI-ingress normalizer cuts at 250 instead of 60.
 */
import { describe, expect, it } from "vitest";
import { getAssetSystemPrompt } from "../src/utils/assetPrompts.js";
import {
  AUCTION_DESCRIPTION_MAX_LENGTH,
  truncateAuctionDescription,
} from "../src/utils/previewLotNormalization.js";

const MODES = ["single_lot", "per_item", "per_photo"] as const;

describe("AI description is separate from the title", () => {
  it("allows 250 characters", () => {
    expect(AUCTION_DESCRIPTION_MAX_LENGTH).toBe(250);
  });

  it.each(MODES)("tells the AI in %s mode to write a real description, not a second title", (mode) => {
    const prompt = getAssetSystemPrompt(mode, "en", "CAD", true);
    expect(prompt).not.toMatch(/60 characters|max 60|title-style/i);
    expect(prompt).toContain("maximum 250 characters");
    expect(prompt).toMatch(/must not repeat (it|the title)/);
    expect(prompt).toContain("never repeat the title as the description");
    expect(prompt).not.toContain("${AUCTION_DESCRIPTION_MAX_LENGTH}");
  });

  it("keeps the example descriptions different from their titles", () => {
    for (const mode of MODES) {
      const prompt = getAssetSystemPrompt(mode, "en", "CAD", true);
      const pairs = [...prompt.matchAll(/"title": "([^"]+)",\s*\n\s*"description": "([^"]+)"/g)];
      for (const [, title, description] of pairs) {
        if (title === "short but specific title") continue;
        expect(description).not.toBe(title);
        expect(description.length).toBeLessThanOrEqual(AUCTION_DESCRIPTION_MAX_LENGTH);
      }
    }
  });

  it("keeps an AI description of up to 250 characters whole", () => {
    const description =
      "Bi-fuel fueling trailer with Frac Shack FracFueller enclosure, fuel manifold, pump, hoses, " +
      "fittings and a portable ramp platform; sold with the related accessories shown in the photos";
    expect(description.length).toBeGreaterThan(60);
    expect(description.length).toBeLessThanOrEqual(250);
    expect(truncateAuctionDescription(description)).toBe(description);
  });

  it("cuts a longer AI description at a word boundary within 250 characters", () => {
    const description = "Galvanized livestock gate with chain latch and hinge pins. ".repeat(6).trim();
    const cut = truncateAuctionDescription(description);
    expect(description.length).toBeGreaterThan(250);
    expect(cut.length).toBeLessThanOrEqual(250);
    expect(description.startsWith(cut)).toBe(true);
    expect(description.charAt(cut.length)).toMatch(/\s/);
  });
});
