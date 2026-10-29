/**
 * Rehydrates editable report lots with their canonical Auctioneer2 source snapshot.
 * Stable source keys win over positional matching; index fallback handles missing or
 * unmatched keys, primarily for legacy reports. The mapper owns source-versus-edit
 * precedence so this lookup remains transport-agnostic.
 */
import { Types } from "mongoose";
import AuctioneerWorkItem from "../models/auctioneerWorkItem.model.js";
import { mergeAuctioneerSourceLot } from "./auctioneer2PayloadMapper.js";
import { isProposalListWorkItem, proposalItemSourceKey } from "./auctioneerProposalList.js";

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
    .select("_id kind snapshot.lots proposalList")
    .lean();
  if (!item) return input.lots;

  const sourceLots = Array.isArray(item.snapshot?.lots)
    ? item.snapshot.lots
    : [];
  const byKey = new Map(
    sourceLots.map((source: any) => [clean(source?.sourceKey), source])
  );
  /*
     A Proposal worked from its list (owner 2026-10-28) keeps its items on the
     work item, not in the snapshot. A lot naming one is filled from it the way
     a Schedule A line fills its lot — title, serial, year, make, model where
     the analysis left them blank. Every other lot is an item that was not on
     the list and is never matched by position to a listed one.
  */
  if (isProposalListWorkItem(item)) {
    const listed = new Map(
      (item.proposalList?.items || []).map((entry) => [proposalItemSourceKey(entry.lineId), entry])
    );
    return input.lots.map((lot, index) => {
      const requestedKey = clean(lot?.auctioneer_source_key);
      const entry = listed.get(requestedKey);
      if (!entry) {
        return mergeAuctioneerSourceLot(lot, {}, requestedKey || `${String(item._id)}:unknown:${index + 1}`);
      }
      return mergeAuctioneerSourceLot(lot, {
        title: entry.title,
        description: entry.description,
        year: entry.year,
        make: entry.make,
        model: entry.model,
        serialNumber: entry.serialNumber,
      }, requestedKey);
    });
  }

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
