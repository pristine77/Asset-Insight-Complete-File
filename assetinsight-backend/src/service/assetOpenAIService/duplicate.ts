/**
 * Performs conservative deterministic lot deduplication after structural normalization.
 * It is isolated from image analysis so callers can preserve original results when the
 * optional consolidation pass fails or is disabled.
 */
export async function deduplicateAssetLotsAI(
  imageUrls: string[],
  lots: any[]
): Promise<any[]> {
  if (!Array.isArray(lots) || lots.length === 0) return [];
  if (process.env.DEBUG_PER_ITEM === "1") {
    console.log("[PerItemDebug][dedup:before]", { inputCount: lots.length });
  }

  const norm = (s?: string | null) =>
    (s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const out: any[] = [];
  const chosenBySerial = new Map<string, number>();
  const chosenPerImageKey = new Map<string, number>();

  for (const lot of lots) {
    const serialKey = norm(lot?.serial_no_or_label || lot?.serial_number || undefined);
    const titleKey = norm(lot?.title);
    const detailsKey = norm(lot?.details || undefined);
    const imageUrl: string | undefined =
      typeof lot?.image_url === "string" && lot.image_url ? lot.image_url : undefined;

    // Strong dedup: identical serial implies same physical item, regardless of image
    if (serialKey) {
      if (chosenBySerial.has(serialKey)) {
        continue; // drop duplicate by serial
      }
      chosenBySerial.set(serialKey, out.length);
      out.push(lot);
      continue;
    }

    // Conservative dedup across the SAME image only (avoid collapsing similar items across different images)
    if (imageUrl) {
      const perImageKey = `${imageUrl}|${titleKey}|${detailsKey}`;
      if (chosenPerImageKey.has(perImageKey)) {
        continue; // drop duplicate within the same image frame
      }
      chosenPerImageKey.set(perImageKey, out.length);
      out.push(lot);
    } else {
      // No serial and no image_url: keep as-is (cannot safely dedup)
      out.push(lot);
    }
  }

  if (process.env.DEBUG_PER_ITEM === "1") {
    console.log("[PerItemDebug][dedup:after]", { outputCount: out.length });
  }
  return out;
}
