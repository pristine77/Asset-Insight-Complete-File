import { describe, expect, it } from "vitest";
import { Document, Packer } from "docx";
import PizZip from "pizzip";
import ExcelJS from "exceljs";
import { projectAssetAppraisalValues } from "../src/service/assetAppraisalValueProjectionService.js";
import { calculateAssetAdminScheduleSheet } from "../src/service/assetAdminScheduleSheetService.js";
import { buildScheduleRows } from "../src/service/assetSchedulePdfService.js";
import { buildAssetScheduleSection } from "../src/service/docx/builders/assetScheduleSection.js";
import { buildCertificateOfAppraisal, resolveSelectedAssetValuationMethods } from "../src/service/docx/builders/certificate.js";
import { generateAssetXlsxFromReport } from "../src/service/xlsx/assetXlsxService.js";
import { getCanonicalProposalValuationSheet } from "../src/service/proposalValuationService.js";

function reportFor(values: Array<Array<number | null | string>>, extra: any = {}) {
  const lots = values.map((_, index) => ({ lot_id: `fixture-${index}`, lot_number: String(index + 1),
    title: `Saved title ${index + 1}`, estimated_value: index === 0 ? "CAD 12,637.79" : "CAD 10,531.49",
    image_urls: [], opening_bid: 15, bid_increment: 5 }));
  const admin_schedule_sheet = {
    evaluator_columns: [{ id: "owner", name: "Owner" }, { id: "peer", name: "Peer" }, { id: "blank", name: "Third" }],
    rows: values.map((row, index) => ({ lot_id: lots[index].lot_id, asset_insight: lots[index].estimated_value,
      evaluator_values: { owner: row[0] ?? null, peer: row[1] ?? null, blank: row[2] ?? null } })),
    file_summary: { buyers_premium_basis: "capped", commission_percent_no_guarantee: 0.12 },
  };
  return { currency: "CAD", grouping_mode: "per_item", include_valuation_table: false,
    valuation_methods: [], total_value: 895317.01, total_appraised_value: 895317.01,
    lots, admin_schedule_sheet, ...extra };
}

const xmlFor = async (children: any[]) => {
  const buffer = await Packer.toBuffer(new Document({ sections: [{ children }] }));
  return new PizZip(buffer).file("word/document.xml")!.asText();
};

describe("Asset appraisal files use evaluator values without replacing AI references", () => {
  it("uses the nonblank average in Schedule A PDF data, Word and the certificate", async () => {
    const report = reportFor([[13500, 13500, null]]);
    const before = structuredClone(report);
    const projected = projectAssetAppraisalValues(report);
    expect(projected.lots[0].estimated_value).toBe("CAD 13500.00");
    expect(projected.total_value).toBe(13500);
    expect(buildScheduleRows(report)[0].fmv_value).toBe("CAD 13,500.00");
    const schedule = await xmlFor(await buildAssetScheduleSection(report));
    expect(schedule).toContain("CAD 13,500.00");
    expect(schedule).not.toContain("12,637.79");
    const certificate = await xmlFor(await buildCertificateOfAppraisal(report, 9360, "October 30, 2026"));
    expect(certificate).toContain("Total Fair Market Value: $13,500.00");
    expect(resolveSelectedAssetValuationMethods(report).map((method) => method.value)).toEqual([13500]);
    expect(projected.admin_schedule_sheet).toBe(report.admin_schedule_sheet);
    expect(projected.admin_schedule_sheet.rows[0].asset_insight).toBe("CAD 12,637.79");
    expect(projectAssetAppraisalValues(projected)).toEqual(projected);
    expect(report).toEqual(before);
  });

  it("sums all 63 rounded row averages rather than the old report total", async () => {
    const amounts = [13500, 11500, 11000, ...Array(59).fill(15000), 9700];
    const report = reportFor(amounts.map((amount) => [amount, amount, null]));
    const projected = projectAssetAppraisalValues(report);
    expect(projected.lots).toHaveLength(63);
    expect(projected.total_value).toBe(930700);
    expect(projected.total_appraised_value).toBe(930700);
    expect(resolveSelectedAssetValuationMethods(report)[0].value).toBe(930700);
    expect(buildScheduleRows(report).map((row) => row.fmv_value)).toEqual(amounts.map((amount) =>
      new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", currencyDisplay: "code" }).format(amount).replace(/\s/g, " ")));
    const xml = await xmlFor(await buildAssetScheduleSection(report));
    expect((xml.match(/Saved title/g) || [])).toHaveLength(63);
    const sheet = calculateAssetAdminScheduleSheet(projected.admin_schedule_sheet, report as any);
    expect(sheet.rows[0].asset_insight).toBe(report.lots[0].estimated_value);
    expect(sheet.rows[0].evaluator_values).toEqual({ owner: 13500, peer: 13500, blank: null });
  });

  it("averages unequal values, includes explicit zero, and falls back only for wholly blank rows", () => {
    const report = reportFor([[13500, 14000, ""], [0, 100, null], [0, null, ""], [null, null, ""]]);
    expect(projectAssetAppraisalValues(report).lots.map((lot: any) => lot.estimated_value))
      .toEqual(["CAD 13750.00", "CAD 50.00", "CAD 0.00", "CAD 10,531.49"]);
    expect(buildScheduleRows(report).map((row) => row.fmv_value))
      .toEqual(["CAD 13,750.00", "CAD 50.00", "CAD 0.00", "CAD 10,531.49"]);
    expect(projectAssetAppraisalValues(report).total_value).toBe(24331.49);
  });

  it("retains a blank row's independent explicit method amount and sums the actual rendered FMV rows", () => {
    const report = reportFor([[100, null, null], [null, null, null]]);
    (report.lots[1] as any).fmv = 999;
    const projected = projectAssetAppraisalValues(report);
    expect(buildScheduleRows(report).map((row) => row.fmv_value)).toEqual(["CAD 100.00", "CAD 999.00"]);
    expect(resolveSelectedAssetValuationMethods(report)[0].value).toBe(1099);
    expect(projected.total_value).toBe(1099);
    expect((report.lots[1] as any).fmv).toBe(999);
  });

  it("keeps a blank evaluator row and its child method amounts unchanged and totals only emitted children", async () => {
    const report = reportFor([[100, null, null], [null, null, null]], {
      valuation_methods: ["FLV"], valuation_data: { methods: [{ method: "FLV", percentage: 50, value: 999 }] },
    });
    (report.lots[1] as any).flv = 200;
    (report.lots[1] as any).items = [{ title: "A", estimated_value: "CAD 50", flv: 5 }, { title: "B", estimated_value: "CAD 60", flv: 6 }];
    const before = structuredClone(report);
    const projected = projectAssetAppraisalValues(report);
    expect(projected.lots[1]).toBe(report.lots[1]);
    expect(projected.lots[1].items).toBe((report.lots[1] as any).items);
    expect(buildScheduleRows(report).map((row) => row.valuations[0].value)).toEqual(["CAD 50.00", "CAD 5.00", "CAD 6.00"]);
    expect(projected.valuation_data.methods[0].value).toBe(61);
    expect(resolveSelectedAssetValuationMethods(report)[0].value).toBe(61);
    expect(projected.total_value).toBe(210);
    const certificate = await xmlFor(await buildCertificateOfAppraisal(report, 9360, "October 30, 2026"));
    expect(certificate).toContain("Total Forced Liquidation Value: $61.00");
    expect(report).toEqual(before);
  });

  it.each(["CAD 1,000–2,000", "CAD 1.234,56", "CAD 12,34", "USD 100"])("rejects ambiguous or mismatched fallback money %s", (amount) => {
    const report = reportFor([[100, null, null], [null, null, null]]);
    report.lots[1].estimated_value = amount;
    expect(() => projectAssetAppraisalValues(report)).toThrow("not a single valid number");
  });

  it.each(["1,000–2,000", "1.234,56", "1,000-2,000"])("does not normalize an ambiguous evaluator input %s into an invented price", (amount) => {
    expect(() => projectAssetAppraisalValues(reportFor([[amount, null, null]]))).toThrow("not a single valid number");
  });

  it("refuses a monetary string whose cent would be lost by JavaScript number parsing", () => {
    expect(() => projectAssetAppraisalValues(reportFor([["90071992547409.91", null, null]]))).toThrow("too much precision");
    const report = reportFor([[100, null, null], [null, null, null]]);
    report.lots[1].estimated_value = "CAD 90071992547409.91";
    expect(() => projectAssetAppraisalValues(report)).toThrow("too much precision");
  });

  it("sums emitted grouped child rows with the same nullish estimated-value fallback as Schedule A", () => {
    const report = reportFor([[100, null, null], [null, null, null]]);
    report.lots[1].estimated_value = "CAD 20";
    (report.lots[1] as any).items = [{ title: "Uses parent base" }, { title: "Explicit zero", estimated_value: 0 }, { title: "Blank", estimated_value: "" }];
    expect(buildScheduleRows(report).map((row) => row.fmv_value)).toEqual(["CAD 100.00", "CAD 20.00", "CAD 0.00", ""]);
    expect(projectAssetAppraisalValues(report).total_value).toBe(120);
    expect(resolveSelectedAssetValuationMethods(report)[0].value).toBe(120);
  });

  it.each([["FLV", "total_forced_liquidation_value"], ["OLV", "total_orderly_liquidation_value"], ["TKV", "total_trade_in_value"]])(
    "does not treat report-level %s total aliases as row-level overrides", (code, field) => {
      const report = reportFor([[100, null, null], [null, null, null]], {
        valuation_methods: [code], valuation_data: { methods: [{ method: code, percentage: 50 }] },
      });
      report.lots[1].estimated_value = "CAD 100";
      (report.lots[1] as any)[field] = 999;
      expect(buildScheduleRows(report).map((row) => row.valuations[0].value)).toEqual(["CAD 50.00", "CAD 50.00"]);
      expect(resolveSelectedAssetValuationMethods(report)[0].value).toBe(100);
      expect(projectAssetAppraisalValues(report).valuation_data.methods[0].value).toBe(100);
      expect((report.lots[1] as any)[field]).toBe(999);
    });

  it.each([[1.005, 50], [1.05, 70], [1.15, 50]])(
    "uses the unchanged source row's original precision before applying its saved rate (%s at %s%%)", (amount, percentage) => {
      const report = reportFor([[100, null, null], [null, null, null]], {
        valuation_methods: ["FLV"], valuation_data: { methods: [{ method: "FLV", percentage }] },
      });
      report.lots[1].estimated_value = `CAD ${amount}`;
      // Take the unchanged renderer as the reference, including its JS operator
      // order and Intl rounding; do not guess binary/locale tie behavior.
      const expected = buildScheduleRows({ currency: "CAD", valuation_methods: ["FLV"],
        valuation_data: report.valuation_data, lots: [report.lots[1]] })[0].valuations[0].value;
      const total = Number((percentage + Number(expected.replace(/[^0-9.-]/g, ""))).toFixed(2));
      expect(buildScheduleRows(report)[1].valuations[0].value).toBe(expected);
      expect(projectAssetAppraisalValues(report).valuation_data.methods[0].value).toBe(total);
      expect(resolveSelectedAssetValuationMethods(report)[0].value).toBe(total);
    });

  it("matches active evaluator identities after ownership transfer, retaining text-only legacy columns", async () => {
    const oldOwner = "111111111111111111111111", peer = "222222222222222222222222", newOwner = "333333333333333333333333";
    const report: any = reportFor([[null, null, null]], { user: { _id: newOwner },
      proposal_valuation_evaluators: [{ user: peer, column_id: "peer" }] });
    report.admin_schedule_sheet.evaluator_columns = [
      { id: "old-owner", name: "Previous owner", user_id: oldOwner },
      { id: "peer", name: "Peer", user_id: peer },
    ];
    report.admin_schedule_sheet.rows[0].evaluator_values = { "old-owner": 1000, peer: 2000 };
    // A stale nested preview must not restore deleted membership or inputs.
    report.preview_data = { lots: [{ lot_id: "deleted" }], admin_schedule_sheet: {
      ...report.admin_schedule_sheet, rows: [{ lot_id: "deleted", evaluator_values: { peer: 99999 } }],
    } };
    const before = structuredClone(report);
    const canonical = getCanonicalProposalValuationSheet({ ...report, preview_data: { lots: report.lots, admin_schedule_sheet: report.admin_schedule_sheet } });
    expect(canonical.evaluator_columns.some((column) => column.user_id === oldOwner)).toBe(false);
    const ownerColumn = canonical.evaluator_columns.find((column) => column.user_id === newOwner)!;
    expect(canonical.rows[0].evaluator_values[ownerColumn.id]).toBeNull();
    expect(projectAssetAppraisalValues(report).lots[0].estimated_value).toBe("CAD 2000.00");
    expect(buildScheduleRows(report).map((row) => row.fmv_value)).toEqual(["CAD 2,000.00"]);
    expect(resolveSelectedAssetValuationMethods(report)[0].value).toBe(2000);
    const xml = await xmlFor(await buildAssetScheduleSection(report));
    expect(xml).toContain("CAD 2,000.00");
    expect(xml).not.toContain("CAD 1,500.00");
    expect(report).toEqual(before);

    report.admin_schedule_sheet.evaluator_columns.push({ id: "legacy", name: "Historical appraiser" });
    report.admin_schedule_sheet.rows[0].evaluator_values.legacy = 3000;
    expect(projectAssetAppraisalValues(report).lots[0].estimated_value).toBe("CAD 2500.00");
    // A standalone payload without owner identity retains its saved column set.
    delete report.user;
    expect(projectAssetAppraisalValues(report).lots[0].estimated_value).toBe("CAD 2000.00");
  });

  it.each([["CAD", 1.005, 1.01], ["JPY", 1.5, 2], ["KWD", 1.0005, 1.001]])(
    "rounds %s averages at currency minor units and sums the rounded rows", (currency, amount, expected) => {
      const report = reportFor([[Number(amount), Number(amount), null], [Number(amount), null, null]], { currency });
      const projected = projectAssetAppraisalValues(report);
      expect(projected.total_value).toBe(Number(expected) * 2);
      expect(resolveSelectedAssetValuationMethods(report)[0].value).toBe(Number(expected) * 2);
    });

  it("retains selected methods and percentages, replacing stale method amounts only in the rendering copy", () => {
    const report = reportFor([[100, 120, null], [0, null, null]], {
      valuation_methods: ["FLV", "TKV"], include_valuation_table: true,
      flv: 999, total_forced_liquidation_value: 999,
      analysis: { forced_liquidation_value: 999 }, valuation: { trade_in_value: 999 },
      valuation_data: { baseFMV: 999, methods: [
        { method: "FLV", percentage: "52%", value: 999, amount: 999 },
        { method: "TKV", percentage: 0, value: 999 },
        { method: "OLV", percentage: 80, value: 999 },
      ] },
    });
    report.lots[0] = { ...report.lots[0], flv: 999, tkv: 999 } as any;
    const before = structuredClone(report);
    const projected = projectAssetAppraisalValues(report);
    expect(buildScheduleRows(report).map((row) => row.valuations)).toEqual([
      [{ code: "FLV", value: "CAD 57.20" }, { code: "TKV", value: "CAD 0.00" }],
      [{ code: "FLV", value: "CAD 0.00" }, { code: "TKV", value: "CAD 0.00" }],
    ]);
    expect(resolveSelectedAssetValuationMethods(report).map((method) => method.value)).toEqual([57.2, 0]);
    expect(projected.valuation_data.methods).toEqual([
      { method: "FLV", percentage: "52%", value: 57.2, amount: 57.2 },
      { method: "TKV", percentage: 0, value: 0 },
      { method: "OLV", percentage: 80, value: 999 },
    ]);
    expect(projected.admin_schedule_sheet.file_summary).toEqual(report.admin_schedule_sheet.file_summary);
    expect(report).toEqual(before);
  });

  it.each([undefined, "", -1, "invalid"])("refuses missing/invalid selected percentages %s only when evaluator values actually override", (percentage) => {
    const extra = { valuation_methods: ["FLV"], valuation_data: { methods: [{ method: "FLV", percentage, value: 999 }] } };
    expect(() => projectAssetAppraisalValues(reportFor([[100, null, null]], extra))).toThrow("saved FLV percentage");
    const blank = reportFor([[null, "", null]], extra);
    expect(projectAssetAppraisalValues(blank)).toBe(blank);
  });

  it("never reaches legacy certificate liquidation percentages without saved rates for an evaluator override", () => {
    const report = reportFor([[100, null, null]]);
    delete (report as any).valuation_methods;
    expect(() => resolveSelectedAssetValuationMethods(report)).toThrow("saved FLV percentage");
    report.admin_schedule_sheet.rows[0].evaluator_values.owner = null;
    expect(projectAssetAppraisalValues(report)).toBe(report);
  });

  it("does not use deleted/orphan evaluator rows or change reports without current evaluator inputs", () => {
    const report = reportFor([[null, null, null]]);
    report.admin_schedule_sheet.rows.push({ lot_id: "deleted", evaluator_values: { owner: 99999 } } as any);
    expect(projectAssetAppraisalValues(report)).toBe(report);
    expect(projectAssetAppraisalValues({ ...report, admin_schedule_sheet: undefined })).toEqual({ ...report, admin_schedule_sheet: undefined });
  });

  it("finds nested saved PV inputs without replacing their AI/source lots", () => {
    const report = reportFor([[13500, 13500, null]]);
    const nested = { ...report, admin_schedule_sheet: undefined, preview_data: {
      lots: report.lots, admin_schedule_sheet: report.admin_schedule_sheet, total_value: report.total_value,
    } };
    const projected = projectAssetAppraisalValues(nested);
    expect(projected.total_value).toBe(13500);
    expect(projected.preview_data.lots).toBe(report.lots);
    expect(projected.preview_data.admin_schedule_sheet).toBe(report.admin_schedule_sheet);
    expect(nested.preview_data.total_value).toBe(895317.01);
  });

  it("refuses ambiguous grouped item allocations only for an actual evaluator override", () => {
    const report = reportFor([[100, null, null]]);
    (report.lots[0] as any).items = [{ title: "First", estimated_value: 20 }, { title: "Second", estimated_value: 30 }];
    expect(() => projectAssetAppraisalValues(report)).toThrow("Individual item appraisal values are required");
    report.admin_schedule_sheet.rows[0].evaluator_values.owner = null;
    expect(projectAssetAppraisalValues(report)).toBe(report);
  });

  it("uses a sole child's evaluator total once and preserves independent auction bid inputs in Excel", async () => {
    const report = reportFor([[13500, 13500, null]], { schedule_a_pdf_url: "https://example.invalid/corrected-schedule.pdf" });
    (report.lots[0] as any).items = [{ title: "Single child", estimated_value: 20, opening_bid: 25, bid_increment: 10 }];
    expect(buildScheduleRows(report).map((row) => row.fmv_value)).toEqual(["CAD 13,500.00"]);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await generateAssetXlsxFromReport(report));
    const sheet = workbook.getWorksheet("Sheet1")!;
    const row = new Map<string, any>();
    sheet.getRow(1).eachCell((cell, column) => row.set(String(cell.value), sheet.getRow(2).getCell(column).value));
    expect(row.get("Opening Bid")).toBe(25);
    expect(row.get("Bid Increment")).toBe(10);
    expect(row.get("Schedule A")).toBe(report.schedule_a_pdf_url);
    expect(report.lots[0].estimated_value).toBe("CAD 12,637.79");
    expect((report.lots[0] as any).items[0].estimated_value).toBe(20);
  });
});
