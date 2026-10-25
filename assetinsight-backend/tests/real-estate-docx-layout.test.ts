import { beforeAll, describe, expect, it, vi } from "vitest";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import PizZip from "pizzip";
import { finalizeRealEstateDocxLayout, REAL_ESTATE_TOC_MARKER } from "../src/service/docx/realEstateDocxLayout.js";
import { realEstateDocxFixture } from "./fixtures/realEstateDocxFixture.js";
import { buildRealEstateComparisonTables } from "../src/service/docx/builders/realEstate/comparisonTables.js";
import { readFile } from "node:fs/promises";
import { formatRealEstateMoney } from "../src/service/docx/builders/realEstate/formatMoney.js";
import { buildConclusions } from "../src/service/docx/builders/realEstate/conclusions.js";

vi.mock("../src/service/marketIntelService.js", () => ({
  fetchCanadaAndNorthAmericaIndicators: vi.fn(async () => { throw new Error("Offline fixture has no external market data"); }),
  generateTrendChartImage: vi.fn(), generateBarChartImage: vi.fn(),
}));
vi.mock("../src/service/htmlToImage.js", () => ({ generateRealEstateCertificateImage: vi.fn(async () => null) }));
vi.mock("../src/service/assetDocxService.js", () => ({ mergeDocuments: vi.fn(async () => { throw new Error("No cloud merge in local fixture"); }) }));
vi.mock("../src/service/docx/builders/appendix.js", () => ({ buildAppendixPhotoGallery: vi.fn(async () => []) }));

beforeAll(() => { process.env.REPORT_DOCX_MERGE_MODE = "local"; });

describe("Real Estate linked contents and layout", () => {
  it.each([
    { selections: { direct_comparable: true, income_capitalization: true, cost_approach: true }, weights: { direct_comparison_weight: 50, income_weight: 25, cost_weight: 25 }, expected: "Direct Comparison (50% weight) + Income Approach (25% weight) + Cost Approach (25% weight) = Final Value" },
    { selections: { direct_comparable: false, income_capitalization: true, cost_approach: false }, weights: { income_weight: 0 }, expected: "Income Approach (0% weight) = Final Value" },
    { selections: { direct_comparable: false, income_capitalization: false, cost_approach: true }, weights: {}, expected: "Cost Approach (weight not provided) = Final Value" },
    { selections: { direct_comparable: false, income_capitalization: false, cost_approach: false }, weights: {}, expected: "No selected approaches were recorded." },
    { selections: undefined, weights: { direct_comparison_weight: 0, income_weight: 100 }, expected: "Direct Comparison (0% weight) + Income Approach (100% weight) = Final Value" },
  ])("shows only saved reconciliation selections and weights: $expected", async ({ selections, weights, expected }) => {
    const data = realEstateDocxFixture("agricultural");
    const saved = { ...data, farmland_valuation: { ...data.farmland_valuation, approaches_used: selections, reconciliation: weights } };
    const snapshot = structuredClone(saved);
    const buffer = await Packer.toBuffer(new Document({ sections: [{ children: buildConclusions(saved, 9360) }] }));
    const xml = new PizZip(buffer).file("word/document.xml")!.asText();
    const paragraph = xml.match(/<w:p\b(?:(?!<w:p\b)[\s\S])*?Reconciliation: (?:(?!<w:p\b)[\s\S])*?<\/w:p>/)?.[0] || "";
    const text = Array.from(paragraph.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g), (match) => match[1]).join("");
    expect(text).toBe(`Reconciliation: ${expected}`);
    expect(saved).toEqual(snapshot);
  });
  it("preserves saved currency text without duplicate currency symbols", () => {
    expect(formatRealEstateMoney("$725,000", "CAD")).toBe("$725,000 CAD");
    expect(formatRealEstateMoney("CA$725,000", "CAD")).toBe("CA$725,000 CAD");
    expect(formatRealEstateMoney("725,000", "CAD")).toBe("$725,000 CAD");
    expect(formatRealEstateMoney(0, "CAD")).toBe("$0 CAD");
    expect(formatRealEstateMoney("725,000 CAD", "CAD")).toBe("725,000 CAD");
    expect(formatRealEstateMoney(undefined)).toBe("—");
  });
  it("keeps all comparable values in bounded tables with repeating headers", async () => {
    const records = Array.from({ length: 7 }, (_, index) => ({ name: `Comparable ${index + 1}`, values: [`Long retained location ${index + 1}`, `$${725000 + index}`] }));
    const tables = buildRealEstateComparisonTables(records, ["Location", "Value"]);
    expect(tables).toHaveLength(3);
    const buffer = await Packer.toBuffer(new Document({ sections: [{ children: tables }] }));
    const xml = new PizZip(buffer).file("word/document.xml")!.asText();
    for (const record of records) for (const text of [record.name, ...record.values]) expect(xml).toContain(text);
    expect(Array.from(xml.matchAll(/<w:tblHeader/g))).toHaveLength(3);
    expect(xml).toContain('w:color="D9D9D9"');
    expect(xml).not.toContain('w:hRule="exact"');
  });

  it("renders certificate layout without network CSS, scripts or font dependencies", async () => {
    const html = await readFile(new URL("../src/service/docx/templates/realEstateCertificate.html", import.meta.url), "utf8");
    expect(html).not.toMatch(/<(?:script|link)\b/i);
    expect(html).toContain("Canadian Uniform Standards of Professional Appraisal");
    expect(html).toContain("{{PROPERTY_ADDRESS}}");
    expect(html).toContain("{{VALUE_SECTION_START}}");
  });
  it("links actual headings including XML characters without estimated pages or unrelated Asset entries", async () => {
    const input = await Packer.toBuffer(new Document({ sections: [{ children: [
      new Paragraph(REAL_ESTATE_TOC_MARKER),
      new Paragraph({ text: "Scope & evidence <review>", heading: HeadingLevel.HEADING_1 }),
      new Paragraph({ children: [new TextRun("Saved exact narrative & $725,000.")] }),
      new Paragraph({ text: "Scope & evidence <review>", heading: HeadingLevel.HEADING_1 }),
    ] }] }));
    const xml = new PizZip(finalizeRealEstateDocxLayout(input)).file("word/document.xml")!.asText();
    expect(xml).not.toContain(REAL_ESTATE_TOC_MARKER);
    const anchors = Array.from(xml.matchAll(/<w:hyperlink w:anchor="([^"]+)"/g), (match) => match[1]);
    expect(anchors).toHaveLength(2);
    expect(new Set(anchors).size).toBe(2);
    for (const anchor of anchors) expect(xml).toContain(`w:name="${anchor}"`);
    expect(xml).toContain("Scope &amp; evidence &lt;review&gt;");
    expect(xml).toContain("Saved exact narrative &amp; $725,000.");
    expect(xml).not.toContain("PAGEREF");
  });

  it.each(["residential", "commercial", "agricultural"] as const)("builds %s from the production service with real chapter links and preserved values", async (propertyType) => {
    const { generateRealEstateDocxFromReport } = await import("../src/service/realEstateDocxService.js");
    const data = realEstateDocxFixture(propertyType);
    const snapshot = structuredClone(data);
    const buffer = await generateRealEstateDocxFromReport(data);
    const zip = new PizZip(buffer);
    const xml = zip.file("word/document.xml")!.asText();
    const styles = zip.file("word/styles.xml")!.asText();
    expect(data).toEqual(snapshot);
    expect(xml).toContain("Table of Contents");
    expect(xml).not.toContain(REAL_ESTATE_TOC_MARKER);
    expect(xml).toContain('w:anchor="RealEstateCertificate"');
    expect(xml).toContain("Saved appraiser conclusion");
    expect(xml).toContain("Lot 4 Block 8 Example Plan");
    expect(xml.includes("[Legal Description]")).toBe(false);
    expect(xml.includes("[Municipality / Rural Municipality / District]")).toBe(false);
    expect(xml.includes("[Zoning Code]")).toBe(false);
    expect(xml).toContain("2026-09-06");
    expect(xml.match(/<w:t[^>]*>— END OF APPRAISAL REPORT —<\/w:t>/g)).toHaveLength(1);
    expect(xml).toContain("$725,000");
    expect(xml).toContain("7.0 SITE DESCRIPTION");
    expect(xml).not.toContain("Company Overview and Contact Information");
    for (const match of xml.matchAll(/<w:hyperlink w:anchor="([^"]+)"/g)) expect(xml).toContain(`w:name="${match[1]}"`);
    expect(styles).toContain('<w:keepNext/>');
    expect(styles).toContain('w:line="276"');
    expect(xml.includes('w:w="12240" w:h="15840"')).toBe(true);
    expect(xml.includes("$$725,000")).toBe(false);
    expect(xml.includes("$undefined")).toBe(false);
    if (propertyType === "agricultural") {
      expect(xml).toContain("Farmland Valuation Analysis");
      expect(xml).toContain("Saved field access and irrigation notes remain unchanged.");
      expect(xml).toContain("Income Capitalization Approach");
      expect(xml).toContain("Cost Approach");
      expect(xml).toContain("160 acres");
    } else expect(xml).not.toContain("Farmland Valuation Analysis");
  });

  it("passes every main and report-only photo to the appendix in saved order without changing cover selection", async () => {
    const { generateRealEstateDocx } = await import("../src/service/docx/realEstateDocxBuilder.js");
    const { buildAppendixPhotoGallery } = await import("../src/service/docx/builders/appendix.js");
    const imageUtils = await import("../src/service/docx/builders/utils.js");
    const fetchImage = vi.spyOn(imageUtils, "fetchImageBuffer").mockResolvedValue(null);
    const data = {
      ...realEstateDocxFixture("residential", ["https://example.test/main-1.png", "https://example.test/main-2.png"]),
      extraImageUrls: ["https://example.test/report-only-map.png", "https://example.test/report-only-plan.png"],
      custom_cover: true,
    };
    const snapshot = structuredClone(data);
    try {
      await generateRealEstateDocx(data);
      expect(vi.mocked(buildAppendixPhotoGallery).mock.lastCall?.[1]).toEqual([...data.imageUrls, ...data.extraImageUrls]);
      expect(data).toEqual(snapshot);
      expect(data.cover_image_urls).toEqual([data.imageUrls[0]]);
    } finally {
      fetchImage.mockRestore();
    }
  });

  it("keeps disabled farmland methods out of the selected-method evidence tables", async () => {
    const { generateRealEstateDocx } = await import("../src/service/docx/realEstateDocxBuilder.js");
    const data = realEstateDocxFixture("agricultural");
    data.farmland_valuation!.approaches_used = { direct_comparable: false, income_capitalization: true, cost_approach: false };
    const xml = new PizZip(await generateRealEstateDocx({ ...data, custom_cover: true })).file("word/document.xml")!.asText();
    expect(xml).not.toContain("Farmland – Direct Comparables");
    expect(xml).not.toContain("Subject &amp; Adjustment Grid");
    expect(xml).toContain("Farmland Valuation Analysis");
    expect(xml).toContain("$725,000");
  });
});
