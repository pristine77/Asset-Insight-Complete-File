/**
 * Each lot's condition report, as its own PDF, for Auctioneer 2.0.
 *
 * Owner, 2026-10-29: "make sure that each lot PDF reach auctioneer 2.0 as a
 * pdf". Auctioneer keeps one condition-report PDF per lot — the lot page's PDF
 * link and the contract Folder's supporting files
 * (POST /lots/:lotId/condition-report-pdf).
 *
 * The hand-off that sent it (d076450, 2026-08-21) was removed on 2026-08-31,
 * and nothing has sent one since. It also sent the WHOLE report's PDF to every
 * lot. Asset Insight's condition report is built lot by lot and then merged,
 * so each lot now gets a PDF of its own lot only, built by the same builder
 * from the data the delivery froze, so it shows what was delivered.
 */
import { buildSpecReportData } from "./auctioneerSpecPdfRefreshService.js";
import { generateAuctioneerSpecSheetPdfFromReport } from "./auctioneerSpecSheetPdfService.js";

/** Auctioneer's limit for one condition-report PDF. */
export const AUCTIONEER_CR_PDF_MAX_BYTES = 25 * 1024 * 1024;

export type AuctioneerLotConditionReportPdf = {
  bytes: Buffer;
  filename: string;
};

const isRecord = (value: unknown): value is Record<string, any> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const clean = (value: unknown) => String(value ?? "").trim();
const safeName = (value: string) => value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "x";

/** True when the bytes are a PDF: they start with the "%PDF-" signature. */
export function isPdf(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 5 && Buffer.from(bytes.subarray(0, 5)).toString("latin1") === "%PDF-";
}

/**
 * The condition-report PDF of the report's lot at `lotIndex`: the same pages
 * the report's own PDF has for that lot, and nothing else. `manifest` is the
 * delivery's frozen copy, so the PDF matches the lot that was sent. Null when
 * the report has no lot at that position.
 */
export async function buildLotConditionReportPdf(input: {
  report: unknown;
  manifest?: unknown;
  lotIndex: number;
  contractNo?: string;
}): Promise<AuctioneerLotConditionReportPdf | null> {
  const source = isRecord(input.report) && typeof input.report.toObject === "function"
    ? input.report.toObject()
    : input.report;
  if (!isRecord(source)) return null;
  const frozen = isRecord(input.manifest) && isRecord(input.manifest.previewData) ? input.manifest.previewData : null;
  const reportData = buildSpecReportData(frozen ? { ...source, preview_data: frozen } : source);
  const lot = Array.isArray(reportData?.lots) ? reportData.lots[input.lotIndex] : undefined;
  if (!isRecord(lot)) return null;

  // The lot keeps its own number on a one-lot PDF; the builder would otherwise
  // number it by its position, which is 1.
  const lotNumber = clean(lot.lot_number || lot.lot_id || lot.lot || lot.id) || String(input.lotIndex + 1);
  const bytes = await generateAuctioneerSpecSheetPdfFromReport({ ...reportData, lots: [{ ...lot, lot_number: lotNumber }] });
  if (!isPdf(bytes)) throw new Error(`The condition report for lot ${lotNumber} was not produced as a PDF.`);
  if (bytes.byteLength > AUCTIONEER_CR_PDF_MAX_BYTES) {
    throw new Error(`The condition report PDF for lot ${lotNumber} is larger than Auctioneer's 25 MB limit.`);
  }
  const contract = clean(input.contractNo);
  return {
    bytes,
    filename: `${contract ? `contract-${safeName(contract)}-` : ""}lot-${safeName(lotNumber)}-condition-report.pdf`,
  };
}
