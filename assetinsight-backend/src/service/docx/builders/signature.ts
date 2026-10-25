import { AlignmentType, ImageRun, Paragraph } from "docx";

/**
 * Safely converts the report's embedded signature into optional DOCX elements.
 * Invalid, unsupported, or oversized input returns null so a corrupt decoration
 * cannot block generation of the legally reviewable report text.
 */
const SIGNATURE_DATA_URL_PATTERN =
  /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=\s]+)$/i;
const MAX_SIGNATURE_BYTES = 300 * 1024;

function getSignatureDataUrl(reportData: any): string {
  return String(
    reportData?.appraiser_signature_data_url ||
      reportData?.preview_data?.appraiser_signature_data_url ||
      ""
  ).trim();
}

function getSignatureBuffer(reportData: any): Buffer | null {
  const dataUrl = getSignatureDataUrl(reportData);
  if (!dataUrl) return null;

  const match = dataUrl.match(SIGNATURE_DATA_URL_PATTERN);
  if (!match) return null;

  const base64 = match[2].replace(/\s+/g, "");
  const buffer = Buffer.from(base64, "base64");
  // The byte budget limits document bloat and memory amplification from
  // user-controlled data URLs while retaining normal handwritten signatures.
  if (buffer.length === 0 || buffer.length > MAX_SIGNATURE_BYTES) return null;
  return buffer;
}

export function buildSignatureImageRun(
  reportData: any,
  options: { width?: number; height?: number } = {}
): ImageRun | null {
  const buffer = getSignatureBuffer(reportData);
  if (!buffer) return null;

  return new ImageRun({
    data: buffer as any,
    transformation: {
      width: options.width || 190,
      height: options.height || 62,
    },
  } as any);
}

export function buildSignatureImageParagraph(
  reportData: any,
  options: {
    width?: number;
    height?: number;
    before?: number;
    after?: number;
    alignment?: (typeof AlignmentType)[keyof typeof AlignmentType];
  } = {}
): Paragraph | null {
  const imageRun = buildSignatureImageRun(reportData, {
    width: options.width,
    height: options.height,
  });
  if (!imageRun) return null;

  return new Paragraph({
    alignment: options.alignment || AlignmentType.LEFT,
    spacing: {
      before: options.before || 0,
      after: options.after || 40,
    },
    children: [imageRun],
  });
}
