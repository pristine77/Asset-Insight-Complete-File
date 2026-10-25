/** Display-only projection. Never use this object as a save payload. */
export function lotPreviewDisplay(lot: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(lot).flatMap(([key, value]) => {
    // Hide the redundant narrative controls, not structured condition details.
    if (key === "description" || ((key === "details" || key === "specs") && (value == null || typeof value !== "object"))) return [];
    if (key === "items" && Array.isArray(value)) {
      return [[key, value.map(item => item && typeof item === "object" && !Array.isArray(item)
        ? lotPreviewDisplay(item as Record<string, unknown>) : item)]];
    }
    return [[key, value]];
  }));
}

export function reportPreviewDisplay(data: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(data.lots)) return data;
  return { ...data, lots: data.lots.map(lot => lot && typeof lot === "object" && !Array.isArray(lot)
    ? lotPreviewDisplay(lot as Record<string, unknown>) : lot) };
}

export function usesLotTitleDescription(meta: Array<{ label: string; value: unknown }>): boolean {
  return meta.some(field => field.label === "Report Type" && ["Asset", "Lot Listing", "LotListing"].includes(String(field.value)));
}
