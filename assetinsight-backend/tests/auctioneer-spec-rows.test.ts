import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";

import {
  generateAssetXlsxFromReport,
  generateLotListingXlsxFromReport,
} from "../src/service/xlsx/assetXlsxService.js";
import {
  buildAuctioneerSpecRows,
  formatAuctioneerSpecValue,
  normalizeAuctioneerLotSpecs,
} from "../src/utils/auctioneerSpecRows.js";

function populatedRows(lot: Record<string, unknown>) {
  return buildAuctioneerSpecRows(lot).filter((row) => row.checked || row.value.trim());
}

describe("auctioneer specification canonicalization", () => {
  it("formats only field-scoped hour and mileage measurements", () => {
    expect(formatAuctioneerSpecValue("Odometer (Showing Unverified)", "4440 km")).toBe(
      "4,440 km"
    );
    expect(formatAuctioneerSpecValue("Mileage", "4440 km")).toBe("4,440 km");
    expect(formatAuctioneerSpecValue("Mileage", "4440 mi")).toBe("4,440 mi");
    expect(formatAuctioneerSpecValue("Mileage", "4440")).toBe("4,440");
    expect(formatAuctioneerSpecValue("Hours", "179")).toBe("179 Hours");
    expect(formatAuctioneerSpecValue("Showing Hours", "1,234 hr")).toBe(
      "1,234 Hours"
    );
    expect(formatAuctioneerSpecValue("GVWR", "3198 Kg")).toBe("3,198 Kg");
    expect(formatAuctioneerSpecValue("Operating Weight", "67200 lb")).toBe(
      "67,200 lb"
    );

    // Generic numeric-looking identifiers must never be reformatted.
    expect(formatAuctioneerSpecValue("Year", "2024")).toBe("2024");
    expect(formatAuctioneerSpecValue("Serial Number", "44401234")).toBe(
      "44401234"
    );
    expect(formatAuctioneerSpecValue("Engine Displacement", "3.5L")).toBe(
      "3.5L"
    );
    expect(formatAuctioneerSpecValue("Model", "4440")).toBe("4440");
  });

  it("maps the legacy Mileage field to the Odometer registry label", () => {
    const normalized = normalizeAuctioneerLotSpecs({
      categories: "Sport Utility Vehicle",
      condition_report_specs: {
        "Mileage (Showing Unverified)": "4440 km",
      },
      condition_report_specs_custom_order: ["Mileage (Showing Unverified)"],
    });

    expect(normalized.condition_report_specs).toMatchObject({
      "Odometer (Showing Unverified)": "4,440 km",
    });
    expect(normalized.condition_report_specs["Mileage (Showing Unverified)"]).toBeUndefined();
    expect(normalized.condition_report_specs_custom_order).toEqual([
      "Odometer (Showing Unverified)",
    ]);
  });

  it("maps legacy Mileage even when an old report has no recognized category", () => {
    const normalized = normalizeAuctioneerLotSpecs({
      condition_report_specs: {
        "Mileage (Showing Unverified)": "12000 mi",
      },
    });

    expect(normalized.condition_report_specs).toMatchObject({
      "Odometer (Showing Unverified)": "12,000 mi",
    });
    expect(normalized.condition_report_specs["Mileage (Showing Unverified)"]).toBeUndefined();
  });

  it("fills a configured Year field from VIN metadata without replacing an existing year", () => {
    const derived = normalizeAuctioneerLotSpecs({
      categories: "All Terrain Cranes",
      vinDecoded: { year: 2025 },
    });
    expect(derived.condition_report_specs).toMatchObject({ Year: "2025" });

    const preserved = normalizeAuctioneerLotSpecs({
      categories: "All Terrain Cranes",
      vinDecoded: { year: 2025 },
      condition_report_specs: { Year: "1995" },
    });
    expect(preserved.condition_report_specs).toMatchObject({ Year: "1995" });
  });

  it("cleans the duplicate excavator fields shown in the reported fixture", () => {
    const normalized = normalizeAuctioneerLotSpecs({
      categories: "Excavators",
      condition_report_specs: {
        "Serial Number": "FF017Z210620",
        "Has Key": "Yes",
        "Running Condition": "Starts And Runs",
        "Operational Video Available": "Yes",
        "Excavator Type": "Mini Excavator",
        "Bucket Size": "15 Inch",
        "Bucket Type": "Tooth Bucket",
        Bucket: "Cleanup Bucket",
        "Quick Coupler": "Yes",
        "Auxiliary Hydraulics": "Yes",
        "Track Type": "Rubber",
        "Track Width": "9 Inch",
        Blade: "Front Dozer Blade",
        "Engine Manufacturer": "Isuzu",
        "Engine Model": "Isuzu",
        "Fuel Type": "Diesel",
        "Cab Type": "Isuzu",
        ROPS: "Yes",
        "Engine Hours (Showing Unverified)": "2,458 Hr",
        Hours: "2,458 Hr",
      },
    });

    const specs = normalized.condition_report_specs as Record<string, string>;
    expect(specs["Engine Hours (Showing Unverified)"]).toBe("2,458 Hours");
    expect(specs.Hours).toBeUndefined();
    expect(specs["Bucket Type"]).toBe("Tooth Bucket");
    expect(specs.Bucket).toBeUndefined();
    expect(specs["Bucket Size"]).toBe("15 Inch");
    expect(specs["Engine Manufacturer"]).toBe("Isuzu");
    expect(specs["Engine Model"]).toBeUndefined();
    expect(specs["Cab Type"]).toBe("Isuzu");
  });

  it("does not derive engine model, manufacturer, or horsepower from a generic Engine label", () => {
    const rows = populatedRows({
      categories: "Excavators",
      description: "Engine: Isuzu",
    });
    const fields = new Map(rows.map((row) => [row.field, row.value]));

    expect(fields.has("Engine Manufacturer")).toBe(false);
    expect(fields.has("Engine Model")).toBe(false);
    expect(fields.has("Engine/HP")).toBe(false);
  });

  it("derives engine fields when each value has an explicit label", () => {
    const rows = populatedRows({
      categories: "Excavators",
      description:
        "Engine Manufacturer: Isuzu; Engine Model: 4JJ1; Engine/HP: 50 HP",
    });
    const fields = new Map(rows.map((row) => [row.field, row.value]));

    expect(fields.get("Engine Manufacturer")).toBe("Isuzu");
    expect(fields.get("Engine Model")).toBe("4JJ1");
    expect(fields.get("Engine/HP")).toBe("50 HP");
  });

  it("uses canonical aliases for deletion metadata and custom ordering", () => {
    const normalized = normalizeAuctioneerLotSpecs({
      categories: "Excavators",
      condition_report_specs: {
        Hours: "2,458 Hr",
        Bucket: "Tooth Bucket",
        "Bucket Size": "15 Inch",
      },
      condition_report_specs_deleted: ["Hour Meter"],
      condition_report_specs_custom_order: ["Bucket", "Showing Hours", "Bucket Size"],
    });

    expect(normalized.condition_report_specs_deleted).toEqual([
      "Engine Hours (Showing Unverified)",
    ]);
    expect(normalized.condition_report_specs_custom_order).toEqual([
      "Bucket Type",
      "Engine Hours (Showing Unverified)",
      "Bucket Size",
    ]);
    expect(normalized.condition_report_specs).toMatchObject({
      "Bucket Type": "Tooth Bucket",
      "Bucket Size": "15 Inch",
    });
    expect(normalized.condition_report_specs.Hours).toBeUndefined();
  });

  it("treats a saved custom order as authoritative for configured category fields", () => {
    const lot = {
      categories: "Excavators",
      condition_report_specs: {
        "Serial Number": "FF017Z210620",
        "Has Key": "Yes",
        "Running Condition": "Starts And Runs",
        "Bucket Type": "Tooth Bucket",
      },
      condition_report_specs_custom_order: [
        "Running Condition",
        "Has Key",
        "Bucket Type",
        "Serial Number",
      ],
    };

    const rows = populatedRows(lot);
    expect(rows.map((row) => row.field)).toEqual([
      "Running Condition",
      "Has Key",
      "Bucket Type",
      "Serial Number",
    ]);

    const normalized = normalizeAuctioneerLotSpecs(lot);
    expect(Object.keys(normalized.condition_report_specs)).toEqual([
      "Running Condition",
      "Has Key",
      "Bucket Type",
      "Serial Number",
    ]);
  });

  it("treats the latest Legal selection as authoritative over a stale mapped spec", () => {
    const selected = {
      categories: "Control Van",
      condition_report_selections: { legal: "Salvage" },
      condition_report_specs: { "Ownership Type": "No Title" },
    };

    const rows = populatedRows(selected);
    expect(rows.find((row) => row.field === "Ownership Type")?.value).toBe(
      "Salvage"
    );
    expect(normalizeAuctioneerLotSpecs(selected).condition_report_specs).toMatchObject({
      "Ownership Type": "Salvage",
    });

    const cleared = {
      ...selected,
      description: "Ownership Type: No Title",
      condition_report_selections: { legal: "N/A" },
      condition_report_specs: { "Title Status": "No Title" },
    };
    expect(
      populatedRows(cleared).some((row) => row.field === "Ownership Type")
    ).toBe(false);
    expect(normalizeAuctioneerLotSpecs(cleared).condition_report_specs).toEqual({});

    const portableRows = buildAuctioneerSpecRows(
      {
        categories: "Portable Structures",
        condition_report_selections: { legal: "N/A" },
        condition_report_specs: { "Registration History": "No Title" },
      },
      { includeMissing: true }
    );
    expect(
      portableRows.some((row) =>
        ["Ownership Type", "Title Status", "Registration History"].includes(
          row.field
        )
      )
    ).toBe(false);
  });

  it("writes the latest Legal selection to Asset XLSX and removes a stale value for N/A", async () => {
    const buffer = await generateAssetXlsxFromReport({
      include_damage_analysis: false,
      lots: [
        {
          lot_number: "1",
          categories: "Control Van",
          condition_report_selections: { legal: "Salvage" },
          condition_report_specs: { "Ownership Type": "No Title" },
        },
        {
          lot_number: "2",
          categories: "Control Van",
          description: "Ownership Type: No Title",
          condition_report_selections: { legal: "N/A" },
          condition_report_specs: { "Title Status": "No Title" },
        },
      ],
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.getWorksheet("Sheet1");
    expect(worksheet).toBeTruthy();

    const headers = (worksheet!.getRow(1).values as any[]).map((value) =>
      String(value ?? "")
    );
    const conditionReportColumn = headers.indexOf("Condition Report");
    expect(conditionReportColumn).toBeGreaterThan(0);

    const selectedHtml = String(
      worksheet!.getRow(2).getCell(conditionReportColumn).value ?? ""
    );
    expect(selectedHtml).toContain("Ownership Type");
    expect(selectedHtml).toContain("Salvage");
    expect(selectedHtml).not.toContain("No Title");

    const clearedHtml = String(
      worksheet!.getRow(3).getCell(conditionReportColumn).value ?? ""
    );
    expect(clearedHtml).not.toContain("Ownership Type");
    expect(clearedHtml).not.toContain("Title Status");
    expect(clearedHtml).not.toContain("No Title");
  });

  it("keeps sanitized importer-compatible HTML in the XLSX Condition Report cell", async () => {
    const buffer = await generateAssetXlsxFromReport({
      include_damage_analysis: false,
      cr_disclaimers: {
        customText:
          '<p onclick="steal()">Editable <strong>condition note</strong></p><script>alert(1)</script>',
      },
      lots: [
        {
          lot_number: "1000",
          categories: "Excavators",
          condition_report_specs: {
            "Serial Number": "FF017Z210620",
            "Has Key": "Yes",
            "Running Condition": "Starts And Runs",
            "Bucket Type": "Tooth Bucket",
          },
          condition_report_specs_custom_order: [
            "Running Condition",
            "Has Key",
            "Serial Number",
            "Bucket Type",
          ],
        },
      ],
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const conditionReport = workbook.getWorksheet("Sheet1")?.getCell("Q2").value;

    expect(typeof conditionReport).toBe("string");
    expect(conditionReport).toContain("<table");
    expect(conditionReport).toContain("<strong>condition note</strong>");
    expect(conditionReport).not.toContain("onclick");
    expect(conditionReport).not.toContain("<script");
    expect(conditionReport).not.toHaveProperty("richText");
    expect(conditionReport.indexOf("Running Condition")).toBeLessThan(
      conditionReport.indexOf("Has Key")
    );
    expect(conditionReport.indexOf("Has Key")).toBeLessThan(
      conditionReport.indexOf("Serial Number")
    );
  });

  it("writes the public bank-enabled CR URL to the Schedule A column", async () => {
    const scheduleAUrl =
      "https://images.sellsnap.store/previews/contract-asset-listing-abc123-schedule-a.pdf";
    const buffer = await generateAssetXlsxFromReport({
      schedule_a_pdf_url: scheduleAUrl,
      lots: [
        {
          lot_number: "12",
          title: "Test asset",
          description: "Test asset",
        },
      ],
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.getWorksheet("Sheet1");
    expect(worksheet).toBeTruthy();

    const headers = (worksheet!.getRow(1).values as any[]).map((value) =>
      String(value ?? "")
    );
    const scheduleAColumn = headers.indexOf("Schedule A");
    expect(scheduleAColumn).toBeGreaterThan(0);
    expect(worksheet!.getRow(2).getCell(scheduleAColumn).value).toBe(scheduleAUrl);
  });

  it("omits the Asset-only Schedule A column from Lot Listing workbooks", async () => {
    const scheduleAUrl =
      "https://images.sellsnap.store/lot-listings/contract-lot-listing-abc123-schedule-a.pdf";
    const buffer = await generateLotListingXlsxFromReport({
      schedule_a_pdf_url: scheduleAUrl,
      lots: [
        {
          lot_number: "12",
          title: "Test lot listing",
          description: "Test lot listing",
        },
      ],
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const worksheet = workbook.getWorksheet("Sheet1");
    expect(worksheet).toBeTruthy();

    const headers = (worksheet!.getRow(1).values as any[]).map((value) =>
      String(value ?? "")
    );
    expect(headers).not.toContain("Schedule A");
    expect(headers.at(-1)).toBe("Condition Report");
    expect(headers).not.toContain("YouTube Video URL");
    expect(worksheet!.getRow(2).values).not.toContain(scheduleAUrl);
  });
});
