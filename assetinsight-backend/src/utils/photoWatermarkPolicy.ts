/** New photos are unwatermarked unless the caller explicitly opts in. */
export const DEFAULT_WATERMARK_IMAGES = false;

/** Preserve an existing report's choice when a partial preview edit omits it. */
export function resolvePhotoWatermark(value: unknown, savedValue?: unknown): boolean {
  const parse = (input: unknown): boolean | undefined => {
    if (input === true || input === 1) return true;
    if (input === false || input === 0) return false;
    if (typeof input === "string") {
      const normalized = input.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(normalized)) return true;
      if (["false", "0", "no", "off"].includes(normalized)) return false;
    }
    return undefined;
  };
  return parse(value) ?? parse(savedValue) ?? DEFAULT_WATERMARK_IMAGES;
}
