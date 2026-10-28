import { rowValuationAmounts } from "./calculations";
import type { ProposalValuationEvaluator, ProposalValuationRow } from "./types";

export function assetLabel(row: ProposalValuationRow) {
  return row.asset_id || row.lot_id || "asset";
}

export function validPictureUrls(row: ProposalValuationRow) {
  return (row.picture_urls || [])
    .map((url) => String(url || "").trim())
    .filter(Boolean);
}

export function pictureCount(row: ProposalValuationRow, urls = validPictureUrls(row)) {
  return urls.length || Math.max(0, Math.trunc(Number(row.pictures) || 0));
}

export function rowDisplayValues(
  row: ProposalValuationRow,
  evaluators: ProposalValuationEvaluator[]
) {
  const { average, low, high, premium, gross } = rowValuationAmounts(row, evaluators);

  return {
    average: average ?? 0,
    low,
    high,
    buyerPremiumPercent: row.buyer_premium_percent || 15,
    buyerPremiumAmount: premium,
    totalExpectedGross: gross,
    allocatedValue: gross,
    cleaning: high === null ? null : high * 0.01,
    lottingFee: high === null ? null : high * 0.01,
    advertising: high === null ? null : high * 0.01,
  };
}
