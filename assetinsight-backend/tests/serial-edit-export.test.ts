import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  generateAssetXlsxFromReport,
  generateLotListingXlsxFromReport,
} from "../src/service/xlsx/assetXlsxService.js";
import {
  deriveAuctioneerSerial,
  normalizeAuctioneerLotSpecs,
} from "../src/utils/auctioneerSpecRows.js";
import { normalizePreviewLotsForBusinessRules } from "../src/utils/previewLotNormalization.js";

const oldSerial = "1FTWW3DR9AEA01450";
const editedSerial = "1FTWW3DR9AEA01459";
const staleLot = () => ({
  lot_number: "222",
  title: "Ford truck",
  serial_number: oldSerial,
  serial_no_or_label: oldSerial,
  sn_vin: oldSerial,
  vin: oldSerial,
  description: `Earlier capture VIN: ${oldSerial}`,
  vinDecoded: { vin: oldSerial },
  condition_report_specs: {
    "Serial Number": oldSerial,
    "Engine Serial Number": "ENGINE-123",
  },
});

describe("saved primary serial authority", () => {
  it.each(["Serial Number", "VIN", "S/N", "Serial No", "S. No", "Serial Number (Unverified)"])(
    "uses the explicit %s correction ahead of captured root aliases",
    (field) => {
      const lot = {
        ...staleLot(),
        condition_report_specs_manual_overrides: { [field]: editedSerial },
      };
      expect(deriveAuctioneerSerial(lot)).toBe(editedSerial);
      const normalized = normalizeAuctioneerLotSpecs(lot);
      expect(normalized.serial_number).toBe(editedSerial);
      expect(normalized.condition_report_specs["Serial Number"]).toBe(editedSerial);
      expect(normalized.condition_report_specs["Engine Serial Number"]).toBe("ENGINE-123");
      expect(lot.serial_number).toBe(oldSerial);
    },
  );

  it.each([
    { condition_report_specs_deleted: ["Serial Number (Unverified)"] },
    { deleted_condition_report_specs: ["VIN"] },
    { removed_condition_report_specs: { "S. No": true } },
    { hidden_condition_report_specs: ["Serial No"] },
  ])("honours legacy primary-serial deletions throughout preview normalization", (deletions) => {
    const data = normalizePreviewLotsForBusinessRules({ lots: [{ ...staleLot(), ...deletions }] });
    const normalized = normalizeAuctioneerLotSpecs(data.lots[0]);
    expect(normalized.serial_number).toBe("");
    expect(deriveAuctioneerSerial(normalized)).toBe("");
    expect(normalized.condition_report_specs["Engine Serial Number"]).toBe("ENGINE-123");
  });

  it.each(["", "Not Found"])("does not restore a deliberately missing serial (%j)", (value) => {
    const lot = {
      ...staleLot(),
      condition_report_specs_manual_overrides: { "Serial Number": value },
    };
    expect(deriveAuctioneerSerial(lot)).toBe("");
    expect(normalizeAuctioneerLotSpecs(lot).serial_number).toBe("");
  });
});

describe.each([
  ["Asset", generateAssetXlsxFromReport],
  ["Lot Listing", generateLotListingXlsxFromReport],
] as const)("%s serial export", (_type, generateWorkbook) => {
  it.each([false, true])("matches edited specifications in the Serial Number column (nested=%s)", async (nested) => {
    const lot = {
      ...staleLot(),
      condition_report_specs_manual_overrides: { "Serial Number": editedSerial },
    };
    const report = { lots: nested ? [{ ...staleLot(), items: [lot] }] : [lot] };
    const before = JSON.stringify(report);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await generateWorkbook(report));
    const sheet = workbook.getWorksheet("Sheet1")!;
    const headers = sheet.getRow(1).values as string[];
    expect(sheet.getRow(2).getCell(headers.indexOf("Serial Number")).value).toBe(editedSerial);
    const cr = String(sheet.getRow(2).getCell(headers.indexOf("Condition Report")).value);
    expect(cr).toContain(editedSerial);
    expect(cr).not.toContain(oldSerial);
    expect(JSON.stringify(report)).toBe(before);
  });

  it.each([
    { condition_report_specs_manual_overrides: { "Serial Number": "" } },
    { condition_report_specs_manual_overrides: { VIN: "Not Found" } },
    { condition_report_specs_deleted: ["Serial Number"] },
    { condition_report_specs_deleted: ["Serial No"] },
    { condition_report_specs_deleted: ["Serial Number (Unverified)"] },
    { deleted_condition_report_specs: ["VIN"] },
    { removed_condition_report_specs: { "S. No": true } },
    { hidden_condition_report_specs: ["Serial No"] },
  ])("keeps explicit clear/delete empty instead of extracting an old VIN", async (edit) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await generateWorkbook({ lots: [{ ...staleLot(), ...edit }] }));
    const sheet = workbook.getWorksheet("Sheet1")!;
    const headers = sheet.getRow(1).values as string[];
    expect(sheet.getRow(2).getCell(headers.indexOf("Serial Number")).value).toBe("");
    expect(String(sheet.getRow(2).getCell(headers.indexOf("Condition Report")).value)).not.toContain(oldSerial);
  });
});
