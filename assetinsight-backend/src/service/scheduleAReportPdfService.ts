import { generateAuctioneerSpecSheetPdfFromReport } from "./auctioneerSpecSheetPdfService.js";
import { uploadBufferToR2 } from "../utils/r2Storage/r2Upload.js";
import {
  buildReportArtifactFilenames,
  type ReportArtifactKind,
} from "../utils/reportArtifactNames.js";

type ScheduleAFolder = "previews" | "lot-listings";

/**
 * Schedule A is a separate CR rendition that always includes the bank-photo
 * pages. Clone the report and lots so generating it cannot alter the user's
 * normal CR bank-photo setting or the canonical preview snapshot.
 */
export function buildScheduleAReportData(reportData: any): any {
  return {
    ...(reportData || {}),
    bank_photos_enabled: true,
    lots: Array.isArray(reportData?.lots)
      ? reportData.lots.map((lot: any) => ({
          ...(lot || {}),
          bank_photos_enabled: true,
        }))
      : [],
  };
}

export async function generateScheduleAPdfFromReport(reportData: any): Promise<Buffer> {
  return generateAuctioneerSpecSheetPdfFromReport(buildScheduleAReportData(reportData));
}

/** Generate and publish the bank-enabled CR before Excel is rendered. */
export async function generateAndUploadScheduleAPdf(input: {
  reportData: any;
  kind: ReportArtifactKind;
  reportId: unknown;
  folder: ScheduleAFolder;
  objectName?: string;
}): Promise<{ buffer: Buffer; filename: string; url: string }> {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) {
    throw new Error("R2_BUCKET_NAME is required to save Schedule A");
  }

  const filename =
    input.objectName ||
    buildReportArtifactFilenames({
      kind: input.kind,
      contractNo:
        input.reportData?.contract_no || input.reportData?.contract_number,
      reportId: input.reportId,
      fallback: input.reportId,
      lots: input.reportData?.lots,
    }).scheduleAPdf;
  const buffer = await generateScheduleAPdfFromReport(input.reportData);
  const uploaded = await uploadBufferToR2(
    buffer,
    "application/pdf",
    bucket,
    `${input.folder}/${filename}`
  );

  return {
    buffer,
    filename,
    url: `${uploaded}?v=${Date.now()}`,
  };
}
