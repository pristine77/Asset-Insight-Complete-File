import type { IAuctioneerSourceLot } from "../models/auctioneerWorkItem.model.js";

/** Preserve original line order while resolving explicit splits in report order. */
export function resolveScheduleAMapping(
  sources: IAuctioneerSourceLot[],
  lots: Array<{ key?: unknown; parentKey?: unknown }>,
) {
  const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";
  const byKey = new Map(sources.map(source => [source.sourceKey, source]));
  if (!sources.length || byKey.size !== sources.length || lots.filter(lot => !clean(lot.parentKey)).length !== sources.length) {
    throw new Error("The approved report no longer matches its locked Schedule A lot mapping.");
  }
  const used = new Set<string>();
  let lineIndex = 0;
  return lots.map(lot => {
    const parentKey = clean(lot.parentKey);
    const source = parentKey ? byKey.get(parentKey) : sources[lineIndex++];
    const key = clean(lot.key) || (!parentKey ? source?.sourceKey : "");
    if (!source || !key || key.length > 512 || used.has(key) ||
      (parentKey ? byKey.has(key) || !source.lotId : key !== source.sourceKey)) {
      throw new Error("The approved report contains a mismatched Schedule A lot mapping or invalid split parent.");
    }
    used.add(key);
    return { source, key, parentKey };
  });
}
