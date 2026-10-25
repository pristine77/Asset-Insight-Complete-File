import { describe, expect, it } from "vitest";
import { Document, Packer } from "docx";
import PizZip from "pizzip";
import fs from "node:fs/promises";
import handlebars from "handlebars";
import { buildScheduleRows } from "../src/service/assetSchedulePdfService.js";
import { buildAssetScheduleSection } from "../src/service/docx/builders/assetScheduleSection.js";
import { resolveAssetValuationCodes } from "../src/utils/assetValuationSelection.js";
import { resolveSelectedAssetValuationMethods } from "../src/service/docx/builders/certificate.js";

const lot = {
  lot_number: "1", title: "(8) Chrome Bar Stools w/ USB-C",
  description: "Stale long generated description that must not be printed",
  details: "Unreviewed details must not be appended", estimated_value: 160,
  image_urls: [], condition_report_specs: {},
};
const xmlFor = async (report: any) => {
  const children = await buildAssetScheduleSection(report);
  const buffer = await Packer.toBuffer(new Document({ sections: [{ children }] }));
  return new PizZip(buffer).file("word/document.xml")!.asText();
};
const headers = (xml: string) => [...xml.split("</w:tr>")[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]);

describe("Asset Schedule A saved output authority", () => {
  it("prints the exact saved Title under Description without rewriting source data", async () => {
    const report = { lots: [lot], valuation_methods: ["FML"] };
    const before = structuredClone(report);
    expect(buildScheduleRows(report)[0].description).toBe(lot.title);
    const xml = await xmlFor(report);
    expect(headers(xml)).toContain("Description");
    expect(xml).toContain(lot.title);
    expect(xml).not.toContain(lot.description);
    expect(xml).not.toContain(lot.details);
    // DOCX `w:sz` values are half-points; Schedule A now uses readable 8–9 pt text.
    expect(xml).toContain('<w:sz w:val="16"/>');
    expect(xml).toContain('<w:sz w:val="18"/>');
    expect(report).toEqual(before);
  });

  it.each([
    [["FML"], ["FMV"]], [["OLV"], ["OLV"]], [["FLV"], ["FLV"]],
    [["TKV"], ["TKV"]], [["TKV", "FML", "OLV", "FLV"], ["TKV", "FMV", "OLV", "FLV"]],
    [[], []], [["bad-method"], []],
  ])("renders only selected columns %j, even with stale method data", async (selected, expected) => {
    const report = { lots: [lot], valuation_methods: selected, valuation_data: { methods: [
      { method: "FML", percentage: 100 }, { method: "OLV", percentage: 77 },
      { method: "FLV", percentage: 52 }, { method: "TKV", percentage: 70 },
    ] } };
    expect(headers(await xmlFor(report))).toEqual([
      "Schedule A", "Asset #", "Year", "Description", "Usage", "Serial Number", ...expected, "Pictures",
    ]);
  });

  it("uses each child's own Title and retains untitled legacy descriptions", () => {
    const rows = buildScheduleRows({ lots: [{ ...lot, items: [
      { title: "Child title", description: "Child narrative" },
      { title: "", description: "Legacy child description" },
    ] }, { title: "", description: "Legacy lot description" }] });
    expect(rows.map((row) => row.description)).toEqual([
      "Child title", "Legacy child description", "Legacy lot description",
    ]);
  });

  it("uses saved percentages, supports TKV and preserves explicit zero amounts", () => {
    const report = { valuation_methods: ["TKV", "OLV", "FLV", "FML"],
      valuation_data: { methods: [{ method: "TKV", percentage: 74 }, { method: "OLV", percentage: "81%" }, { method: "FLV", percentage: 52 }] },
      lots: [{ ...lot, olv: 0 }, { ...lot, estimated_value: 0 }, { ...lot, estimated_value: 101.25 }] };
    const rows = buildScheduleRows(report);
    expect(rows[0].valuations.map((v) => v.value)).toEqual(["$118.40", "$0.00", "$83.20", "$160.00"]);
    expect(rows[1].valuations.map((v) => v.value)).toEqual(["$0.00", "$0.00", "$0.00", "$0.00"]);
    expect(rows[2].valuations.map((v) => v.value)).toEqual(["$74.93", "$82.01", "$52.65", "$101.25"]);
    expect(buildScheduleRows({ lots: [lot], valuation_methods: ["TKV", "OLV", "FLV"] })[0].valuations.map((v) => v.value)).toEqual(["", "", ""]);
  });

  it("does not duplicate parent method totals into child rows", () => {
    const report = { valuation_methods: ["OLV"], valuation_data: { methods: [{ method: "OLV", percentage: 80 }] },
      lots: [{ ...lot, olv: 128, items: [{ title: "One", estimated_value: 100 }, { title: "Two", estimated_value: 0 }] }] };
    expect(buildScheduleRows(report).map((row) => row.valuations[0].value)).toEqual(["$80.00", "$0.00"]);
  });

  it.each(Array.from({ length: 16 }, (_, mask) => [mask]))("keeps Word and PDF header/body columns aligned for selection %i", async (mask) => {
    const selected = ["FML", "TKV", "OLV", "FLV"].filter((_, i) => mask & (1 << i));
    const report = { lots: [lot], valuation_methods: selected };
    const codes = resolveAssetValuationCodes(report);
    const xml = await xmlFor(report);
    const widths = [...xml.matchAll(/<w:gridCol w:w="(\d+)"/g)].map((m) => Number(m[1]));
    expect(widths).toHaveLength(6 + codes.length);
    expect(widths.reduce((a, b) => a + b, 0)).toBe(14400);
    const template = handlebars.compile(await fs.readFile("src/templates/asset_schedule.html", "utf8"));
    const html = template({ schedule_rows: buildScheduleRows(report), currency_code: "CAD", description_width: 69 - codes.length * 8 });
    const ths = html.match(/<th\b/g) || [];
    const tds = html.match(/<td\b/g) || [];
    expect(ths.length).toBe(3 + codes.length);
    expect(tds.length).toBe(ths.length);
    expect(html).toContain(lot.title);
    expect(html).not.toContain(lot.description);
    expect(html).not.toContain(lot.details);
    expect(html).not.toContain("Estimated Value");
    for (const code of ["FMV", "TKV", "OLV", "FLV"]) {
      expect(html.includes(`class="value-heading">${code}<`)).toBe(codes.includes(code as any));
    }
  });

  it("does not restore stale methods in the certificate, and keeps legacy selection compatibility", () => {
    const valuation_data = { methods: [{ method: "FLV", value: 80 }, { method: "OLV", value: 120 }] };
    expect(resolveSelectedAssetValuationMethods({ valuation_methods: [" fml ", "FMV", "bad"], valuation_data }).map((m) => m.code)).toEqual(["FMV"]);
    expect(resolveSelectedAssetValuationMethods({ valuation_methods: [], valuation_data })).toEqual([]);
    expect(resolveAssetValuationCodes({ valuation_data })).toEqual(["FLV", "OLV"]);
    expect(resolveAssetValuationCodes({})).toEqual([]);
    expect(resolveSelectedAssetValuationMethods({}).map((m) => m.code)).toEqual(["FLV", "OLV"]);
  });
});
