import { describe, expect, it } from "vitest";
import { Document, Packer, PageOrientation, convertInchesToTwip } from "docx";
import PizZip from "pizzip";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeAssetReportValuationMethods, resolveAssetValuationCodes } from "../src/utils/assetValuationSelection.js";
import { buildScheduleRows, generateAssetSchedulePdfFromReport } from "../src/service/assetSchedulePdfService.js";
import { buildAssetScheduleSection } from "../src/service/docx/builders/assetScheduleSection.js";
import { buildCertificateOfAppraisal, resolveSelectedAssetValuationMethods } from "../src/service/docx/builders/certificate.js";
import { buildTransmittalLetter } from "../src/service/docx/builders/transmittal.js";

const names = ["FML", "TKV", "OLV", "FLV"];
const selections = Array.from({ length: 16 }, (_, mask) => names.filter((_, index) => mask & (1 << index)));
const lots = [{ lot_number: "1", title: "Reviewed short title", description: "DO_NOT_PRINT_LONG_NARRATIVE",
  estimated_value: 160, image_urls: [] }, { lot_number: "2", title: "Zero value asset", estimated_value: 0, image_urls: [] }];
const textOf = async (children: any[]) => {
  const bytes = await Packer.toBuffer(new Document({ sections: [{ children }] }));
  return new PizZip(bytes).file("word/document.xml")!.asText();
};

describe("Asset report FMV defaults and selected output", () => {
  it.each([
    [{ include_valuation_table: true, valuation_methods: [] }, []],
    [{ include_valuation_table: false, valuation_methods: [] }, ["FML"]],
    [{ valuation_methods: [] }, ["FML"]],
    [{ include_valuation_table: true }, ["FML"]],
    [{}, ["FML"]],
    [{ include_valuation_table: false, valuation_methods: ["OLV"] }, ["OLV"]],
    [{ include_valuation_table: true, valuation_methods: ["TKV", "FLV"] }, ["TKV", "FLV"]],
  ])("normalizes saved methods without mutating submission details: %j", (details, expected) => {
    const input = structuredClone(details);
    if (Array.isArray((details as any).valuation_methods)) Object.freeze((details as any).valuation_methods);
    Object.freeze(details);
    const result = normalizeAssetReportValuationMethods(details);
    expect(result).toEqual(expected);
    expect(details).toEqual(input);
    expect(result).not.toBe((details as any).valuation_methods);
  });
  for (const table of [true, false, undefined]) {
    it.each(selections.map((selection) => [selection]))("preserves selection %j with table=" + table, async (selection) => {
      const report = { lots, currency: "CAD", include_valuation_table: table, valuation_methods: selection,
        valuation_data: { methods: names.map((method) => ({ method, percentage: 75, value: 120 })) } };
      const before = structuredClone(report);
      const expected = selection.length === 0 && table !== true ? ["FMV"] : selection.map((code) => code === "FML" ? "FMV" : code);
      expect(resolveAssetValuationCodes(report)).toEqual(expected);
      expect(resolveSelectedAssetValuationMethods(report).map((method) => method.code)).toEqual(expected);
      expect(buildScheduleRows(report).map((row) => row.valuations.map((value) => value.code))).toEqual([expected, expected]);
      const xml = await textOf(await buildAssetScheduleSection(report));
      const firstRow = xml.split("</w:tr>")[0];
      for (const code of ["FMV", "TKV", "OLV", "FLV"]) {
        expect(firstRow.includes(">" + code + "</w:t>")).toBe(expected.includes(code));
      }
      expect(xml).toContain("Reviewed short title");
      expect(xml).not.toContain("DO_NOT_PRINT_LONG_NARRATIVE");
      expect(report).toEqual(before);
    });
  }

  it("normalizes aliases and duplicates without adding omitted methods", () => {
    expect(resolveAssetValuationCodes({ include_valuation_table: false, valuation_methods: [" fml ", "FMV", "TKV", "bad"] })).toEqual(["FMV", "TKV"]);
    expect(resolveAssetValuationCodes({ include_valuation_table: true, valuation_methods: [], valuation_data: { methods: [{ method: "OLV" }] } })).toEqual([]);
    expect(resolveAssetValuationCodes({ include_valuation_table: false, valuation_methods: [], valuation_data: { methods: [{ method: "OLV" }] } })).toEqual(["FMV"]);
  });

  it("preserves a zero FMV amount with the table off", () => {
    const row = buildScheduleRows({ include_valuation_table: false, valuation_methods: [], currency: "CAD", lots: [lots[1]] })[0];
    expect(row.valuations).toEqual([{ code: "FMV", value: "CAD 0.00" }]);
  });

  it("prints all 63 sample lots and the independent CA$1,275,200 total", async () => {
    const fixtureLots = Array.from({ length: 63 }, (_, index) => ({
      lot_number: String(index + 1), title: `Reviewed Asset ${String(index + 1).padStart(3, "0")}`,
      description: "DO_NOT_PRINT_LONG_NARRATIVE", estimated_value: index === 62 ? 35200 : 20000,
      image_urls: [], condition_report_specs_reviewed: true,
    }));
    const total = fixtureLots.reduce((sum, lot) => sum + lot.estimated_value, 0);
    expect(total).toBe(1275200);
    const report = { lots: fixtureLots, currency: "CAD", language: "en", client_name: "QA Sample Client",
      owner_name: "QA Sample Owner", appraiser: "QA Appraiser", include_valuation_table: false,
      valuation_methods: [], total_appraised_value: total, include_valuation_summary_in_transmittal: true };
    const before = structuredClone(report);
    const letter = buildTransmittalLetter(report, "October 27, 2026");
    const certificate = await buildCertificateOfAppraisal(report, 9360, "October 27, 2026");
    const schedule = await buildAssetScheduleSection(report);
    const document = new Document({ sections: [
      { children: letter }, { properties: { page: { size: { width: convertInchesToTwip(8.5), height: convertInchesToTwip(11) },
        margin: { top: 720, bottom: 720, left: 720, right: 720 } } }, children: certificate },
      { properties: { page: { size: { orientation: PageOrientation.LANDSCAPE },
        margin: { top: 792, bottom: 792, left: 720, right: 720 } } }, children: schedule },
    ] });
    const bytes = await Packer.toBuffer(document);
    const xml = new PizZip(bytes).file("word/document.xml")!.asText();
    expect(xml).toContain("premise of Fair Market Value");
    expect(xml).toContain("Total Fair Market Value");
    expect(xml).toContain("$1,275,200.00");
    expect(xml).not.toContain("No valuation methods");
    expect(xml).not.toContain("DO_NOT_PRINT_LONG_NARRATIVE");
    const rows = buildScheduleRows(report);
    expect(rows).toHaveLength(63);
    for (const [index, row] of rows.entries()) {
      expect(row.description).toBe(fixtureLots[index].title);
      expect(row.valuations).toEqual([{ code: "FMV", value: index === 62 ? "CAD 35,200.00" : "CAD 20,000.00" }]);
      expect(xml).toContain(fixtureLots[index].title);
    }
    const output = process.env.FMV_REVIEW_ARTIFACT_DIR;
    if (output) {
      await fs.mkdir(output, { recursive: true });
      await fs.writeFile(path.join(output, "fmv-63-lot-sample.docx"), bytes);
      await fs.writeFile(path.join(output, "fmv-63-lot-schedule.pdf"), await generateAssetSchedulePdfFromReport(report));
    }
    expect(report).toEqual(before);
  });

  it.each(selections.map((selection) => [selection]))("keeps positive balanced Word columns for large amounts and methods %j", async (selection) => {
    const report = { include_valuation_table: true, valuation_methods: selection, currency: "CAD",
      valuation_data: { methods: names.map((method) => ({ method, percentage: 100 })) },
      lots: [{ lot_number: "1", title: "Reviewed high-value asset", estimated_value: 1234567890.12, image_urls: [] }] };
    const xml = await textOf(await buildAssetScheduleSection(report));
    const columns = [...xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((match) => Number(match[1]));
    expect(columns).toHaveLength(6 + selection.length);
    expect(columns.every((width) => width > 0)).toBe(true);
    expect(columns.reduce((sum, width) => sum + width, 0)).toBe(14400);
  });

  it("renders all four selected valuation columns with large amounts", async () => {
    const output = process.env.FMV_REVIEW_ARTIFACT_DIR;
    const report = { include_valuation_table: true, valuation_methods: names, currency: "CAD",
      valuation_data: { methods: names.map((method) => ({ method, percentage: 100 })) },
      lots: [{ lot_number: "1", title: "Reviewed high-value asset", estimated_value: 1234567890.12, image_urls: [] },
        { lot_number: "2", title: "Reviewed second high-value asset", estimated_value: 987654321.98, image_urls: [] }] };
    const document = new Document({ sections: [{ properties: { page: {
      size: { orientation: PageOrientation.LANDSCAPE }, margin: { top: 792, bottom: 792, left: 720, right: 720 },
    } }, children: await buildAssetScheduleSection(report) }] });
    const bytes = await Packer.toBuffer(document);
    const xml = new PizZip(bytes).file("word/document.xml")!.asText();
    expect(xml.split("CAD 1,234,567,890.12")).toHaveLength(5);
    expect(xml.split("CAD 987,654,321.98")).toHaveLength(5);
    if (output) {
      await fs.writeFile(path.join(output, "fmv-four-methods-large.docx"), bytes);
      await fs.writeFile(path.join(output, "fmv-four-methods-large.pdf"), await generateAssetSchedulePdfFromReport(report));
    }
  });
});
