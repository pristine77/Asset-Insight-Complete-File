import { beforeEach, describe, expect, it, vi } from "vitest";
const output = vi.hoisted(() => ({ html: "" }));
vi.mock("puppeteer", () => ({ default: { launch: vi.fn(async () => ({
  close: async () => undefined,
  newPage: async () => ({
    setDefaultTimeout: () => undefined, setDefaultNavigationTimeout: () => undefined,
    setJavaScriptEnabled: async () => undefined, setRequestInterception: async () => undefined,
    on: () => undefined, emulateMediaType: async () => undefined,
    setContent: async (html: string) => { output.html = html; },
  }),
})) } }));
vi.mock("../src/service/salvagePdfLayout.js", async (original) => ({
  ...(await original<typeof import("../src/service/salvagePdfLayout.js")>()),
  renderSalvagePdfWithContents: async () => Buffer.from("isolated-PDF-layout"),
}));
import { generateSalvagePdfFromReport } from "../src/service/salvagePdfService.js";
import { buildSalvageAssessment } from "../src/service/salvageAssessment.js";

beforeEach(() => { output.html = ""; });
const source = (patch: Record<string, any> = {}) => ({ file_number: "FINANCIAL-OUTPUT", appraiser_name: "Test Appraiser", company_name: "Insurer", language: "en", currency: "CAD", item_type: "Truck", actual_cash_value: 1000, imageUrls: [], ...patch });
const plain = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/&nbsp;/g, " ").trim();
const figures = () => [...output.html.matchAll(/<div class="figure[^\"]*">([\s\S]*?)<\/div>/g)].map((m) => plain(m[1]));

describe("actual appraisal PDF template financial output", () => {
  it("prints unknown reserve as unknown and the unit count only in its own tile", async () => {
    await generateSalvagePdfFromReport(source({ additional_units: [{ id: "u2", actual_cash_value: 2000, imageUrls: [] }] }));
    expect(figures()[0]).toMatch(/^Recommended Reserve Not established less the deductible$/);
    expect(figures()[3]).toMatch(/^Units Appraised 2 /);
  });

  it("labels combined ACV and replacement values as Value and keeps each unit's chosen basis", async () => {
    await generateSalvagePdfFromReport(source({ additional_units: [{ id: "u2", value_basis: "replacement", replacement_cost: 2000, imageUrls: [] }] }));
    expect(figures()[1]).toMatch(/^Value .*3,000\.00$/);
    expect(output.html).toMatch(/choice on[^>]*>[\s\S]*?Replacement Cost/);
  });

  it("uses saved legacy USD consistently without converting amounts or stating Canadian dollars", async () => {
    const input = source({ currency: "USD", actual_cash_value: 12345 });
    const before = structuredClone(input);
    await generateSalvagePdfFromReport(input);
    expect(figures()[1]).toBe("Actual Cash Value $12,345.00");
    expect(figures()[1]).not.toContain("CA$");
    expect(output.html).toContain("Values are in US dollars");
    expect(output.html).not.toContain("Canadian dollars");
    expect(input).toEqual(before);
  });

  it("prints a second unit's explicit zero instead of its researched positive amount", async () => {
    const assessment = buildSalvageAssessment({ inputs: { overrides: { preLoss: { amount: 50000, description: "Appraiser value", appraiserReason: "Documented manual opinion for this isolated regression." } } } });
    await generateSalvagePdfFromReport(source({ additional_units: [{ id: "u2", unit_label: "Manual zero", actual_cash_value: 0, assessment, imageUrls: [] }] }));
    const row = output.html.match(/<tr><td>2<\/td>[\s\S]*?<\/tr>/)?.[0] || "";
    expect(plain(row)).toContain("$0.00");
    expect(figures()[1]).toContain("1,000.00");
  });
});
