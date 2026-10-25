import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  buildReportDamageAnalysis,
  deriveLotDamageAnalysis,
  formatDamageAnalysisDisplayText,
} from "../src/utils/assetDamageAnalysis.js";
import {
  isLotDamageAnalysisEligible,
  parseLotNumberNumericPortion,
} from "../src/utils/lotDamagePolicy.js";
import { normalizePreviewLotsForBusinessRules } from "../src/utils/previewLotNormalization.js";
import { deriveAuctioneerSerial } from "../src/utils/auctioneerSpecRows.js";
import { generateAssetXlsxFromReport } from "../src/service/xlsx/assetXlsxService.js";

describe("lot Damage Analysis eligibility", () => {
  it("preserves an explicitly cleared primary serial across normalization", () => {
    const normalized = normalizePreviewLotsForBusinessRules({
      lots: [
        {
          lot_id: "serial-clear",
          lot_number: "1",
          title: "Quartz slab",
          serial_number: "",
          serial_no_or_label: "VIN: OLD-SERIAL-123",
          sn_vin: "OLD-SERIAL-123",
          condition_report_specs: {
            "Serial Number": "OLD-SERIAL-123",
            "Engine Serial Number": "ENGINE-456",
          },
        },
      ],
    });

    expect(normalized.lots[0].serial_number).toBe("");
    expect(normalized.lots[0].serial_no_or_label).toBe("");
    expect(normalized.lots[0].sn_vin).toBe("");
    expect(normalized.lots[0].condition_report_specs).toEqual({
      "Engine Serial Number": "ENGINE-456",
    });
    expect(normalized.lots[0].condition_report_specs_deleted).toContain(
      "Serial Number"
    );

    const secondSave = normalizePreviewLotsForBusinessRules(normalized);
    expect(secondSave.lots[0].serial_number).toBe("");
    expect(secondSave.lots[0].condition_report_specs).toEqual({
      "Engine Serial Number": "ENGINE-456",
    });
    expect(deriveAuctioneerSerial(secondSave.lots[0])).toBe("");
  });

  it("still derives a serial for generated lots that did not explicitly clear it", () => {
    const normalized = normalizePreviewLotsForBusinessRules({
      lots: [
        {
          lot_id: "generated-serial",
          lot_number: "1",
          title: "Generated lot",
          serial_number: null,
          condition_report_specs: { "Serial Number": "SERIAL-789" },
        },
      ],
    });

    expect(normalized.lots[0].serial_number).toBe("SERIAL-789");
  });

  it("normalizes editable damage into heading-free, title-cased lines", () => {
    expect(
      formatDamageAnalysisDisplayText(
        "Damages:\nright side handle bar is bent down\nengine oil at 45 PSI\nLED light missing\nGMC OEM panel bent"
      )
    ).toBe(
      "Right Side Handle Bar Is Bent Down\nEngine Oil At 45 PSI\nLED Light Missing\nGMC OEM Panel Bent"
    );
    expect(formatDamageAnalysisDisplayText("Damage Analysis: Body dent")).toBe(
      "Body Dent"
    );
    expect(formatDamageAnalysisDisplayText("Damages To The Back Taillight")).toBe(
      "Damages To The Back Taillight"
    );
  });

  it.each([
    ["999", 999n, true],
    ["0999", 999n, true],
    ["Lot #999", 999n, true],
    ["lot-001", 1n, true],
    ["999A", 999n, true],
    ["1000", 1000n, true],
    ["1,000", 1000n, true],
    ["1000A", 1000n, true],
    ["1001", 1001n, false],
    ["1,001", 1001n, false],
    ["1001A", 1001n, false],
    [undefined, null, true],
    [null, null, true],
    ["", null, true],
    ["WAREHOUSE-A", null, true],
  ])(
    "parses %j and returns the expected eligibility",
    (input, numericPortion, eligible) => {
      expect(parseLotNumberNumericPortion(input)).toBe(numericPortion);
      expect(isLotDamageAnalysisEligible(input)).toBe(eligible);
    }
  );

  it("clears above-threshold damage after final numbering and never restores it", () => {
    const firstSave = normalizePreviewLotsForBusinessRules({
      include_damage_analysis: true,
      lots: [
        {
          lot_id: "stable-eligible",
          lot_number: "Lot #0999",
          title: "Eligible lot",
          damage_analysis: "Damages:\nRust / Corrosion - visible surface rust",
        },
        {
          lot_id: "stable-above-threshold",
          lot_number: "1001A",
          title: "Above-threshold lot",
          damage_analysis: "Damages:\nBody Dents - side panel dent",
        },
        {
          lot_id: "stable-alpha",
          lot_number: "WAREHOUSE-A",
          title: "Legacy identifier",
          damage_analysis: "Damages:\nPaint Scratches & Chips - light wear",
        },
      ],
    });

    expect(firstSave.lots[0].damage_analysis).toContain("Rust / Corrosion");
    expect(firstSave.lots[1].damage_analysis).toBeNull();
    expect(firstSave.lots[2].damage_analysis).toContain("Paint Scratches");

    const renumberedBack = normalizePreviewLotsForBusinessRules({
      ...firstSave,
      lots: firstSave.lots.map((lot: any, index: number) =>
        index === 1 ? { ...lot, lot_number: "1000" } : lot
      ),
    });
    expect(renumberedBack.lots[1].damage_analysis).toBeNull();
  });

  it("uses lot numbers for the threshold and ignores numeric contract numbers", () => {
    const highContractNumber = normalizePreviewLotsForBusinessRules({
      contract_no: "5000",
      include_damage_analysis: true,
      lots: [
        {
          lot_number: "999",
          damage_analysis: "Damages:\nRust / Corrosion - visible surface rust",
        },
        {
          lot_number: "1000",
          damage_analysis: "Damages:\nPaint Scratches & Chips - light wear",
        },
        {
          lot_number: "1001",
          damage_analysis: "Damages:\nBody Dents - visible side-panel dent",
        },
      ],
    });

    expect(highContractNumber.lots[0].damage_analysis).toContain("Rust / Corrosion");
    expect(highContractNumber.lots[1].damage_analysis).toContain("Paint Scratches");
    expect(highContractNumber.lots[2].damage_analysis).toBeNull();

    const lowContractNumber = normalizePreviewLotsForBusinessRules({
      contract_no: "10",
      include_damage_analysis: true,
      lots: [
        {
          lot_number: "1001",
          damage_analysis: "Damages:\nBody Dents - visible side-panel dent",
        },
      ],
    });

    expect(lowContractNumber.lots[0].damage_analysis).toBeNull();
  });

  it("inherits the parent lot number for nested item damage", () => {
    const normalized = normalizePreviewLotsForBusinessRules({
      include_damage_analysis: true,
      lots: [
        {
          lot_id: "parent-eligible",
          lot_number: "999",
          title: "Eligible parent",
          items: [
            {
              lot_id: "item-5000",
              damage_analysis: "Damages:\nRust / Corrosion - visible rust",
            },
          ],
        },
        {
          lot_id: "parent-above-threshold",
          lot_number: "1001",
          title: "Above-threshold parent",
          items: [
            {
              lot_id: "item-1",
              damage_analysis: "Damages:\nBody Dents - visible dent",
            },
          ],
        },
      ],
    });

    expect(normalized.lots[0].items[0].damage_analysis).toContain("Rust / Corrosion");
    expect(normalized.lots[1].items[0].damage_analysis).toBeNull();
  });

  it("excludes above-threshold lots from derived lot and report summaries", () => {
    expect(
      deriveLotDamageAnalysis(
        {
          lot_number: "1001A",
          damage_analysis: "Damages:\nRust / Corrosion - visible rust",
        },
        true
      )
    ).toBeNull();

    const summary = buildReportDamageAnalysis(
      [
        {
          lot_number: "1001",
          damage_analysis: "Damages:\nRust / Corrosion - visible rust",
        },
        {
          lot_number: "999",
          damage_analysis: "Damages:\nBody Dents - visible side-panel dent",
        },
      ],
      true
    );
    expect(summary).toContain("Body Dents");
    expect(summary).not.toContain("Rust / Corrosion");
    expect(
      buildReportDamageAnalysis(
        [{ lot_number: "lot-001", damage_analysis: "Damages:\nBody Dents" }],
        true
      )
    ).toContain("Body Dents");
  });

  it("omits above-threshold damage from generated Excel Condition Report HTML", async () => {
    const output = await generateAssetXlsxFromReport({
      include_damage_analysis: true,
      grouping_mode: "per_item",
      contract_no: "DAMAGE-POLICY",
      lots: [
        {
          lot_id: "eligible",
          lot_number: "999",
          title: "Eligible lot",
          description: "Eligible lot",
          categories: "Mini Excavators",
          damage_analysis: "Damages:\nRust / Corrosion - visible lower-frame rust",
        },
        {
          lot_id: "above-threshold",
          lot_number: "1,001",
          title: "Above-threshold lot",
          description: "Above-threshold lot",
          categories: "Mini Excavators",
          damage_analysis: "Damages:\nBody Dents - visible side-panel dent",
        },
      ],
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(output as any);
    const worksheet = workbook.getWorksheet("Sheet1");
    expect(worksheet).toBeTruthy();
    const headers = (worksheet!.getRow(1).values as any[]).map((value) => String(value ?? ""));
    const conditionReportColumn = headers.indexOf("Condition Report");
    expect(conditionReportColumn).toBeGreaterThan(0);

    const eligibleConditionReport = String(worksheet!.getRow(2).getCell(conditionReportColumn).value ?? "");
    const aboveThresholdConditionReport = String(worksheet!.getRow(3).getCell(conditionReportColumn).value ?? "");
    expect(eligibleConditionReport).toContain("Rust/Corrosion");
    expect(eligibleConditionReport).toContain("Damages");
    expect(aboveThresholdConditionReport).not.toContain("Body Dents");
    expect(aboveThresholdConditionReport).not.toContain("<b>Damages</b>");
  });
});
