import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  ASSET_SCHEDULE_CALCULATION_VERSION,
  buildAssetScheduleCalculations,
  calculateAssetAdminScheduleSheet,
  deriveAssetScheduleSummary,
} from "../src/service/assetAdminScheduleSheetService.js";
import {
  buildProposalValuationWorkbook,
  createProposalValuationExcelExport,
  proposalValuationExcelFilename,
  type ProposalValuationExcelData,
} from "../src/service/proposalValuationExcelService.js";

function fixture(): ProposalValuationExcelData {
  const assetScheduleSheet = calculateAssetAdminScheduleSheet({
    evaluator_columns: [
      { id: "legacy", name: "Internal valuation" },
      {
        id: "pv-user-1",
        name: "Alex Evaluator",
        user_id: "sensitive-user-id",
        email: "alex.private@example.test",
        avatar_url: "https://files.example/private-avatar.png",
      },
    ],
    rows: [
      {
        lot_id: "lot-1",
        asset_id: "825291",
        asset_category: "Excavator",
        year: "2023",
        make: "Example",
        model: "EX-20",
        serial_number: "SERIAL-001",
        cr_details: "Clean operating unit",
        condition_score: "4",
        location: "Edmonton, AB",
        pictures: 12,
        picture_urls: ["https://files.example/private-asset.jpg"],
        market_check: {
          comparable_count: "High",
          avg_retail_asking_price: "Moderate",
          market_saturation: "Low",
          market_velocity: "Fast",
          regional_demand: "Strong",
          notes: "Healthy market",
        },
        asset_insight: "CAD 115,000",
        evaluator_values: { legacy: 100_000, "pv-user-1": 120_000 },
        notes: "Reviewed",
        lien_search: 75,
        video_cost: 125,
      },
    ],
    file_summary: {
      buyers_premium_basis: "uncapped",
      offer2_nmg_percent: 0.785,
      capped_threshold_percent: 0.1,
    },
  });
  const summary = deriveAssetScheduleSummary(assetScheduleSheet);
  return {
    reportId: "507f1f77bcf86cd799439011",
    title: "Asset - PV/Fixture",
    meta: [
      { label: "Report Type", value: "Asset" },
      { label: "Status", value: "approved" },
      { label: "Contract", value: "PV/Fixture 001" },
      { label: "Client", value: "Fixture Client" },
      { label: "Prepared For", value: "Operations" },
    ],
    currencyCode: "CAD",
    assetScheduleSheet,
    revision: 7,
    summary,
    calculationVersion: ASSET_SCHEDULE_CALCULATION_VERSION,
    calculations: buildAssetScheduleCalculations(assetScheduleSheet, summary),
  };
}

function headerColumn(worksheet: ExcelJS.Worksheet, label: string): number {
  const header = worksheet.getRow(7);
  let match = 0;
  header.eachCell((cell, columnNumber) => {
    if (cell.text === label) match = columnNumber;
  });
  if (!match) throw new Error(`Missing workbook column: ${label}`);
  return match;
}

function totalsFixture(
  evaluatorCount: number,
  rows: Array<Record<string, unknown>>
): ProposalValuationExcelData {
  const base = fixture();
  const assetScheduleSheet = calculateAssetAdminScheduleSheet({
    evaluator_columns: Array.from({ length: evaluatorCount }, (_, index) => ({
      id: `evaluator-${index + 1}`,
      name: `Evaluator ${index + 1}`,
    })),
    rows,
    file_summary: base.assetScheduleSheet.file_summary,
  });
  const summary = deriveAssetScheduleSummary(assetScheduleSheet);
  return {
    ...base,
    assetScheduleSheet,
    summary,
    calculations: buildAssetScheduleCalculations(assetScheduleSheet, summary),
  };
}

function fractionalTotalsFixture(): ProposalValuationExcelData {
  return totalsFixture(3, [
    {
      lot_id: "first",
      asset_id: "1",
      evaluator_values: { "evaluator-1": 100000.1, "evaluator-2": 120000.2 },
      lien_search: 75.25,
      video_cost: 125.5,
    },
    {
      lot_id: "second",
      asset_id: "2",
      evaluator_values: { "evaluator-1": 10000.3, "evaluator-3": 5000.5 },
      lien_search: 25.1,
      video_cost: 0,
    },
    {
      lot_id: "zero",
      asset_id: "3",
      evaluator_values: { "evaluator-1": 0, "evaluator-2": 0, "evaluator-3": 0 },
    },
    { lot_id: "missing", asset_id: "4", evaluator_values: {} },
  ]);
}

describe("Proposal Valuation Excel workbook", () => {
  it("totals monetary columns from all detail rows with the same dark workbook styling", () => {
    const data = fractionalTotalsFixture();
    const workbook = buildProposalValuationWorkbook(data);
    const detail = workbook.getWorksheet("Valuation Detail")!;
    const total = detail.getRow(12);
    expect(total.getCell(1).value).toBe("Total (all lots)");
    expect(total.getCell(2).isMerged).toBe(true);
    expect(total.height).toBeGreaterThanOrEqual(24);

    const expectedTotals: Record<string, number> = {
      "Evaluator 1": 110000.4,
      "Evaluator 2": 120000.2,
      "Evaluator 3": 5000.5,
      "Appraiser Average": 117500.55,
      "Low Estimate": 105000.6,
      "High Estimate": 130000.5,
      "Capped Buyer Premium": 3125.06,
      "Total Expected Gross": 120625.61,
      "Allocated Value": 120625.61,
      Cleaning: 1300.005,
      "Lien Search": 100.35,
      Video: 125.5,
      Lotting: 1300.005,
      Advertising: 1300.005,
      "Projected Costs": 4125.865,
    };
    for (const [label, expected] of Object.entries(expectedTotals)) {
      const column = headerColumn(detail, label);
      const cell = total.getCell(column);
      const letter = detail.getColumn(column).letter;
      expect(cell.formula).toBe(`SUM(${letter}8:${letter}11)`);
      expect(cell.result).toBeCloseTo(expected, 8);
      expect(cell.numFmt).toBe('"CAD" #,##0.00;[Red]-"CAD" #,##0.00');
      expect(detail.getRow(8).getCell(column).numFmt).toBe('"CAD" #,##0;[Red]-"CAD" #,##0');
      expect(cell.font).toMatchObject({ bold: true, color: { argb: "FFFFFF" } });
      expect(cell.fill).toMatchObject({ fgColor: { argb: "102A43" } });
      expect(cell.alignment).toMatchObject({ horizontal: "right", vertical: "middle" });
    }
    for (const label of ["Year", "Pictures", "Asset Insight", "Buyer Premium", "Risk Score", "Risk Rating", "Valuation Notes"]) {
      expect(total.getCell(headerColumn(detail, label)).value).toBeNull();
    }
    expect(total.getCell(headerColumn(detail, "Appraiser Average")).result).toBe(data.summary.total_asset_value);
    expect(total.getCell(headerColumn(detail, "Capped Buyer Premium")).result).toBe(data.summary.total_capped_bp);
    expect(total.getCell(headerColumn(detail, "Capped Buyer Premium")).result).toBeGreaterThan(2000);
    const summary = workbook.getWorksheet("PV Summary")!;
    for (const address of ["B7", "D7", "F7", "H7", "B9", "D9", "B17", "D17", "F17", "H17"]) {
      expect(summary.getCell(address).formula).not.toMatch(/[A-Z]+12\b/);
    }
    expect(summary.getCell("D7").result).toBe(data.summary.total_asset_value);
    expect(detail.rowCount).toBe(12);
    expect(detail.getRow(10).getCell(headerColumn(detail, "Evaluator 1")).value).toBe(0);
    expect(detail.getRow(11).getCell(headerColumn(detail, "Evaluator 1")).value).toBeNull();
  });

  it("formats footer cents without rounding away repeating-decimal cached averages", () => {
    const data = totalsFixture(3, [{
      lot_id: "fractional-average",
      asset_id: "1",
      evaluator_values: { "evaluator-1": 10000, "evaluator-2": 20000, "evaluator-3": 44500 },
    }]);
    const detail = buildProposalValuationWorkbook(data).getWorksheet("Valuation Detail")!;
    const averageColumn = headerColumn(detail, "Appraiser Average");
    const total = detail.getRow(9).getCell(averageColumn);
    expect(total.result).toBe(74500 / 3);
    expect(total.result).not.toBe(24833.33);
    expect(total.numFmt).toContain("#,##0.00");
    expect(detail.getRow(8).getCell(averageColumn).numFmt).not.toContain("#,##0.00");
  });

  it.each([0, 1, 4, 12])("keeps total formulas aligned with %i dynamic evaluator columns", (evaluatorCount) => {
    const values = Object.fromEntries(Array.from({ length: evaluatorCount }, (_, index) => [`evaluator-${index + 1}`, index + 0.25]));
    const data = totalsFixture(evaluatorCount, [
      { lot_id: "a", asset_id: "A", evaluator_values: values },
      { lot_id: "b", asset_id: "B", evaluator_values: values },
    ]);
    const detail = buildProposalValuationWorkbook(data).getWorksheet("Valuation Detail")!;
    const total = detail.getRow(10);
    for (let index = 1; index <= evaluatorCount; index += 1) {
      const column = headerColumn(detail, `Evaluator ${index}`);
      const letter = detail.getColumn(column).letter;
      expect(total.getCell(column).formula).toBe(`SUM(${letter}8:${letter}9)`);
      expect(total.getCell(column).result).toBe((index - 1 + 0.25) * 2);
    }
    expect(total.getCell(headerColumn(detail, "Appraiser Average")).result).toBe(data.summary.total_asset_value);
    expect(total.getCell(headerColumn(detail, "Low Estimate")).result).toBe(data.summary.total_low_est_value);
    expect(total.getCell(headerColumn(detail, "High Estimate")).result).toBe(data.summary.total_high_est_value);
    expect(total.getCell(headerColumn(detail, "Buyer Premium")).value).toBeNull();
  });

  it.each([0, 1, 3, 12])("uses average-based premium/gross formulas and matching caches with %i evaluators", async (evaluatorCount) => {
    const evaluator_values = Object.fromEntries(Array.from({ length: evaluatorCount }, (_, index) => [
      `evaluator-${index + 1}`, index === 0 ? 100 : index === 1 ? 300 : null,
    ]));
    const data = totalsFixture(evaluatorCount, [
      { lot_id: "entered", asset_id: "1", evaluator_values },
      { lot_id: "zero", asset_id: "2", evaluator_values: { "evaluator-1": 0 } },
      { lot_id: "blank", asset_id: "3", evaluator_values: {} },
    ]);
    const { buffer } = await createProposalValuationExcelExport(data);
    const reloaded = new ExcelJS.Workbook();
    await reloaded.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const detail = reloaded.getWorksheet("Valuation Detail")!;
    const avgLetter = detail.getColumn(headerColumn(detail, "Appraiser Average")).letter;
    const highLetter = detail.getColumn(headerColumn(detail, "High Estimate")).letter;
    const percentLetter = detail.getColumn(headerColumn(detail, "Buyer Premium")).letter;
    const premiumLetter = detail.getColumn(headerColumn(detail, "Capped Buyer Premium")).letter;
    const grossLetter = detail.getColumn(headerColumn(detail, "Total Expected Gross")).letter;
    const allocatedLetter = detail.getColumn(headerColumn(detail, "Allocated Value")).letter;
    const range = evaluatorCount ? `${detail.getColumn(headerColumn(detail, "Evaluator 1")).letter}8:${detail.getColumn(headerColumn(detail, `Evaluator ${evaluatorCount}`)).letter}8` : "";
    expect(detail.getCell(`${premiumLetter}8`).formula).toBe(evaluatorCount
      ? `IF(COUNT(${range})=0,"",MIN(${avgLetter}8*${percentLetter}8,2000))`
      : '""');
    expect(detail.getCell(`${grossLetter}8`).formula).toBe(evaluatorCount
      ? `IF(COUNT(${range})=0,"",${avgLetter}8+${premiumLetter}8)` : '""');
    expect(detail.getCell(`${allocatedLetter}8`).formula).toBe(evaluatorCount
      ? `IF(COUNT(${range})=0,"",${grossLetter}8)` : '""');
    const average = evaluatorCount > 1 ? 200 : 100;
    const gross = average + average * 0.15;
    // ExcelJS reads an exported blank formula cache as undefined, never numeric zero.
    expect(detail.getCell(`${premiumLetter}8`).result).toBe(evaluatorCount ? average * 0.15 : undefined);
    expect(detail.getCell(`${grossLetter}8`).result).toBe(evaluatorCount ? gross : undefined);
    expect(detail.getCell(`${allocatedLetter}8`).result).toBe(evaluatorCount ? gross : undefined);
    expect(detail.getCell(`${premiumLetter}9`).result).toBe(evaluatorCount ? 0 : undefined);
    expect(detail.getCell(`${grossLetter}9`).result).toBe(evaluatorCount ? 0 : undefined);
    expect(detail.getCell(`${premiumLetter}10`).result).toBeUndefined();
    expect(detail.getCell(`${grossLetter}10`).result).toBeUndefined();
    const cleaning = detail.getRow(8).getCell(headerColumn(detail, "Cleaning"));
    expect(cleaning.formula).toBe(`IF(${highLetter}8="","",${highLetter}8*1%)`);
    expect(cleaning.result).toBe(evaluatorCount ? (evaluatorCount > 1 ? 3 : 1) : undefined);
    expect(detail.getCell(`${grossLetter}11`).result).toBe(evaluatorCount ? gross : 0);
    expect(reloaded.getWorksheet("PV Summary")!.getCell("D9").result).toBe(evaluatorCount ? average * 0.15 : 0);
  });

  it.each([0, 4])("uses non-circular zero totals for an empty report with %i evaluators", (evaluatorCount) => {
    const data = totalsFixture(evaluatorCount, []);
    const workbook = buildProposalValuationWorkbook(data);
    const detail = workbook.getWorksheet("Valuation Detail")!;
    expect(detail.rowCount).toBe(8);
    expect(detail.getCell("A8").value).toBe("Total (all lots)");
    const total = detail.getRow(8);
    for (const label of ["Appraiser Average", "Low Estimate", "High Estimate", "Capped Buyer Premium", "Projected Costs"]) {
      const cell = total.getCell(headerColumn(detail, label));
      expect(cell.formula).toBe("0");
      expect(cell.result).toBe(0);
    }
    for (const address of ["B7", "D7", "F7", "H7", "B9", "D9"]) {
      const cell = workbook.getWorksheet("PV Summary")!.getCell(address);
      expect(cell.formula).toBe("0");
      expect(cell.result).toBe(0);
    }
  });

  it.each(["fractional", "empty"] as const)("retains footer formulas, numeric caches and presentation after %s export/reload", async (kind) => {
    const data = kind === "fractional" ? fractionalTotalsFixture() : totalsFixture(4, []);
    const before = buildProposalValuationWorkbook(data).getWorksheet("Valuation Detail")!;
    const { buffer } = await createProposalValuationExcelExport(data);
    const reloaded = new ExcelJS.Workbook();
    await reloaded.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const after = reloaded.getWorksheet("Valuation Detail")!;
    const totalRow = 8 + data.assetScheduleSheet.rows.length;
    expect(after.rowCount).toBe(totalRow);
    expect(after.getCell(`A${totalRow}`).value).toBe("Total (all lots)");
    for (let column = 1; column <= before.columnCount; column += 1) {
      const original = before.getRow(totalRow).getCell(column);
      const loaded = after.getRow(totalRow).getCell(column);
      expect(loaded.value).toEqual(original.value);
      expect(loaded.font).toEqual(original.font);
      expect(loaded.fill).toEqual(original.fill);
      expect(loaded.numFmt).toEqual(original.numFmt);
    }
    expect(reloaded.getWorksheet("PV Summary")!.getCell("D7").result).toBe(data.summary.total_asset_value);
  });

  it("builds a styled, formula-driven workbook without private artifact fields", () => {
    const data = fixture();
    const workbook = buildProposalValuationWorkbook(data);

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      "PV Summary",
      "Valuation Detail",
      "Formula Reference",
    ]);
    expect(workbook.calcProperties.fullCalcOnLoad).toBe(true);

    const summary = workbook.getWorksheet("PV Summary")!;
    const detail = workbook.getWorksheet("Valuation Detail")!;
    const formulas = workbook.getWorksheet("Formula Reference")!;
    expect(summary.getCell("A1").text).toContain("Proposal Valuation");
    expect(summary.getCell("D7").formula).toContain(
      "SUM('Valuation Detail'!"
    );
    expect(summary.getCell("D7").result).toBe(110_000);
    expect(summary.getCell("D7").numFmt).toContain('"CAD"');
    expect(summary.getCell("B14").value).toBe(0.785);
    expect(summary.getCell("B14").numFmt).toBe("0.0%");
    expect(summary.views[0]).toMatchObject({ state: "frozen", ySplit: 5 });

    expect(detail.autoFilter).toEqual({
      from: { row: 7, column: 1 },
      to: { row: 7, column: detail.columnCount },
    });
    expect(detail.views[0]).toMatchObject({
      state: "frozen",
      xSplit: 2,
      ySplit: 7,
    });
    const averageCell = detail.getRow(8).getCell(
      headerColumn(detail, "Appraiser Average")
    );
    const highCell = detail.getRow(8).getCell(
      headerColumn(detail, "High Estimate")
    );
    const premiumPercentCell = detail.getRow(8).getCell(
      headerColumn(detail, "Buyer Premium")
    );
    const premiumCell = detail.getRow(8).getCell(
      headerColumn(detail, "Capped Buyer Premium")
    );
    const projectedCostsCell = detail.getRow(8).getCell(
      headerColumn(detail, "Projected Costs")
    );
    const evaluatorCell = detail.getRow(8).getCell(
      headerColumn(detail, "Alex Evaluator")
    );
    expect(averageCell.formula).toMatch(/^IFERROR\(AVERAGE\(/);
    expect(averageCell.result).toBe(110_000);
    expect(highCell.formula).toContain("MAX(");
    expect(highCell.result).toBe(120_000);
    expect(premiumPercentCell.value).toBe(0.15);
    expect(premiumPercentCell.numFmt).toBe("0.0%");
    expect(premiumCell.formula).toContain("MIN(");
    expect(premiumCell.result).toBe(2_000);
    expect(projectedCostsCell.formula).toContain("SUM(");
    expect(evaluatorCell.value).toBe(120_000);
    expect(evaluatorCell.numFmt).toContain('"CAD"');
    expect((evaluatorCell.fill as ExcelJS.FillPattern).fgColor.argb).toBe(
      "EAF1FF"
    );
    expect(formulas.autoFilter).toBeTruthy();
    expect(formulas.getCell("D6").text).toContain("Sum of each asset");

    const workbookText = JSON.stringify(workbook.model);
    expect(workbookText).not.toContain("private-asset.jpg");
    expect(workbookText).not.toContain("private-avatar.png");
    expect(workbookText).not.toContain("alex.private@example.test");
    expect(workbookText).not.toContain("sensitive-user-id");
  });

  it("writes a valid xlsx buffer and a safe deterministic filename", async () => {
    const data = fixture();
    const output = await createProposalValuationExcelExport(data);
    expect(output.filename).toBe("proposal-valuation-PV-Fixture-001.xlsx");
    expect(output.buffer.subarray(0, 2).toString("utf8")).toBe("PK");

    const reloaded = new ExcelJS.Workbook();
    await reloaded.xlsx.load(output.buffer as unknown as ExcelJS.Buffer);
    expect(reloaded.getWorksheet("PV Summary")?.getCell("D7").result).toBe(
      110_000
    );
    expect(
      reloaded.getWorksheet("Valuation Detail")?.getCell("A8").value
    ).toBe("825291");
    expect(proposalValuationExcelFilename(data)).not.toMatch(/[\r\n"/]/);
  });

  it("keeps empty evaluator-derived values safe when a report has no evaluator columns", () => {
    const assetScheduleSheet = calculateAssetAdminScheduleSheet({
      evaluator_columns: [],
      rows: [
        {
          lot_id: "lot-without-evaluator",
          asset_id: "NO-EVAL-1",
          asset_category: "Unvalued Asset",
          evaluator_values: {},
        },
      ],
      file_summary: {
        buyers_premium_basis: "uncapped",
        offer2_nmg_percent: 0.785,
        capped_threshold_percent: 0.1,
      },
    });
    const summary = deriveAssetScheduleSummary(assetScheduleSheet);
    const base = fixture();
    const workbook = buildProposalValuationWorkbook({
      ...base,
      assetScheduleSheet,
      summary,
      calculations: buildAssetScheduleCalculations(
        assetScheduleSheet,
        summary
      ),
    });
    const detail = workbook.getWorksheet("Valuation Detail")!;
    const average = detail
      .getRow(8)
      .getCell(headerColumn(detail, "Appraiser Average"));
    const low = detail.getRow(8).getCell(headerColumn(detail, "Low Estimate"));
    const high = detail
      .getRow(8)
      .getCell(headerColumn(detail, "High Estimate"));
    expect(average.formula).toBe("0");
    expect(average.result).toBe(0);
    expect(low.formula).toBe('""');
    expect(low.result).toBe("");
    expect(high.formula).toBe('""');
    expect(high.result).toBe("");
    expect(workbook.getWorksheet("PV Summary")?.getCell("D7").result).toBe(0);
  });
});
