import mongoose from "mongoose";
import ExcelJS from "exceljs";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildDefaultAssetAdminScheduleSheet,
  calculateAssetAdminScheduleSheet,
} from "../src/service/assetAdminScheduleSheetService.js";
import {
  generateAssetXlsxFromReport,
  generateLotListingXlsxFromReport,
} from "../src/service/xlsx/assetXlsxService.js";

let mongo: MongoMemoryServer;
let AssetReport: typeof import("../src/models/asset.model.js")["default"];
let LotListing: typeof import("../src/models/lotListing.model.js")["default"];
let getExcelConditionReports: typeof import("../src/service/excelConditionReportService.js")["getExcelConditionReports"];
let saveExcelConditionReports: typeof import("../src/service/excelConditionReportService.js")["saveExcelConditionReports"];
let buildSpecReportData: typeof import("../src/service/auctioneerSpecPdfRefreshService.js")["buildSpecReportData"];
let getCanonicalProposalValuationSheet: typeof import("../src/service/proposalValuationService.js")["getCanonicalProposalValuationSheet"];

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  ({ default: AssetReport } = await import("../src/models/asset.model.js"));
  ({ default: LotListing } = await import("../src/models/lotListing.model.js"));
  ({ getExcelConditionReports, saveExcelConditionReports } = await import(
    "../src/service/excelConditionReportService.js"
  ));
  ({ buildSpecReportData } = await import(
    "../src/service/auctioneerSpecPdfRefreshService.js"
  ));
  ({ getCanonicalProposalValuationSheet } = await import(
    "../src/service/proposalValuationService.js"
  ));
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe.sequential("Excel Condition Report disclaimer grouping", () => {
  it("keeps saved, newly added and cleared blanks without materializing category templates", async () => {
    const lots = [{ lot_id: "blank-authority", lot_number: "1826", title: "Structure", description: "Reviewed structure", categories: "Portable Structures",
      condition_report_specs_reviewed: true, condition_report_specs: { "Overall Width": "20 ft", "Overall Height": "", "Other Details": "Retain" },
      condition_report_specs_manual_overrides: { "Serial Number": "", "Deleted Legacy Field": "" },
      condition_report_specs_deleted: ["Deleted Legacy Field"], image_indexes: [] }];
    const report = await AssetReport.create({ user: new mongoose.Types.ObjectId(), grouping_mode: "single_lot", imageUrls: [], status: "approved", lots,
      preview_data: { lots: structuredClone(lots) } });
    const loaded = await getExcelConditionReports(String(report._id));
    const rows = loaded.rows.map(row => ({ ...row, specs: [...row.specs.map(spec => spec.field === "Overall Width" ? { ...spec, value: "" } : spec),
      { field: "New Empty Detail", value: "", deleted: false }] }));
    await saveExcelConditionReports(String(report._id), { revision: loaded.revision, rows });
    let persisted: any = await AssetReport.findById(report._id).lean();
    const expected = { "Overall Width": "", "Overall Height": "", "Other Details": "Retain", "New Empty Detail": "" };
    expect(persisted.preview_data.lots[0].condition_report_specs).toEqual(expected);
    expect(persisted.preview_data.lots[0].condition_report_specs_manual_overrides).toMatchObject({ "Serial Number": "", "Deleted Legacy Field": "" });
    const reopened = await getExcelConditionReports(String(report._id));
    expect(reopened.rows[0].specs.find(row => row.field === "New Empty Detail")?.value).toBe("");
    await saveExcelConditionReports(String(report._id), { revision: reopened.revision, rows: reopened.rows });
    persisted = await AssetReport.findById(report._id).lean();
    expect(persisted.preview_data.lots[0].condition_report_specs).toEqual(expected);
    expect(persisted.preview_data.lots[0].condition_report_specs_deleted).toContain("Deleted Legacy Field");
  });

  it("does not reopen or save stale manual values into a reviewed empty table", async () => {
    const lots = [{ lot_id: "reviewed-empty", lot_number: "1826", title: "Empty table", description: "Reviewed structure", categories: "Portable Structures",
      condition_report_specs_reviewed: true, condition_report_specs: {}, condition_report_specs_manual_overrides: { "Overall Width": "20 ft", "Width": "20 ft" },
      image_indexes: [] }];
    const report = await AssetReport.create({ user: new mongoose.Types.ObjectId(), grouping_mode: "single_lot", imageUrls: [], status: "approved", lots,
      preview_data: { lots: structuredClone(lots) } });
    const loaded = await getExcelConditionReports(String(report._id));
    expect(loaded.rows[0].specs.filter(row => !!row.value)).toEqual([]);
    await saveExcelConditionReports(String(report._id), { revision: loaded.revision, rows: loaded.rows });
    const reopened = await getExcelConditionReports(String(report._id));
    expect(reopened.rows[0].specs.filter(row => !!row.value)).toEqual([]);
    const persisted: any = await AssetReport.findById(report._id).lean();
    expect(Object.values(persisted.preview_data.lots[0].condition_report_specs || {}).some(Boolean)).toBe(false);
    expect(persisted.preview_data.lots[0].condition_report_specs_reviewed).toBe(true);
  });

  it("saves CR blanks and explicit re-adds without old alias tombstones or prose refills", async () => {
    const lots = [{ lot_id: "reviewed-controls", lot_number: "1826", title: "Structure", categories: "Portable Structures",
      description: "Overall Height: 12 ft", condition_report_specs: { "Overall Width": "20 ft", "Overall Height": "12 ft" },
      hidden_condition_report_specs: { Width: true, Colour: true }, condition_report_specs_deleted: ["Length"], image_indexes: [] }];
    const report = await AssetReport.create({ user: new mongoose.Types.ObjectId(), grouping_mode: "single_lot", imageUrls: [], status: "approved", lots,
      preview_data: { lots: structuredClone(lots) } });
    const loaded = await getExcelConditionReports(String(report._id));
    expect(loaded.rows[0].specs.some(row => row.field === "Overall Width")).toBe(false);
    expect(loaded.rows[0].specs.some(row => row.field === "Colour")).toBe(false);
    await saveExcelConditionReports(String(report._id), { revision: loaded.revision, rows: loaded.rows.map(row => ({ ...row,
      specs: [{ field: "Overall Width", value: "18 ft", deleted: false }, { field: "Overall Height", value: "", deleted: false }],
    })) });
    const persisted = await AssetReport.findById(report._id).lean(), saved = (persisted as any).preview_data.lots[0];
    expect(saved.condition_report_specs).toEqual({ "Overall Width": "18 ft", "Overall Height": "" });
    expect(saved.condition_report_specs_reviewed).toBe(true);
    expect(saved.hidden_condition_report_specs).toEqual({ Colour: true });
    expect(saved.condition_report_specs_deleted).toEqual(["Overall Length"]);
    const reopened = await getExcelConditionReports(String(report._id));
    expect(reopened.rows[0].specs.find(row => row.field === "Overall Width")?.value).toBe("18 ft");
    expect(reopened.rows[0].specs.find(row => row.field === "Overall Height")?.value).toBe("");
    expect(reopened.rows[0].specs.some(row => row.deleted)).toBe(false);
  });

  it("does not inherit parent spec controls into independently reviewed catalogue items", async () => {
    const lots = [{ lot_id: "reviewed-parent", lot_number: "1826", title: "Parent", categories: "Portable Structures",
      condition_report_specs_reviewed: true, condition_report_specs: { "Overall Width": "20 ft" },
      condition_report_specs_manual_overrides: { Width: "20 ft" }, condition_report_specs_deleted: ["Internal Width"],
      image_indexes: [], items: [
        { title: "Empty child", condition_report_specs_reviewed: true, condition_report_specs: {} },
        { title: "Edited child", condition_report_specs_reviewed: true, condition_report_specs: { "Overall Width": "11 ft", "Internal Width": "8 ft" } },
      ] }];
    const report = await AssetReport.create({ user: new mongoose.Types.ObjectId(), grouping_mode: "catalogue", imageUrls: [],
      status: "approved", include_damage_analysis: false, lots, preview_data: { lots: structuredClone(lots) } });
    const loaded = await getExcelConditionReports(String(report._id));
    const filled = (index: number) => Object.fromEntries(loaded.rows[index].specs.filter(row => row.value && !row.deleted).map(row => [row.field, row.value]));
    expect(filled(0)).toEqual({});
    expect(filled(1)).toEqual({ "Overall Width": "11 ft", "Internal Width": "8 ft" });
    const persisted = await AssetReport.findById(report._id).lean();
    expect((persisted as any).preview_data.lots[0].condition_report_specs).toEqual({ "Overall Width": "20 ft" });
    // Mongo/Mongoose can minimize an empty object; its explicit reviewed marker
    // remains the empty-table authority on reopening.
    expect((persisted as any).preview_data.lots[0].items[0].condition_report_specs || {}).toEqual({});
    expect((persisted as any).preview_data.lots[0].items[0].condition_report_specs_reviewed).toBe(true);
  });

  it("does not apply the parent's reviewed marker to an omitted legacy child table", async () => {
    const lots = [{ lot_id: "legacy-child-parent", lot_number: "1826", title: "Parent", categories: "Portable Structures",
      condition_report_specs_reviewed: true, condition_report_specs: { "Overall Width": "20 ft" }, image_indexes: [],
      items: [{ title: "Legacy child", serial_number: "CHILD-98765" }] }];
    const report = await AssetReport.create({ user: new mongoose.Types.ObjectId(), grouping_mode: "catalogue", imageUrls: [],
      status: "approved", include_damage_analysis: false, lots, preview_data: { lots: structuredClone(lots) } });
    const loaded = await getExcelConditionReports(String(report._id));
    expect(loaded.rows[0].specs.find(row => row.field === "Serial Number")?.value).toContain("CHILD-98765");
    const persisted: any = await AssetReport.findById(report._id).lean();
    expect(persisted.preview_data.lots[0].items[0].condition_report_specs_reviewed).toBeUndefined();
    expect(persisted.preview_data.lots[0].items[0].serial_number).toBe("CHILD-98765");
  });

  it.each(["asset", "lotListing"])("persists a reviewed %s serial through reopen and XLSX regeneration", async (kind) => {
    const oldSerial = "1FTWW3DR9AEA01450";
    const correctedSerial = "1FTWW3DR9AEA01459";
    const lots = [{
      lot_id: "serial-correction",
      lot_number: "222",
      title: "Ford truck",
      serial_number: oldSerial,
      serial_no_or_label: oldSerial,
      sn_vin: oldSerial,
      description: `Earlier inspection VIN: ${oldSerial}`,
      condition_report_specs: { "Serial Number": oldSerial, "Engine Serial Number": "ENGINE-100" },
      deleted_condition_report_specs: ["VIN", "Colour"],
      removed_condition_report_specs: { "S. No": true, Hours: true },
      hidden_condition_report_specs: ["Serial Number (Unverified)", "Make"],
      image_indexes: [],
    }];
    const input = {
      user: new mongoose.Types.ObjectId(),
      contract_no: "SERIAL-REGRESSION",
      sales_date: "2026-09-25",
      location: "Regina, SK",
      grouping_mode: "single_lot",
      imageUrls: [],
      status: "approved",
      include_damage_analysis: false,
      lots,
      preview_data: { include_damage_analysis: false, lots: structuredClone(lots) },
    };
    const report = kind === "asset"
      ? await AssetReport.create(input)
      : await LotListing.create(input);
    const loadStored = () => kind === "asset"
      ? AssetReport.findById(report._id).lean()
      : LotListing.findById(report._id).lean();
    const generateWorkbook = kind === "asset" ? generateAssetXlsxFromReport : generateLotListingXlsxFromReport;

    for (const serial of [correctedSerial, "", "REENTERED-123"]) {
      const loaded = await getExcelConditionReports(String(report._id));
      await saveExcelConditionReports(String(report._id), {
        revision: loaded.revision,
        rows: loaded.rows.map((row) => ({
          ...row,
          specs: [
            ...row.specs.filter((spec) => spec.field !== "Serial Number"),
            { field: "Serial Number", value: serial, deleted: false },
          ],
        })),
      });
      const reopened = await getExcelConditionReports(String(report._id));
      expect(reopened.rows[0].specs.find((spec) => spec.field === "Serial Number")?.value).toBe(serial);
      const persisted: any = await loadStored();
      expect(persisted.preview_data.lots[0].serial_number).toBe(serial);
      expect(persisted.lots[0].serial_number).toBe(serial);
      expect(persisted.preview_data.lots[0].condition_report_specs_manual_overrides["Serial Number"]).toBe(serial);
      // Asset's Mixed preview retains legacy keys; Lot Listing's strict schema
      // does not persist these obsolete collections in newly saved records.
      if (kind === "asset") {
        expect(persisted.preview_data.lots[0].deleted_condition_report_specs).toEqual(["Colour"]);
        expect(persisted.preview_data.lots[0].removed_condition_report_specs).toEqual({ Hours: true });
        expect(persisted.preview_data.lots[0].hidden_condition_report_specs).toEqual(["Make"]);
      }
      const generatorData = buildSpecReportData(persisted);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await generateWorkbook(generatorData));
      const sheet = workbook.getWorksheet("Sheet1")!;
      const headers = sheet.getRow(1).values as string[];
      expect(sheet.getRow(2).getCell(headers.indexOf("Serial Number")).value).toBe(serial);
      if (kind === "asset") {
        expect(getCanonicalProposalValuationSheet(persisted).rows[0].serial_number).toBe(serial);
      }
    }
  });

  it("groups nested rows by their parent and keeps duplicate displayed lot numbers separate", async () => {
    const lots = [
      {
        lot_id: "catalogue-parent",
        lot_number: "77",
        title: "Catalogue parent",
        description: "Catalogue parent",
        image_indexes: [],
        items: [
          { title: "Catalogue item A", condition_report_specs: { Colour: "Red" } },
          { title: "Catalogue item B", condition_report_specs: { Colour: "Blue" } },
        ],
      },
      {
        lot_id: "standalone-parent",
        lot_number: "77",
        title: "Standalone lot",
        description: "Standalone lot",
        image_indexes: [],
        condition_report_specs: { Colour: "Green" },
      },
    ];
    const report = await AssetReport.create({
      user: new mongoose.Types.ObjectId(),
      grouping_mode: "catalogue",
      imageUrls: [],
      status: "approved",
      include_damage_analysis: false,
      lots,
      preview_data: {
        include_damage_analysis: false,
        lots: JSON.parse(JSON.stringify(lots)),
      },
    });

    const loaded = await getExcelConditionReports(String(report._id));

    expect(loaded.rows).toHaveLength(3);
    expect(loaded.rows.map((row) => row.lotNumber)).toEqual(["77", "77", "77"]);
    expect(loaded.rows.map((row) => row.disclaimerLotKey)).toEqual([
      "catalogue-parent",
      "catalogue-parent",
      "standalone-parent",
    ]);
    expect(new Set(loaded.rows.map((row) => row.disclaimerLotKey))).toHaveLength(2);

    const saved = await saveExcelConditionReports(String(report._id), {
      revision: loaded.revision,
      rows: loaded.rows.map((row) => ({
        ...row,
        disclaimerLotKey: "forged-client-group",
      })),
    });

    expect(saved.rows.map((row) => row.disclaimerLotKey)).toEqual([
      "catalogue-parent",
      "catalogue-parent",
      "standalone-parent",
    ]);
  });

  it("persists edited titles and multiline damage for standalone and catalogue rows", async () => {
    const lots = [
      {
        lot_id: "catalogue-parent",
        lot_number: "7",
        title: "Catalogue parent",
        description: "Catalogue parent",
        image_indexes: [],
        items: [
          {
            title: "Original catalogue item",
            damage_analysis: "Original item damage",
            condition_report_specs: { Colour: "Red" },
          },
        ],
      },
      {
        lot_id: "standalone-parent",
        lot_number: "8",
        title: "Original standalone lot",
        description: "Original standalone lot",
        image_indexes: [],
        damage_analysis: "Original standalone damage",
        condition_report_specs: { Colour: "Green" },
      },
    ];
    const report = await AssetReport.create({
      user: new mongoose.Types.ObjectId(),
      grouping_mode: "catalogue",
      imageUrls: [],
      status: "approved",
      include_damage_analysis: true,
      lots,
      preview_data: {
        include_damage_analysis: true,
        lots: JSON.parse(JSON.stringify(lots)),
      },
    });

    const loaded = await getExcelConditionReports(String(report._id));
    const saved = await saveExcelConditionReports(String(report._id), {
      revision: loaded.revision,
      rows: loaded.rows.map((row, index) => ({
        ...row,
        title: index === 0 ? "Edited catalogue item" : "Edited standalone lot",
        damageAnalysis:
          index === 0
            ? "Bent Door\nBroken Latch"
            : "Damages To The Back Taillight\nMissing Handle",
      })),
    });

    expect(saved.rows.map((row) => row.title)).toEqual([
      "Edited catalogue item",
      "Edited standalone lot",
    ]);
    expect(saved.rows.map((row) => row.damageAnalysis)).toEqual([
      "Bent Door\nBroken Latch",
      "Damages To The Back Taillight\nMissing Handle",
    ]);

    const reloaded = await getExcelConditionReports(String(report._id));
    expect(reloaded.rows.map((row) => row.title)).toEqual([
      "Edited catalogue item",
      "Edited standalone lot",
    ]);
    expect(reloaded.rows.map((row) => row.damageAnalysis)).toEqual([
      "Bent Door\nBroken Latch",
      "Damages To The Back Taillight\nMissing Handle",
    ]);

    const persisted = await AssetReport.findById(report._id).lean();
    const generatorData = buildSpecReportData(persisted);
    expect(generatorData.lots[0].items[0]).toMatchObject({
      title: "Edited catalogue item",
      damage_analysis: "Bent Door\nBroken Latch",
    });
    expect(generatorData.lots[1]).toMatchObject({
      title: "Edited standalone lot",
      damage_analysis: "Damages To The Back Taillight\nMissing Handle",
    });
  });

  it("projects Asset Excel/CR review edits into PV while retaining PV-only work", async () => {
    const lot = {
      lot_id: "asset-excel-pv-lot",
      lot_number: "18",
      title: "Original Excel review title",
      description: "Original report description",
      categories: "Original category",
      serial_number: "EXCEL-PV-123",
      serial_no_or_label: "EXCEL-PV-123",
      estimated_value: "CA$40,000",
      image_indexes: [],
      condition_report_specs: { Colour: "Blue" },
    };
    const previewData = {
      contract_no: "EXCEL-PV-SYNC",
      include_damage_analysis: true,
      lots: [lot],
    };
    const sourceSheet = buildDefaultAssetAdminScheduleSheet({
      lots: [lot],
      preview_data: previewData,
    } as any);
    const storedSheet = calculateAssetAdminScheduleSheet({
      evaluator_columns: [{ id: "legacy", name: "Legacy evaluator" }],
      rows: [
        {
          ...sourceSheet.rows[0],
          condition_score: "4",
          location: "Saskatoon, SK",
          market_check: {
            comparable_count: "High",
            avg_retail_asking_price: "Moderate",
            market_saturation: "Low",
            market_velocity: "Fast",
            regional_demand: "Strong",
            notes: "Keep Excel-save market work",
          },
          evaluator_values: { legacy: 42_500 },
          notes: "Keep Excel-save evaluator notes",
          lien_search: 155,
          video_cost: 85,
        },
      ],
      file_summary: {
        buyers_premium_basis: "capped",
        total_risk_weighted_value: 38_000,
        file_risk_multiplier: 0.91,
        commission_percent_no_guarantee: 10,
        offer2_nmg_percent: 0.82,
        capped_threshold_percent: 0.14,
      },
    });
    const report = await AssetReport.create({
      user: new mongoose.Types.ObjectId(),
      grouping_mode: "single_lot",
      imageUrls: [],
      status: "approved",
      contract_no: "EXCEL-PV-SYNC",
      include_damage_analysis: true,
      lots: [lot],
      proposal_valuation_revision: 7,
      preview_data: {
        ...previewData,
        admin_schedule_sheet: storedSheet,
      },
    });

    const loaded = await getExcelConditionReports(String(report._id));
    const saved = await saveExcelConditionReports(String(report._id), {
      revision: loaded.revision,
      rows: loaded.rows.map((row) => ({
        ...row,
        title: "Edited Excel review title",
        category: "Edited admin category",
      })),
    });

    expect(saved.reportType).toBe("Asset");
    expect(saved.rows[0]).toMatchObject({
      title: "Edited Excel review title",
      category: "Edited admin category",
    });
    const persisted = await AssetReport.findById(report._id).lean();
    expect((persisted as any)?.proposal_valuation_revision).toBe(8);
    expect((persisted as any)?.lots?.[0]).toMatchObject({
      title: "Edited Excel review title",
      categories: "Edited admin category",
    });
    expect((persisted as any)?.preview_data?.lots?.[0]).toMatchObject({
      title: "Edited Excel review title",
      categories: "Edited admin category",
    });
    const persistedSheet = (persisted as any)?.preview_data
      ?.admin_schedule_sheet;
    expect(persistedSheet.rows[0]).toMatchObject({
      asset_category: "Edited admin category",
      condition_score: "4",
      location: "Saskatoon, SK",
      evaluator_values: { legacy: 42_500 },
      notes: "Keep Excel-save evaluator notes",
      cleaning: 425,
      lien_search: 155,
      video_cost: 85,
      lotting_fee: 425,
      advertising: 425,
    });
    expect(persistedSheet.rows[0].market_check).toEqual({
      comparable_count: "High",
      avg_retail_asking_price: "Moderate",
      market_saturation: "Low",
      market_velocity: "Fast",
      regional_demand: "Strong",
      notes: "Keep Excel-save market work",
    });
    expect(persistedSheet.file_summary).toMatchObject({
      buyers_premium_basis: "capped",
      total_risk_weighted_value: 38_000,
      file_risk_multiplier: 0.91,
      commission_percent_no_guarantee: 10,
      offer2_nmg_percent: 0.82,
      capped_threshold_percent: 0.14,
    });
    expect(
      getCanonicalProposalValuationSheet(persisted as any).rows[0]
    ).toMatchObject({
      asset_category: "Edited admin category",
      evaluator_values: { legacy: 42_500 },
      notes: "Keep Excel-save evaluator notes",
    });
  });

  it("derives an updated Asset PV after an Excel/CR edit without creating an unsaved sheet", async () => {
    const lot = {
      lot_id: "asset-excel-unsaved-pv-lot",
      lot_number: "31",
      title: "Unsaved Excel PV title",
      description: "Original unsaved Excel description",
      categories: "Passenger Vehicles",
      estimated_value: "CA$12,000",
      image_indexes: [],
    };
    const report = await AssetReport.create({
      user: new mongoose.Types.ObjectId(),
      grouping_mode: "single_lot",
      imageUrls: [],
      status: "approved",
      contract_no: "EXCEL-UNSAVED-PV-SYNC",
      lots: [lot],
      proposal_valuation_revision: 2,
      preview_data: {
        contract_no: "EXCEL-UNSAVED-PV-SYNC",
        lots: [lot],
      },
    });

    const loaded = await getExcelConditionReports(String(report._id));
    await saveExcelConditionReports(String(report._id), {
      revision: loaded.revision,
      rows: loaded.rows.map((row) => ({
        ...row,
        category: "Edited before the first PV save",
      })),
    });

    const persisted = await AssetReport.findById(report._id).lean();
    expect((persisted as any)?.proposal_valuation_revision).toBe(3);
    expect(
      (persisted as any)?.preview_data?.admin_schedule_sheet
    ).toBeUndefined();
    expect(
      getCanonicalProposalValuationSheet(persisted as any).rows[0]
        ?.asset_category
    ).toBe("Edited before the first PV save");
  });

  it("keeps Lot Listing Excel/CR saves on the existing non-PV persistence path", async () => {
    const lot = {
      lot_id: "listing-excel-row",
      lot_number: "27",
      title: "Original listing title",
      description: "Original listing description",
      categories: "Original listing category",
      estimated_value: "CA$5,000",
      image_indexes: [],
      condition_report_specs: { Colour: "Red" },
    };
    const listing = await LotListing.create({
      user: new mongoose.Types.ObjectId(),
      contract_no: "LISTING-EXCEL-NON-PV",
      sales_date: new Date("2026-09-01T00:00:00.000Z"),
      location: "Regina, SK",
      imageUrls: [],
      videoUrls: [],
      lots: [lot],
      status: "approved",
      include_damage_analysis: true,
      preview_data: {
        contract_no: "LISTING-EXCEL-NON-PV",
        include_damage_analysis: true,
        lots: [lot],
      },
    });

    const loaded = await getExcelConditionReports(String(listing._id));
    const saved = await saveExcelConditionReports(String(listing._id), {
      revision: loaded.revision,
      rows: loaded.rows.map((row) => ({
        ...row,
        title: "Edited listing title",
        category: "Edited listing category",
      })),
    });

    expect(saved.reportType).toBe("LotListing");
    expect(saved.rows[0]).toMatchObject({
      title: "Edited listing title",
      category: "Edited listing category",
    });
    const persisted = await LotListing.findById(listing._id).lean();
    expect((persisted as any)?.lots?.[0]).toMatchObject({
      title: "Edited listing title",
      categories: "Edited listing category",
    });
    expect((persisted as any)?.preview_data?.lots?.[0]).toMatchObject({
      title: "Edited listing title",
      categories: "Edited listing category",
    });
    expect((persisted as any)?.proposal_valuation_revision).toBeUndefined();
    expect(
      (persisted as any)?.preview_data?.admin_schedule_sheet
    ).toBeUndefined();
  });
});
