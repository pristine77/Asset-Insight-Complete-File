export type ReportArtifactKind = "asset" | "lotListing";

export function safeContractFilenamePart(value: unknown, fallback = "report"): string {
  const cleaned = String(value ?? "")
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || fallback;
}

function getLotNumberValue(lot: any, index: number): string {
  const raw =
    lot?.lot_number ??
    lot?.lotNumber ??
    lot?.lot_no ??
    lot?.lotNo ??
    lot?.lot_id ??
    lot?.lotId ??
    lot?.number ??
    index + 1;

  return String(raw || "")
    .trim()
    .replace(/^lot\s*#?\s*/i, "")
    .replace(/^#\s*/, "")
    .trim();
}

export function getReportLots(source: any): any[] {
  const candidates = [
    source?.lots,
    source?.preview_data?.lots,
    source?.details?.lots,
    source?.reportData?.lots,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function buildLotSuffix(lots: unknown): string {
  if (!Array.isArray(lots) || lots.length === 0) return "";

  const values: string[] = [];
  const seen = new Set<string>();
  lots.forEach((lot, index) => {
    const value = safeContractFilenamePart(getLotNumberValue(lot, index), "");
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    values.push(value);
  });

  if (values.length === 0) return "";

  // Keep filenames useful in Windows while still identifying large reports.
  // First, second and final lot numbers make split reports recognizable without
  // allowing a 40+ lot report to exceed filesystem path limits.
  const visible = values.length <= 2
    ? values
    : [values[0], values[1], values[values.length - 1]];
  return `lot-${visible.join("-lot-")}`;
}

export function getReportContractNumber(source: any, fallback?: unknown): string {
  return String(
    source?.contract_no ||
      source?.contract_number ||
      source?.preview_data?.contract_no ||
      source?.details?.contract_no ||
      fallback ||
      "report"
  ).trim();
}

export function buildReportArtifactFilenames(input: {
  kind: ReportArtifactKind;
  contractNo?: unknown;
  reportId?: unknown;
  fallback?: unknown;
  lots?: unknown;
}) {
  const contractPart = safeContractFilenamePart(input.contractNo, safeContractFilenamePart(input.fallback, "report"));
  const rawReportIdPart = safeContractFilenamePart(input.reportId, "");
  const reportIdPart = rawReportIdPart ? rawReportIdPart.slice(-6) : "";
  const lotSuffix = buildLotSuffix(input.lots);
  const listingPrefix = input.kind === "lotListing" ? "lot-listing" : "asset-listing";
  const readablePart = lotSuffix
    ? `${contractPart}-${listingPrefix}-${lotSuffix}`
    : `${contractPart}-${listingPrefix}`;
  const uniquePart = reportIdPart ? `${readablePart}-${reportIdPart}` : readablePart;
  const base = uniquePart;

  return {
    contractPart,
    reportIdPart,
    lotSuffix,
    uniquePart,
    base,
    excel: `${base}.xlsx`,
    crPdf: `${base}-cr.pdf`,
    scheduleAPdf: `${base}-schedule-a.pdf`,
    crDocx: `${base}-cr.docx`,
    docx: `${base}.docx`,
    imagesFolder: `${base}-images`,
    imagesZip: `${base}-images.zip`,
  };
}
