/**
 * Rehydrates editable report lots with their canonical Auctioneer2 source snapshot.
 * Stable source keys win over positional matching; index fallback handles missing or
 * unmatched keys, primarily for legacy reports. The mapper owns source-versus-edit
 * precedence so this lookup remains transport-agnostic.
 */
import { Types } from "mongoose";
import AuctioneerWorkItem from "../models/auctioneerWorkItem.model.js";
import { mergeAuctioneerSourceLot } from "./auctioneer2PayloadMapper.js";

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export async function mergeCanonicalAuctioneerSourceLots(input: {
  reportId: unknown;
  reportType: "asset" | "lotListing";
  lots: any[];
}): Promise<any[]> {
  const reportId = clean(input.reportId);
  if (!Types.ObjectId.isValid(reportId) || !Array.isArray(input.lots)) {
    return input.lots;
  }
  const linkedReportModel =
    input.reportType === "asset" ? "AssetReport" : "LotListing";
  const item = await AuctioneerWorkItem.findOne({
    linkedReportId: new Types.ObjectId(reportId),
    linkedReportModel,
  })
    .select("_id kind snapshot.lots")
    .lean();
  if (!item) return input.lots;

  const sourceLots = Array.isArray(item.snapshot?.lots)
    ? item.snapshot.lots
    : [];
  const byKey = new Map(
    sourceLots.map((source: any) => [clean(source?.sourceKey), source])
  );

  return input.lots.map((lot, index) => {
    const requestedKey = clean(lot?.auctioneer_source_key);
    // A split shares commission lineage, not the parent's VIN, value or title.
    // Keep its independently assessed fields and stable key untouched.
    if (clean(lot?.auctioneer_source_parent_key)) return { ...lot };
    const source =
      (requestedKey ? byKey.get(requestedKey) : undefined) ||
      sourceLots[index];
    const sourceKey =
      clean(source?.sourceKey) ||
      requestedKey ||
      `${String(item._id)}:unknown:${index + 1}`;
    const canonicalSource = source
      ? {
          ...(source.raw && typeof source.raw === "object" ? source.raw : {}),
          ...source,
        }
      : {};
    return mergeAuctioneerSourceLot(lot, canonicalSource, sourceKey);
  });
}
