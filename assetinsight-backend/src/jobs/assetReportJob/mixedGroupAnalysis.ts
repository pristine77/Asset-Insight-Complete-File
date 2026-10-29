export type MixedAssetSubMode = "single_lot" | "per_item" | "per_photo";

export type MixedAssetFallbackContext = {
  groupIndex: number;
  subMode: MixedAssetSubMode;
  sourceKey?: string;
  /**
   * The Schedule A line this lot was split out of, when it was.
   *
   * Carried UNSUFFIXED, unlike sourceKey. sourceKeyForFallback() appends
   * ":photo:n" or ":n" when one group yields several lots, because those are
   * distinct lots and Auctioneer de-duplicates on the reference. The parent is
   * a Schedule A LINE and does not subdivide — a suffixed value would match no
   * line and the submission would be refused.
   */
  sourceParentKey?: string;
  /**
   * The Auctioneer lot of the Schedule A item this group was linked to (owner
   * 2026-10-28). Like the parent key it names the item, not a lot, so every
   * placeholder lot carries it unchanged.
   */
  scheduleAParentLotId?: string;
  currency: string;
  imageUrls: string[];
  mainImageIndexes: number[];
  extraImageIndexes: number[];
  coverIndex?: number;
};

const EMPTY_ANALYSIS_REASON =
  "Software did not return details for this lot. Review and edit before approval.";
const FAILED_ANALYSIS_REASON =
  "Software analysis failed for this lot. Review and edit before approval.";

function sourceKeyForFallback(
  context: MixedAssetFallbackContext,
  globalImageIndex: number,
  localImageIndex: number,
): string | undefined {
  if (!context.sourceKey) return undefined;
  if (context.subMode === "per_photo") {
    return `${context.sourceKey}:photo:${globalImageIndex + 1}`;
  }
  return context.mainImageIndexes.length > 1
    ? `${context.sourceKey}:${localImageIndex + 1}`
    : context.sourceKey;
}

/**
 * Converts a submitted mixed-group manifest into editable placeholder lots.
 * Every main image stays represented even when the analysis provider cannot
 * return a result, while extra images remain attached to the same group.
 */
export function buildMixedAssetFallbackLots(
  context: MixedAssetFallbackContext,
  reason: string,
): any[] {
  const mainImageIndexes = context.mainImageIndexes.filter(
    (index) =>
      Number.isInteger(index) &&
      index >= 0 &&
      index < context.imageUrls.length,
  );
  if (mainImageIndexes.length === 0) return [];

  const extraImageIndexes = context.extraImageIndexes.filter(
    (index) =>
      Number.isInteger(index) &&
      index >= 0 &&
      index < context.imageUrls.length,
  );
  const extraImageUrls = extraImageIndexes
    .map((index) => context.imageUrls[index])
    .filter(Boolean);
  const coverPosition = Math.max(
    0,
    Math.min(
      mainImageIndexes.length - 1,
      Number.isInteger(context.coverIndex) ? Number(context.coverIndex) : 0,
    ),
  );
  const coverGlobalIndex = mainImageIndexes[coverPosition];
  const coverUrl = context.imageUrls[coverGlobalIndex];
  const common = {
    description: reason,
    details: "",
    condition: "Needs manual review",
    estimated_value: `${context.currency} 0`,
    damage_analysis: undefined,
    extra_image_indexes: extraImageIndexes,
    extra_image_urls: extraImageUrls,
    tags: [`mode:${context.subMode}`, "needs_review"],
    mixed_group_index: context.groupIndex + 1,
    sub_mode: context.subMode,
  };

  if (context.subMode === "single_lot") {
    const imageUrls = mainImageIndexes
      .map((index) => context.imageUrls[index])
      .filter(Boolean);
    return [
      {
        ...common,
        title: `Lot ${context.groupIndex + 1}`,
        image_url: coverUrl || imageUrls[0],
        image_indexes: mainImageIndexes,
        image_urls: imageUrls,
        ...(context.sourceKey
          ? { auctioneer_source_key: context.sourceKey }
          : {}),
        ...(context.sourceParentKey
          ? { auctioneer_source_parent_key: context.sourceParentKey }
          : {}),
        ...(context.scheduleAParentLotId
          ? { schedule_a_parent_lot_id: context.scheduleAParentLotId }
          : {}),
      },
    ];
  }

  return mainImageIndexes.map((globalImageIndex, localImageIndex) => {
    const imageUrl = context.imageUrls[globalImageIndex];
    const auctioneerSourceKey = sourceKeyForFallback(
      context,
      globalImageIndex,
      localImageIndex,
    );
    return {
      ...common,
      title: `Lot ${context.groupIndex + 1}${
        mainImageIndexes.length > 1 ? ` Image ${localImageIndex + 1}` : ""
      }`,
      image_url: imageUrl,
      image_indexes: [globalImageIndex],
      image_urls: imageUrl ? [imageUrl] : [],
      ...(auctioneerSourceKey
        ? { auctioneer_source_key: auctioneerSourceKey }
        : {}),
      ...(context.sourceParentKey
        ? { auctioneer_source_parent_key: context.sourceParentKey }
        : {}),
      ...(context.scheduleAParentLotId
        ? { schedule_a_parent_lot_id: context.scheduleAParentLotId }
        : {}),
    };
  });
}

export type MixedAssetGroupAnalysis = {
  result: any | null;
  fallbackLots: any[];
  outcome: "analyzed" | "empty" | "failed";
  error?: unknown;
};

/** Runs one provider call and deterministically preserves its manifest on failure. */
export async function analyzeMixedAssetGroupWithFallback(input: {
  analyze: () => Promise<any>;
  fallbackContext: MixedAssetFallbackContext;
}): Promise<MixedAssetGroupAnalysis> {
  try {
    const result = await input.analyze();
    if (Array.isArray(result?.lots) && result.lots.length > 0) {
      return { result, fallbackLots: [], outcome: "analyzed" };
    }
    return {
      result,
      fallbackLots: buildMixedAssetFallbackLots(
        input.fallbackContext,
        EMPTY_ANALYSIS_REASON,
      ),
      outcome: "empty",
    };
  } catch (error) {
    return {
      result: null,
      fallbackLots: buildMixedAssetFallbackLots(
        input.fallbackContext,
        FAILED_ANALYSIS_REASON,
      ),
      outcome: "failed",
      error,
    };
  }
}
