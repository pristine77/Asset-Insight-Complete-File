import type {
  AuctioneerProposalItem,
  AuctioneerScheduleAChoice,
  AuctioneerWorkItemSetup,
} from "@/services/auctioneer";
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

/**
 * The lot that captures one listed Proposal item (owner 2026-10-28). It
 * carries the item's source key, which is how the server knows which item the
 * lot returns, and shows Lot #, title and serial so the appraiser knows which
 * item is in front of them. One item is one lot, so the mode is fixed. The
 * lot can be removed: the item then simply stays to be captured.
 */
export function proposalItemLot(
  integration: AuctioneerWorkItemSetup,
  item: AuctioneerProposalItem
): MixedLot {
  const identity = [item.year, item.make, item.model].filter(Boolean).join(" ");
  const description = [
    item.description,
    identity,
    item.serialNumber ? `Serial/VIN ${item.serialNumber}` : "",
  ]
    .filter(Boolean)
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(" · ");
  return {
    id: `auctioneer-${integration.workItemId}-${item.lineId}`,
    files: [],
    extraFiles: [],
    videoFiles: [],
    coverIndex: 0,
    mode: "single_lot",
    source: {
      key: item.sourceKey,
      ...(item.lotNumber ? { lotNumber: item.lotNumber } : {}),
      label: item.lotNumber ? `Lot ${item.lotNumber}` : "Listed item",
      title: item.title,
      ...(description ? { description } : {}),
      locked: false,
      listed: true,
    },
  };
}

/** The listed items the form can still capture, in list order. */
export function outstandingProposalItems(
  integration?: AuctioneerWorkItemSetup
): AuctioneerProposalItem[] {
  return (integration?.proposalList?.items ?? []).filter(
    (item) => item.state === "outstanding"
  );
}

export function buildAuctioneerSeedLots(
  integration?: AuctioneerWorkItemSetup
): MixedLot[] {
  if (!integration) return [];
  /*
     Owner 2026-10-28: a Proposal worked from its list starts with one lot
     per item still to capture. Items already returned, returned as not
     found, or waiting in another of the user's reports are not offered
     again. With nothing left to capture the form starts like an Unknown Lots
     form, whose lots go back as items that were not on the list.
  */
  if (integration.proposalList) {
    const listed = outstandingProposalItems(integration).map((item) =>
      proposalItemLot(integration, item)
    );
    if (listed.length) return listed;
  }
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
      // Splitting exists only on Schedule A lines (owner 2026-10-28).
      ...(locked && lot.severalLots === true ? { severalLots: true } : {}),
    },
  }));
}

/**
 * Re-reads each Schedule A line's "Several lots" tick from the current setup.
 *
 * A draft keeps the tick as it was when it was saved; the setup a resumed form
 * opens with is fetched fresh, and the office may have ticked or unticked the
 * item since. Splits are matched through parentKey, so they follow their
 * original line. Returns the same array when nothing changed.
 */
export function withCurrentSeveralLots(
  lots: MixedLot[],
  integration?: AuctioneerWorkItemSetup
): MixedLot[] {
  if (integration?.kind !== "scheduleA") return lots;
  const severalLotsLines = new Set(
    integration.lots
      .filter((lot) => lot.severalLots === true)
      .map((lot) => lot.sourceKey)
  );
  let changed = false;
  const next = lots.map((lot) => {
    if (!lot.source) return lot;
    const severalLots = severalLotsLines.has(
      lot.source.parentKey || lot.source.key
    );
    if ((lot.source.severalLots === true) === severalLots) return lot;
    changed = true;
    const { severalLots: _previous, ...source } = lot.source;
    return {
      ...lot,
      source: severalLots ? { ...source, severalLots: true } : source,
    };
  });
  return changed ? next : lots;
}

/*
   Owner 2026-10-28: on a work item that requires it, every lot in the form is
   sent against ONE Schedule A item the appraiser chooses (one form batch = one
   item). The wording below is the owner-approved text; both forms use it.
*/
export const SCHEDULE_A_NO_CHOICES_MESSAGE =
  "No Schedule A item on this contract is marked Several lots in Auctioneer 2.0. Ask the office to tick it on the contract, then try again.";
export const SCHEDULE_A_CHOICE_REQUIRED_MESSAGE =
  "Choose which Schedule A item these lots belong to.";
/** The refusal code Asset Insight's server returns for a lot with no item. */
export const SCHEDULE_A_ITEM_REQUIRED_CODE = "AUCTIONEER_SCHEDULE_A_ITEM_REQUIRED";

/** The items offered, or none when this work item does not ask for one. */
export function scheduleAChoicesFor(
  integration?: AuctioneerWorkItemSetup
): AuctioneerScheduleAChoice[] {
  return integration?.requiresScheduleAItem === true
    ? integration.scheduleAChoices ?? []
    : [];
}

/**
 * The chosen item's parentLotId, but only while the current setup still
 * offers it. A choice restored from a draft that the refreshed setup no longer
 * lists reads as no choice, so the appraiser has to choose again.
 */
export function currentScheduleAParentLotId(
  integration: AuctioneerWorkItemSetup | undefined,
  chosen: string
): string {
  return scheduleAChoicesFor(integration).some(
    (choice) => choice.parentLotId === chosen
  )
    ? chosen
    : "";
}

/** Why the form cannot be sent yet, or undefined when it can. */
export function scheduleAItemError(
  integration: AuctioneerWorkItemSetup | undefined,
  parentLotId: string
): string | undefined {
  if (integration?.requiresScheduleAItem !== true) return undefined;
  if (!scheduleAChoicesFor(integration).length) return SCHEDULE_A_NO_CHOICES_MESSAGE;
  return currentScheduleAParentLotId(integration, parentLotId)
    ? undefined
    : SCHEDULE_A_CHOICE_REQUIRED_MESSAGE;
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
