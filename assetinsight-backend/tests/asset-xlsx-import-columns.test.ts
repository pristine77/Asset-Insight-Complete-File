import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import {
  generateAssetXlsxFromReport,
  generateLotListingXlsxFromReport,
} from "../src/service/xlsx/assetXlsxService.js";

const fullTrailerTitle =
  "Frac Shack NGC-11, EG-13, EB7 Mobile Diesel Refuelling Station Mounted on 2020 Concor Tria Step Deck Trailer";
const unreservedSuffix =
  "<br/><span style='color:#FFFFFF;background-color:#FF0000'>UNRESERVED</span>";

async function readFirstDataRow(
  reportData: Record<string, unknown>,
  generateWorkbook = generateAssetXlsxFromReport
) {
  const buffer = await generateWorkbook(reportData);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.getWorksheet("Sheet1");
  if (!worksheet) throw new Error("Expected generated Sheet1 worksheet");

  const values = new Map<string, ExcelJS.CellValue>();
  worksheet.getRow(1).eachCell((cell, columnNumber) => {
    values.set(String(cell.value), worksheet.getRow(2).getCell(columnNumber).value);
  });
  return values;
}

describe("asset XLSX auction import columns", () => {
  it("puts the saved Title in Description and fixes auction defaults", async () => {
    const row = await readFirstDataRow({
      include_damage_analysis: false,
      cr_disclaimers: {
        unreserved: true,
      },
      lots: [
        {
          lot_id: "bmw-318i",
          lot_number: "150",
          title: "1984 BMW 318i Coupe Car",
          description: "1984 BMW 318i 2-Door Coupe, 5-Speed Manual",
          quantity: 5,
          must_take: true,
        },
      ],
    });

    expect(row.get("Description")).toBe(
      "1984 BMW 318i Coupe Car<br/><span style='color:#FFFFFF;background-color:#FF0000'>UNRESERVED</span>"
    );
    expect(row.get("Quantity")).toBe(1);
    expect(row.get("Must Take")).toBeNull();
  });

  it("copies a report-level inspection location and exact coordinates into Asset rows", async () => {
    const row = await readFirstDataRow({
      location: "1450 Example Industrial Road, Winnipeg, MB R3H 0A1",
      latitude: 49.903271,
      longitude: -97.210846,
      lots: [
        {
          lot_id: "asset-location-fallback",
          lot_number: "1",
          title: "Location fallback asset",
          description: "Location fallback asset",
        },
      ],
    });

    expect(row.get("Location")).toBe(
      "1450 Example Industrial Road, Winnipeg, MB R3H 0A1"
    );
    expect(row.get("Latitude")).toBe(49.903271);
    expect(row.get("Longitude")).toBe(-97.210846);
  });

  it("copies report-level location coordinates through the Lot Listing wrapper", async () => {
    const row = await readFirstDataRow(
      {
        location: "88 Field Inspection Lane, Brandon, MB R7A 0A1",
        latitude: 49.842117,
        longitude: -99.953461,
        lots: [
          {
            lot_id: "lot-listing-location-fallback",
            lot_number: "2",
            title: "Location fallback lot listing",
            description: "Location fallback lot listing",
          },
        ],
      },
      generateLotListingXlsxFromReport
    );

    expect(row.get("Location")).toBe(
      "88 Field Inspection Lane, Brandon, MB R7A 0A1"
    );
    expect(row.get("Latitude")).toBe(49.842117);
    expect(row.get("Longitude")).toBe(-99.953461);
  });

  it("keeps explicit lot coordinates ahead of report-level coordinate defaults", async () => {
    const row = await readFirstDataRow({
      location: "245 Precise Location Road, Regina, SK S4N 0A1",
      latitude: 50.450001,
      longitude: -104.610001,
      lots: [
        {
          lot_id: "asset-location-override",
          lot_number: "3",
          title: "Precisely located asset",
          description: "Precisely located asset",
          location: "245 Precise Location Road, Regina, SK S4N 0A1",
          latitude: 50.450789,
          longitude: -104.610987,
        },
      ],
    });

    expect(row.get("Location")).toBe(
      "245 Precise Location Road, Regina, SK S4N 0A1"
    );
    expect(row.get("Latitude")).toBe(50.450789);
    expect(row.get("Longitude")).toBe(-104.610987);
  });

  it.each([
    ["null pair", null, null],
    ["partial pair", 50.45, undefined],
    ["out-of-range latitude", 91, -104.61],
    ["out-of-range longitude", 50.45, -181],
  ])("does not emit invalid %s coordinates into Excel", async (_label, latitude, longitude) => {
    const row = await readFirstDataRow(
      {
        location: "Readable Custom Inspection Site",
        latitude,
        longitude,
        lots: [
          {
            lot_id: `invalid-coordinate-${_label}`,
            lot_number: "4",
            title: "Invalid coordinate test",
            description: "Invalid coordinate test",
          },
        ],
      },
      generateLotListingXlsxFromReport
    );

    expect(row.get("Latitude")).toMatchObject({ formula: expect.any(String) });
    expect(row.get("Longitude")).toMatchObject({ formula: expect.any(String) });
  });
});

describe.each([
  ["Asset", generateAssetXlsxFromReport],
  ["Lot Listing", generateLotListingXlsxFromReport],
] as const)("%s XLSX full descriptions", (_reportType, generateWorkbook) => {
  it("retains the complete saved Title instead of the separate narrative", async () => {
    const row = await readFirstDataRow({
      lots: [{
        lot_number: "2043",
        title: fullTrailerTitle,
        description: "Separate narrative must not replace the reviewed Title",
      }],
    }, generateWorkbook);

    expect(row.get("Lot #")).toBe("2043");
    expect(row.get("Description")).toBe(fullTrailerTitle);
    expect(String(row.get("Description"))).toContain("Step Deck Trailer");
  });

  it("uses the complete Title when the Description is blank", async () => {
    const row = await readFirstDataRow({
      lots: [{ lot_number: "2043", title: fullTrailerTitle, description: "  " }],
    }, generateWorkbook);
    expect(row.get("Description")).toBe(fullTrailerTitle);
  });

  it("keeps a saved sentence's closing full stop", async () => {
    const title = "Mobile diesel refuelling station on a 2020 Concor step deck trailer.";
    const row = await readFirstDataRow({ lots: [{ title, description: "Separate narrative" }] }, generateWorkbook);
    expect(row.get("Description")).toBe(title);
  });

  it.each([60, 61, 500])("retains all %i characters, including unbroken text", async (length) => {
    const title = "É".repeat(length);
    const row = await readFirstDataRow({ lots: [{ title, description: "Separate narrative" }] }, generateWorkbook);
    expect(row.get("Description")).toBe(title);
  });

  it("cleans existing markup without shortening text or duplicating UNRESERVED", async () => {
    const row = await readFirstDataRow({
      cr_disclaimers: { unreserved: true },
      lots: [{ title: `<b>${fullTrailerTitle}</b>${unreservedSuffix}`, description: "Separate narrative" }],
    }, generateWorkbook);

    expect(row.get("Description")).toBe(`${fullTrailerTitle}${unreservedSuffix}`);
  });

  it("keeps a saved multi-line Title whole, on one line, with its serial evidence", async () => {
    const row = await readFirstDataRow({
      lots: [{
        title: `${fullTrailerTitle}\nSerial Number: 2G9DS63T8LB105043`,
        description: "Separate narrative",
      }],
    }, generateWorkbook);

    expect(row.get("Description")).toBe(`${fullTrailerTitle} Serial Number: 2G9DS63T8LB105043`);
    expect(row.get("Serial Number")).toBe("2G9DS63T8LB105043");
  });

  it("keeps long titles, source order and workbook layout across a large report without mutating narratives", async () => {
    const lots = Array.from({ length: 200 }, (_, index) => ({
      lot_id: `trailer-${index}`,
      lot_number: String(2043 + index),
      title: `${fullTrailerTitle} — unit ${index + 1}`,
      description: `Saved detailed notes for unit ${index + 1}.\nSecond paragraph remains saved.`,
    }));
    const report = { lots };
    const original = structuredClone(report);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await generateWorkbook(report));
    const sheet = workbook.getWorksheet("Sheet1")!;

    for (const [index, lot] of lots.entries()) {
      expect(sheet.getCell(index + 2, 1).value).toBe(lot.lot_number);
      expect(sheet.getCell(index + 2, 2).value).toBe(lot.title);
      expect(sheet.getCell(index + 2, 2).alignment).toMatchObject({
        wrapText: true, vertical: "top",
      });
    }
    expect(sheet.getColumn(2).width).toBe(60);
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(workbook.worksheets.map((entry) => entry.name)).toEqual(["Sheet1", "Menis", "Instructions"]);
    expect(sheet.getRow(1).values).toEqual([
      undefined, "Lot #", "Description", "Serial Number", "Categories", "Bid Increment",
      "Opening Bid", "Contract #", "Quantity", "Must Take", "Show On Website", "Close Date",
      "Location", "Latitude", "Longitude", "Item Condition", "Lotted By", "Condition Report",
      ...(_reportType === "Asset" ? ["Schedule A"] : []),
    ]);
    expect(report).toEqual(original);
  });

  it("preserves the complete item Title when flattening grouped lots", async () => {
    const row = await readFirstDataRow({
      grouping_mode: "per_item",
      lots: [{
        lot_number: "2043", title: "Parent grouping title",
        description: "Parent narrative",
        items: [{ title: fullTrailerTitle, description: "Separate item narrative" }],
      }],
    }, generateWorkbook);
    expect(row.get("Description")).toBe(fullTrailerTitle);
  });
});
