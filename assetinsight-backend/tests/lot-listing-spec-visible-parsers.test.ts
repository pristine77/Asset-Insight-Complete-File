import { describe, expect, it, vi } from "vitest";

/*
 * Two layers infer specs from a lot's own text: the picture-only enrichment
 * pass, and the renderer's fallback that runs for every row with no stored
 * value — and whose result the closing normalization then persists. A loose
 * pattern in either does not just miss a value, it writes garbage into the
 * appraiser's condition report. "Runs and drives" is about the most common
 * sentence in one, and it used to yield a Drive Type of "s. 2".
 *
 * The rule under test: a bare label ("Drive", "Transmission", "Fuel") counts
 * only when a separator follows it; unlabelled prose is read by each field's
 * vocabulary pattern instead (4x4, automatic, diesel, ...).
 */

vi.mock("../src/utils/openaiClient.js", () => ({
  default: { responses: { create: vi.fn() } },
}));
vi.mock("../src/service/systemSettingsService.js", () => ({
  isAuctioneerSpecWebSearchEnabled: vi.fn(async () => false),
}));
vi.mock("../src/service/vehicleApiService.js", () => ({
  enrichLotsWithVin: vi.fn(async (lots: any[]) => lots),
  applyVinModelYearFallback: vi.fn((lots: any[]) => lots),
  extractVinFromText: vi.fn(() => ""),
}));

import { enrichLotListingSpecs } from "../src/service/lotListingSpecEnrichmentService.js";
import { assetCategorySpecs } from "../src/utils/assetCategorySpecs.js";

/**
 * A parser only runs for fields its category defines, so each case names the
 * fields it needs and lets the generated workbook choose the category. A
 * hard-coded category would silently stop testing anything if its field list
 * changed.
 */
function categoryWith(...required: string[]): string {
  const spec = assetCategorySpecs.find((candidate) =>
    required.every((field) => candidate.fields.includes(field))
  );
  if (!spec) throw new Error(`No category defines ${required.join(", ")}`);
  return spec.childCategory;
}

const HOURS = "Hours (Showing Unverified)";

const infer = async (
  description: string,
  categories: string
): Promise<Record<string, string>> => {
  const result = await enrichLotListingSpecs({
    mode: "pictureOnly",
    lots: [
      {
        lot_number: "826",
        title: "2019 Kenworth T800",
        description,
        categories,
        condition_report_specs: {},
      },
    ],
  });
  return result.lots[0]?.condition_report_specs ?? {};
};

describe("Drive Type inference", () => {
  const category = categoryWith("Drive Type", HOURS);

  it("does not read the word 'drives' as a drive type", async () => {
    const specs = await infer("Runs and drives. 2,450 hours showing.", category);

    expect(specs).not.toHaveProperty("Drive Type");
    // The sentence still yields the value it does carry.
    expect(specs[HOURS]).toMatch(/^2,?450(?:\s|$)/);
  });

  it("reads a labelled drive type", async () => {
    expect((await infer("Drive Type: 4x4, clean unit.", category))["Drive Type"]).toMatch(/4x4/i);
    expect((await infer("Drive: AWD. Clean unit.", category))["Drive Type"]).toMatch(/awd/i);
  });

  it("reads a drive type described in prose through its vocabulary", async () => {
    expect((await infer("Front wheel drive, clean unit.", category))["Drive Type"]).toMatch(
      /front wheel drive/i
    );
  });
});

describe("Transmission Type inference", () => {
  const category = categoryWith("Transmission Type");

  it("does not store a sentence about the transmission as its type", async () => {
    const specs = await infer("Transmission slips under load. Runs and drives.", category);

    expect(specs).not.toHaveProperty("Transmission Type");
  });

  it("reads a labelled transmission type", async () => {
    expect(
      (await infer("Transmission: Automatic. Clean unit.", category))["Transmission Type"]
    ).toMatch(/automatic/i);
  });

  it("reads an unlabelled transmission through its vocabulary", async () => {
    expect(
      (await infer("Six speed manual gearbox, clean unit.", category))["Transmission Type"]
    ).toMatch(/manual/i);
  });
});

describe("Fuel Type inference", () => {
  const category = categoryWith("Fuel Type");

  it("does not read the word 'fuels' as a fuel type", async () => {
    const specs = await infer("Dual tanks, fuels from either side. Runs and drives.", category);

    expect(specs["Fuel Type"] ?? "").not.toMatch(/from either side/i);
  });

  it("reads a labelled fuel type", async () => {
    expect((await infer("Fuel: Diesel. Clean unit.", category))["Fuel Type"]).toMatch(/diesel/i);
  });

  it("reads an unlabelled fuel through its vocabulary", async () => {
    expect((await infer("Runs on diesel, clean unit.", category))["Fuel Type"]).toMatch(/diesel/i);
  });
});
