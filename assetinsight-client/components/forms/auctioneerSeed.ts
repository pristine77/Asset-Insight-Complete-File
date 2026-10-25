import type { AuctioneerWorkItemSetup } from "@/services/auctioneer";
import type { MixedLot } from "./mixed/types";

export type AuctioneerFormIntegration = AuctioneerWorkItemSetup;

export function auctioneerDateOnly(value?: string) {
  if (!value) return "";
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return value.slice(0, 10);
}

function sourceDescription(
  lot: AuctioneerWorkItemSetup["lots"][number]
) {
  const identity = [lot.year, lot.make, lot.model].filter(Boolean).join(" ");
  return [
    lot.description,
    identity,
    lot.serialNumber ? `Serial/VIN ${lot.serialNumber}` : "",
    lot.categories,
    lot.services?.length ? `Services: ${lot.services.join(", ")}` : "",
    lot.details,
    lot.conditionReport,
  ]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(" · ");
}

export function buildAuctioneerSeedLots(
  integration?: AuctioneerWorkItemSetup
): MixedLot[] {
  if (!integration) return [];
  const locked = integration.kind === "scheduleA";
  const sourceLots = locked
    ? integration.lots
    : integration.lots.length
      ? [integration.lots[0]]
      : [];

  if (!sourceLots.length) {
    return [
      {
        id: `auctioneer-${integration.workItemId}-1`,
        files: [],
        extraFiles: [],
        videoFiles: [],
        coverIndex: 0,
        mode: "single_lot",
        source: {
          key: `${integration.workItemId}:unknown:1`,
          label: "New unknown lot",
          locked: false,
        },
      },
    ];
  }

  return sourceLots.map((lot, index) => ({
    id: `auctioneer-${integration.workItemId}-${index + 1}`,
    files: [],
    extraFiles: [],
    videoFiles: [],
    coverIndex: 0,
    mode: "single_lot",
    source: {
      key: lot.sourceKey,
      lotId: lot.lotId,
      submissionId: lot.submissionId,
      lotNumber: lot.lotNumber,
      label: lot.lotNumber ? `Lot ${lot.lotNumber}` : `Lot ${index + 1}`,
      title: lot.title,
      description: sourceDescription(lot) || undefined,
      locked,
    },
  }));
}

export function auctioneerDraftScope(
  integration?: AuctioneerWorkItemSetup
) {
  return integration ? `auctioneer:${integration.workItemId}` : undefined;
}

export function auctioneerIndustry(
  integration?: AuctioneerWorkItemSetup
) {
  if (!integration) return "";
  const values = [
    integration.contract.categories,
    ...integration.lots.map((lot) => lot.categories),
  ].filter(Boolean) as string[];
  return [...new Set(values)].join(", ");
}
