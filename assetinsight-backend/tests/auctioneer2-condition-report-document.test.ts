import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCrDisclaimersForLot, normalizeCrDisclaimers } from "../src/utils/crDisclaimers.js";

/*
   Owner 2026-10-29: "make sure that each lot PDF reach auctioneer 2.0 as a
   pdf". Each lot's PDF is the report's condition report for that lot alone,
   built from the data the delivery froze.
*/

vi.mock("dotenv", () => ({ config: () => ({ parsed: {} }), default: { config: () => ({ parsed: {} }) } }));
vi.mock("../src/utils/openaiClient.js", () => ({ default: {} }));
const builder = vi.hoisted(() => ({ generateAuctioneerSpecSheetPdfFromReport: vi.fn() }));
vi.mock("../src/service/auctioneerSpecSheetPdfService.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/service/auctioneerSpecSheetPdfService.js")>(),
  generateAuctioneerSpecSheetPdfFromReport: builder.generateAuctioneerSpecSheetPdfFromReport,
}));

const { buildLotConditionReportPdf, isPdf, AUCTIONEER_CR_PDF_MAX_BYTES } = await import("../src/service/auctioneer2ConditionReportDocument.js");

const report = {
  _id: "report-1",
  contract_no: "825684",
  imageUrls: ["https://images.example/1.jpg", "https://images.example/2.jpg"],
  preview_data: {
    contract_no: "825684",
    lots: [
      { lot_id: "a", lot_number: "0645", title: "Tractor", image_indexes: [0] },
      { lot_id: "b", title: "Baler", image_indexes: [1] },
    ],
  },
};

beforeEach(() => {
  builder.generateAuctioneerSpecSheetPdfFromReport.mockReset().mockResolvedValue(Buffer.from("%PDF-1.7 one lot"));
});

describe("each lot's condition-report PDF", () => {
  it("builds the PDF from that lot alone, keeping its own lot number", async () => {
    const pdf = await buildLotConditionReportPdf({ report, lotIndex: 0, contractNo: "825684" });
    expect(pdf?.filename).toBe("contract-825684-lot-0645-condition-report.pdf");
    expect(isPdf(pdf!.bytes)).toBe(true);
    const [reportData] = builder.generateAuctioneerSpecSheetPdfFromReport.mock.calls[0];
    expect(reportData.lots).toHaveLength(1);
    expect(reportData.lots[0]).toMatchObject({ title: "Tractor", lot_number: "0645" });
    // The report's photos stay available to the lot's own image indexes.
    expect(reportData.imageUrls).toEqual(report.imageUrls);
  });

  it("numbers a lot without one by its place in the report, not as lot 1", async () => {
    const pdf = await buildLotConditionReportPdf({ report, lotIndex: 1 });
    expect(pdf?.filename).toBe("lot-b-condition-report.pdf");
    const unnumbered = { ...report, preview_data: { lots: [{ title: "First" }, { title: "Second" }] } };
    await buildLotConditionReportPdf({ report: unnumbered, lotIndex: 1 });
    expect(builder.generateAuctioneerSpecSheetPdfFromReport.mock.calls[1][0].lots[0]).toMatchObject({ title: "Second", lot_number: "2" });
  });

  it("uses the lots the delivery froze, so the PDF shows what was sent", async () => {
    const manifest = { previewData: { lots: [{ lot_id: "a", lot_number: "0645", title: "Tractor as sent" }] } };
    await buildLotConditionReportPdf({ report, manifest, lotIndex: 0 });
    expect(builder.generateAuctioneerSpecSheetPdfFromReport.mock.calls[0][0].lots[0].title).toBe("Tractor as sent");
  });

  it.each(["root", "preview"] as const)("keeps an unnumbered second lot's index-keyed notes from %s data", async (scope) => {
    const lots = [{ title: "First" }, { title: "Second" }];
    const byLot = {
      "index:0": { customText: "<p>FIRST LOT ONLY</p>" },
      "index:1": { customText: "<p>SECOND LOT ONLY</p>", rollingStockOnsite: true },
    };
    const source = {
      ...report,
      ...(scope === "root" ? { cr_disclaimers_by_lot: byLot } : {}),
      preview_data: { lots, ...(scope === "preview" ? { cr_disclaimers_by_lot: byLot } : {}) },
    };
    const before = JSON.stringify(source);

    await buildLotConditionReportPdf({ report: source, lotIndex: 1 });

    const [renderData] = builder.generateAuctioneerSpecSheetPdfFromReport.mock.calls[0];
    expect(renderData.lots).toHaveLength(1);
    expect(renderData.lots[0]).toMatchObject({ title: "Second", lot_number: "2" });
    expect(getCrDisclaimersForLot(renderData, renderData.lots[0], 0)).toEqual(normalizeCrDisclaimers(byLot["index:1"]));
    expect(JSON.stringify(source)).toBe(before);
  });

  it("keeps the frozen lot's disclaimers instead of the current report's notes", async () => {
    const source = {
      ...report,
      cr_disclaimers_by_lot: { "index:1": { customText: "<p>Current root note</p>" } },
      preview_data: { lots: [{ title: "Current first" }, { title: "Current second" }] },
    };
    const manifest = { previewData: {
      lots: [{ title: "Frozen first" }, { title: "Frozen second" }],
      cr_disclaimers_by_lot: { "index:1": { customText: "<p>Frozen second lot</p>" } },
    } };
    const before = JSON.stringify({ source, manifest });

    await buildLotConditionReportPdf({ report: source, manifest, lotIndex: 1 });

    const [renderData] = builder.generateAuctioneerSpecSheetPdfFromReport.mock.calls[0];
    expect(renderData.lots[0]).toMatchObject({ title: "Frozen second", lot_number: "2" });
    expect(getCrDisclaimersForLot(renderData, renderData.lots[0], 0).customText).toBe("<p>Frozen second lot</p>");
    expect(JSON.stringify({ source, manifest })).toBe(before);
  });

  it("preserves an explicit empty per-lot override over report-wide notes", async () => {
    const source = {
      ...report,
      cr_disclaimers: { customText: "<p>Global note</p>", smallsOnsite: true },
      preview_data: {
        lots: [{ title: "First" }, { title: "Second" }],
        cr_disclaimers_by_lot: { "index:1": {} },
      },
    };

    await buildLotConditionReportPdf({ report: source, lotIndex: 1 });

    const [renderData] = builder.generateAuctioneerSpecSheetPdfFromReport.mock.calls[0];
    expect(getCrDisclaimersForLot(renderData, renderData.lots[0], 0)).toEqual(normalizeCrDisclaimers({}));
  });

  it.each(["root", "preview"] as const)("retains report-wide defaults from %s when the lot has no override", async (scope) => {
    const defaults = { customText: "<p>Report-wide note</p>", smallsOffsite: true };
    const source = {
      ...report,
      ...(scope === "root" ? { cr_disclaimers: defaults } : {}),
      preview_data: { lots: [{ title: "First" }, { title: "Second" }], ...(scope === "preview" ? { cr_disclaimers: defaults } : {}) },
    };

    await buildLotConditionReportPdf({ report: source, lotIndex: 1 });

    const [renderData] = builder.generateAuctioneerSpecSheetPdfFromReport.mock.calls[0];
    expect(getCrDisclaimersForLot(renderData, renderData.lots[0], 0)).toEqual(normalizeCrDisclaimers(defaults));
  });

  it("keeps existing lot identity and number while selecting its own saved notes", async () => {
    const selectedLot = { lot_id: "original-id", lot_number: "# 0645", title: "Original" };
    const source = { ...report, preview_data: {
      lots: [{ title: "First" }, selectedLot],
      cr_disclaimers_by_lot: {
        "original-id": { customText: "<p>Saved original lot note</p>" },
        "0645": { customText: "<p>Wrong number-keyed note</p>" },
      },
    } };

    await buildLotConditionReportPdf({ report: source, lotIndex: 1 });

    const [renderData] = builder.generateAuctioneerSpecSheetPdfFromReport.mock.calls[0];
    expect(renderData.lots[0]).toMatchObject(selectedLot);
    expect(getCrDisclaimersForLot(renderData, renderData.lots[0], 0).customText).toBe("<p>Saved original lot note</p>");
  });

  it("has no PDF for a lot the report does not have", async () => {
    expect(await buildLotConditionReportPdf({ report, lotIndex: 5 })).toBeNull();
    expect(await buildLotConditionReportPdf({ report: null, lotIndex: 0 })).toBeNull();
    expect(builder.generateAuctioneerSpecSheetPdfFromReport).not.toHaveBeenCalled();
  });

  it("refuses anything that is not a PDF, or larger than Auctioneer accepts", async () => {
    builder.generateAuctioneerSpecSheetPdfFromReport.mockResolvedValueOnce(Buffer.from("<html>not a pdf</html>"));
    await expect(buildLotConditionReportPdf({ report, lotIndex: 0 })).rejects.toThrow(/not produced as a PDF/);
    builder.generateAuctioneerSpecSheetPdfFromReport.mockResolvedValueOnce(Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(AUCTIONEER_CR_PDF_MAX_BYTES)]));
    await expect(buildLotConditionReportPdf({ report, lotIndex: 0 })).rejects.toThrow(/25 MB/);
  });
});
