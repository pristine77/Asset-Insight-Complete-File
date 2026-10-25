/**
 * Selects the most useful images for the compact CR summary grid. The first
 * image remains the hero, while the final image (normally the serial/ID photo)
 * is promoted ahead of the remaining early photos.
 */
export function selectCrSummaryImages<T>(
  images: readonly T[],
  maximumImages = 5,
): T[] {
  const limit = Math.max(0, Math.floor(maximumImages));
  if (limit === 0 || images.length === 0) return [];
  if (images.length === 1) return [images[0]].slice(0, limit);

  return [images[0], images[images.length - 1], ...images.slice(1, -1)].slice(
    0,
    limit,
  );
}
