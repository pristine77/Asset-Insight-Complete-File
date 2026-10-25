import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SAVE_PREVIEW_TITLE } from "./previewSave";

describe("preview Save policy", () => {
  it("explains file rebuilds without an AI reread", () => {
    expect(SAVE_PREVIEW_TITLE).toContain("rebuilds the Excel, PDF and Word files");
    expect(SAVE_PREVIEW_TITLE).toContain("Photos are not re-read by the AI");
  });

  it("does not retain per-lot AI request methods, hooks or controls", () => {
    const root = resolve(import.meta.dirname, "..");
    for (const file of ["services/assets.ts", "services/lotListing.ts", "components/reports/PreviewModal.tsx", "components/reports/LotListingPreviewModal.tsx"]) {
      expect(readFileSync(resolve(root, file), "utf8")).not.toMatch(/regenerateAssetPreviewLot|regenerateLotListingPreviewLot|useLotRegeneration|lot_regeneration|Re-Generate lot|\/lots\/.*\/regenerate/);
    }
    expect(existsSync(resolve(root, "components/reports/useLotRegeneration.ts"))).toBe(false);
    expect(existsSync(resolve(root, "lib/lotRegeneration.ts"))).toBe(false);
    expect(readFileSync(resolve(root, "components/reports/FloatingPhotoViewer.tsx"), "utf8")).not.toMatch(/onRemove|Trash2|Remove photo|Delete photo/);
  });
});
