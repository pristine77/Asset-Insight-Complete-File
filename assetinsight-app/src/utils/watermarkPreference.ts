/** New reports and older drafts without a choice leave uploaded photos unmarked. */
export const DEFAULT_IMAGE_WATERMARK = false;

/** Preserve an explicit saved opt-in; never treat an absent/truthy value as consent. */
export function restoreImageWatermarkPreference(savedValue: unknown): boolean {
  return savedValue === true;
}
