/**
 * Links a lot captured on a Schedule A contract's extra ("unknown") work item
 * to the Schedule A item it belongs to.
 *
 * Owner 2026-10-28: a lot on a contract with a Schedule A must not be sent to
 * Auctioneer 2.0 until the appraiser has chosen which Schedule A item it
 * belongs to — no orphan lots. Auctioneer offers the items ticked "Several
 * lots" ("this item comes back as more than one lot"); each one names the
 * Auctioneer lot that extra lots are created under (scheduleAParentRef), and
 * that lot id is what a report lot stores in schedule_a_parent_lot_id.
 *
 * Pure helpers only: report submission, preview edits, Send and delivery all
 * apply the same rule, so they share one definition of "valid link".
 */
import type {
  IAuctioneerScheduleAChoice,
  IAuctioneerWorkItem,
} from "../models/auctioneerWorkItem.model.js";

export const SCHEDULE_A_ITEM_REQUIRED_CODE = "AUCTIONEER_SCHEDULE_A_ITEM_REQUIRED";
export const SCHEDULE_A_ITEM_REQUIRED_MESSAGE =
  "Choose which Schedule A item this lot belongs to.";

/** The per-lot field, on submitted mixed_lots and on saved report lots alike. */
export const SCHEDULE_A_PARENT_LOT_FIELD = "schedule_a_parent_lot_id";

type ScheduleAWorkItem = Pick<IAuctioneerWorkItem, "kind"> & {
  contract?: { hasScheduleA?: boolean } | null;
  scheduleAChoices?: IAuctioneerScheduleAChoice[] | null;
  proposalList?: unknown;
};

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

/**
 * True for the work items whose lots need a chosen Schedule A item: the
 * contract has a Schedule A and the work item carries no lines of its own
 * ("Create Lot & Continue" successors and Re-Open cycles). A Schedule A work
 * item keeps its locked one-lot-per-line mapping and is never affected.
 *
 * A Proposal worked from its list (owner 2026-10-28) is never affected either:
 * its Schedule A is the list itself, not yet approved, and its lots return
 * against listed items rather than being created under a parent lot.
 */
export function requiresScheduleAItem(workItem: ScheduleAWorkItem | null | undefined): boolean {
  return Boolean(
    workItem && workItem.kind === "unknown" && workItem.contract?.hasScheduleA === true && !workItem.proposalList
  );
}

/** The Auctioneer parent lots a lot of this work item may name. */
export function scheduleAChoiceParentLotIds(workItem: ScheduleAWorkItem | null | undefined): Set<string> {
  return new Set(
    (Array.isArray(workItem?.scheduleAChoices) ? workItem!.scheduleAChoices : [])
      .map((choice) => clean(choice?.parentLotId))
      .filter(Boolean)
  );
}

export function scheduleAParentLotId(lot: unknown): string {
  return lot && typeof lot === "object"
    ? clean((lot as Record<string, unknown>)[SCHEDULE_A_PARENT_LOT_FIELD])
    : "";
}

/**
 * Only items ticked "Several lots" AND already holding an Auctioneer lot can
 * take extra lots: without that lot there is nothing to name as the parent,
 * and Auctioneer refuses extras on an item that is not ticked.
 */
export function scheduleAChoicesFromItems(
  items: Array<{ lineId: string; title: string; severalLots: boolean; parentLotId: string | null }>
): IAuctioneerScheduleAChoice[] {
  const seen = new Set<string>();
  const choices: IAuctioneerScheduleAChoice[] = [];
  for (const item of items) {
    const lineId = clean(item.lineId);
    const parentLotId = clean(item.parentLotId);
    if (item.severalLots !== true || !lineId || !parentLotId || seen.has(parentLotId)) continue;
    seen.add(parentLotId);
    choices.push({ lineId, title: clean(item.title) || "Schedule A item", parentLotId });
  }
  return choices;
}

export function sameScheduleAChoices(
  first: IAuctioneerScheduleAChoice[] | null | undefined,
  second: IAuctioneerScheduleAChoice[] | null | undefined
): boolean {
  const key = (choices: IAuctioneerScheduleAChoice[] | null | undefined) =>
    JSON.stringify((choices || []).map((choice) => [choice.lineId, choice.title, choice.parentLotId]));
  return key(first) === key(second);
}

/**
 * Keeps a lot's link through a preview edit whose client did not send it back.
 *
 * Preview editors replace preview_data.lots with what the client sends, and a
 * client that predates the field would silently drop every link on save. The
 * missing value is taken from the same saved lot (by source key, then by a
 * unique lot_id). A lot with no saved counterpart — one added while editing —
 * takes the report's item when every saved lot agrees on exactly one: the
 * appraiser chose one item for the whole batch (owner 2026-10-28: one form
 * batch = one item), so that is their choice, not a guess. A value the client
 * did send is never replaced; it is validated by the caller.
 */
export function inheritScheduleAItemLinks<T extends Record<string, any>>(
  nextLots: T[],
  previousLots: unknown
): T[] {
  const previous = (Array.isArray(previousLots) ? previousLots : []).filter(
    (lot): lot is Record<string, any> => Boolean(lot) && typeof lot === "object"
  );
  if (!previous.length) return nextLots;
  const bySourceKey = new Map<string, string>();
  const byLotId = new Map<string, string>();
  const seenLotIds = new Set<string>();
  const duplicateLotIds = new Set<string>();
  const distinct = new Set<string>();
  for (const lot of previous) {
    const link = scheduleAParentLotId(lot);
    const lotId = clean(lot.lot_id);
    if (lotId) {
      // Generated lot ids can repeat; a repeated id identifies nothing.
      if (seenLotIds.has(lotId)) duplicateLotIds.add(lotId);
      else if (link) byLotId.set(lotId, link);
      seenLotIds.add(lotId);
    }
    if (!link) continue;
    distinct.add(link);
    const sourceKey = clean(lot.auctioneer_source_key);
    if (sourceKey && !bySourceKey.has(sourceKey)) bySourceKey.set(sourceKey, link);
  }
  if (!distinct.size) return nextLots;
  const batchLink = distinct.size === 1 ? [...distinct][0] : "";
  return nextLots.map((lot) => {
    if (!lot || typeof lot !== "object" || scheduleAParentLotId(lot)) return lot;
    const inherited =
      bySourceKey.get(clean(lot.auctioneer_source_key)) ||
      (duplicateLotIds.has(clean(lot.lot_id)) ? undefined : byLotId.get(clean(lot.lot_id))) ||
      batchLink;
    return inherited ? { ...lot, [SCHEDULE_A_PARENT_LOT_FIELD]: inherited } : lot;
  });
}

/**
 * Positions of lots that do not name one of the work item's choosable items.
 * `alreadyCreated` lets Send skip lots a failed delivery already created in
 * Auctioneer — those exist and are never submitted again.
 */
export function lotsMissingScheduleAItem(
  workItem: ScheduleAWorkItem,
  lots: unknown[],
  alreadyCreated: (index: number) => boolean = () => false
): number[] {
  if (!requiresScheduleAItem(workItem)) return [];
  const allowed = scheduleAChoiceParentLotIds(workItem);
  const missing: number[] = [];
  lots.forEach((lot, index) => {
    if (alreadyCreated(index)) return;
    if (!allowed.has(scheduleAParentLotId(lot))) missing.push(index);
  });
  return missing;
}
