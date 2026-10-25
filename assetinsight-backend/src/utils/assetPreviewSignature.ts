const SIGNATURE_DATA_URL_PATTERN =
  /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=\s]+)$/i;
const MAX_SIGNATURE_BYTES = 300 * 1024;

export function sanitizeAssetPreviewSignature<T extends Record<string, any>>(
  previewData: T
): { data: T; message?: string } {
  if (!previewData || typeof previewData !== "object") {
    return { data: previewData };
  }

  const next = { ...previewData } as Record<string, any>;
  const rawSignature = next.appraiser_signature_data_url;

  if (rawSignature == null || rawSignature === "") {
    delete next.appraiser_signature_data_url;
    delete next.appraiser_signature_updated_at;
    return { data: next as T };
  }

  if (typeof rawSignature !== "string") {
    return { data: next as T, message: "Invalid appraiser signature." };
  }

  const match = rawSignature.trim().match(SIGNATURE_DATA_URL_PATTERN);
  if (!match) {
    return {
      data: next as T,
      message: "Appraiser signature must be a PNG or JPEG image.",
    };
  }

  const mime = match[1].toLowerCase();
  const base64 = match[2].replace(/\s+/g, "");
  const signatureBuffer = Buffer.from(base64, "base64");
  if (signatureBuffer.length === 0) {
    return { data: next as T, message: "Appraiser signature is empty." };
  }
  if (signatureBuffer.length > MAX_SIGNATURE_BYTES) {
    return {
      data: next as T,
      message: "Appraiser signature is too large. Please clear it and sign again.",
    };
  }

  next.appraiser_signature_data_url = `data:image/${mime};base64,${base64}`;

  const updatedAt = String(next.appraiser_signature_updated_at || "").trim();
  next.appraiser_signature_updated_at =
    updatedAt && !Number.isNaN(new Date(updatedAt).getTime())
      ? new Date(updatedAt).toISOString()
      : new Date().toISOString();

  return { data: next as T };
}
