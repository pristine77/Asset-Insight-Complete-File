import { beforeEach, describe, expect, it, vi } from "vitest";

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
