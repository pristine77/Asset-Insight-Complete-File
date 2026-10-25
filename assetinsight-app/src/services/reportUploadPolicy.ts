export type ReportUploadImage = { uri: string; name: string; type: string };

export const REAL_ESTATE_MAIN_IMAGE_LIMIT = 50;
export const REAL_ESTATE_EXTRA_IMAGE_LIMIT = 100;
export const SALVAGE_IMAGE_LIMIT = 50;
export const REPORT_UPLOAD_TIMEOUT_MS = 300_000;

export function assertReportImageLimit(images: ReportUploadImage[], limit: number, label: string) {
  if (images.length > limit) throw new Error(`${label} accepts up to ${limit} images. Remove extra images before submitting.`);
}

/** Zero means unlimited to native pickers, so callers must not open them at capacity. */
export function remainingImageSlots(count: number, limit: number) {
  return Math.max(0, limit - count);
}
