import type { MixedLot } from '../camera/types';
import type {
  AuctioneerProposalItem,
  AuctioneerProposalItemState,
  AuctioneerWorkItemSetup,
} from '../../services/auctioneerService';

/*
   A Proposal worked item by item from its uploaded Schedule A list (owner
   2026-10-28). The form starts with one lot per listed item still to be
   captured; each such lot sends its item's source key, and the server keeps it
   one lot (green). Lots the user adds are items that were not on the list
   (blue). A listed item the user cannot find is returned as Not found (red)
   instead of being captured. A setup without a list is untouched by all of
   this: every helper below returns its "no list" answer for it.

   A listed lot carries its item in its own id ("listed-" + the source key with
   every character outside [A-Za-z0-9-] written as _XXXX). The id already
   survives everything a lot goes through (camera round trips, drafts, restore,
   recovery journals), so the item cannot be lost or swapped on the way, and it
   is safe in the file names drafts build from lot ids. It is decoded without
   the current list: a lot whose item is no longer assigned still sends its key
   and the server refuses it with its own message, rather than the lot quietly
   becoming an item that was not on the list.
*/

const LISTED_LOT_ID_PREFIX = 'listed-';
const ENCODED_BODY = /^(?:[A-Za-z0-9-]|_[0-9a-f]{4})+$/;

/** True for a Proposal worked from its list; false for every other setup. */
export function isProposalListSetup(setup: AuctioneerWorkItemSetup | undefined): boolean {
  return setup?.kind === 'unknown' && Boolean(setup.proposalList);
}

/** The listed items of a list setup; none for every other setup. */
export function proposalItemsOf(setup: AuctioneerWorkItemSetup | undefined): AuctioneerProposalItem[] {
  return isProposalListSetup(setup) ? setup!.proposalList!.items : [];
}

/** The lot id that names a listed item (see the module comment). */
export function proposalItemLotId(sourceKey: string): string {
  return LISTED_LOT_ID_PREFIX + sourceKey.replace(
    /[^A-Za-z0-9-]/g,
    (character) => `_${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

/** The source key a listed lot carries, or undefined for any other lot. */
export function proposalItemSourceKeyOfLot(lot: Pick<MixedLot, 'id'> | undefined): string | undefined {
  const lotId = typeof lot?.id === 'string' ? lot.id : '';
  if (!lotId.startsWith(LISTED_LOT_ID_PREFIX)) return undefined;
  const body = lotId.slice(LISTED_LOT_ID_PREFIX.length);
  if (!ENCODED_BODY.test(body)) return undefined;
  return body.replace(/_([0-9a-f]{4})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** The listed item a lot captures in this list, if any. */
export function proposalItemOfLot(
  items: readonly AuctioneerProposalItem[],
  lot: Pick<MixedLot, 'id'> | undefined
): AuctioneerProposalItem | undefined {
  const key = proposalItemSourceKeyOfLot(lot);
  return key ? items.find((item) => item.sourceKey === key) : undefined;
}

/** "Lot 12 · 2019 CAT Forklift", or the title alone when the item has no lot number. */
export function proposalItemLabel(item: AuctioneerProposalItem): string {
  return item.lotNumber ? `Lot ${item.lotNumber} · ${item.title}` : item.title;
}

/** A fresh, empty lot for a listed item: one Bundle lot, as the server keeps it. */
export function proposalItemLot(item: AuctioneerProposalItem): MixedLot {
  return {
    id: proposalItemLotId(item.sourceKey),
    mode: 'single_lot',
    ...(item.lotNumber ? { lotNumber: item.lotNumber } : {}),
    title: item.title,
    files: [],
    extraFiles: [],
    coverIndex: 0,
  };
}

/** A new list form starts with one lot per item still to be captured, in list order. */
export function proposalSeedLots(setup: AuctioneerWorkItemSetup): MixedLot[] {
  return proposalItemsOf(setup)
    .filter((item) => item.state === 'outstanding')
    .map(proposalItemLot);
}

/**
 * The source field a lot sends. Only a listed lot of a list setup has one;
 * every other lot (and every lot of any other setup) sends nothing here.
 */
export function proposalLotSource(
  setup: AuctioneerWorkItemSetup | undefined,
  lot: Pick<MixedLot, 'id'> | undefined
): { source_key?: string } {
  if (!isProposalListSetup(setup)) return {};
  const key = proposalItemSourceKeyOfLot(lot);
  return key ? { source_key: key } : {};
}

/**
 * Keeps every listed lot one Bundle lot (the server forces it anyway: one
 * listed item comes back as exactly one item). Returns the same array when
 * nothing changes, so other setups and settled lots cause no extra render.
 */
export function normalizeProposalLots(setup: AuctioneerWorkItemSetup | undefined, lots: MixedLot[]): MixedLot[] {
  if (!isProposalListSetup(setup)) return lots;
  let changed = false;
  const next = lots.map((lot) => {
    if (lot.mode === 'single_lot' || !proposalItemSourceKeyOfLot(lot)) return lot;
    changed = true;
    return { ...lot, mode: 'single_lot' as const };
  });
  return changed ? next : lots;
}

export interface ProposalLotPresentation {
  /** The lot's heading; '' keeps the usual "Lot N". */
  labels: string[];
  /** "Not on list" on the lots the user added: the owner's blue outcome. */
  tags: (string | undefined)[];
  /** A second line under the heading, e.g. the serial number. */
  details: (string | undefined)[];
  /** Which lots capture a listed item (one Bundle lot each, mode locked). */
  listed: boolean[];
}

/** How each lot is shown on a list setup; undefined for every other setup. */
export function proposalLotPresentation(
  setup: AuctioneerWorkItemSetup | undefined,
  lots: MixedLot[],
  items: readonly AuctioneerProposalItem[] = proposalItemsOf(setup)
): ProposalLotPresentation | undefined {
  if (!isProposalListSetup(setup)) return undefined;
  const result: ProposalLotPresentation = { labels: [], tags: [], details: [], listed: [] };
  // One lookup per lot, so a long list stays cheap on every render.
  const byKey = new Map(items.map((candidate) => [candidate.sourceKey, candidate]));
  for (const lot of lots) {
    const key = proposalItemSourceKeyOfLot(lot);
    const listed = Boolean(key);
    const item = key ? byKey.get(key) : undefined;
    result.listed.push(listed);
    if (item) {
      result.labels.push(proposalItemLabel(item));
      result.tags.push(undefined);
      result.details.push(item.serialNumber ? `S/N ${item.serialNumber}` : undefined);
    } else if (listed) {
      // Kept from a draft after the office took the item off this user's list.
      // It is still sent as that item; the server explains if it is refused.
      result.labels.push(lot.title || 'Listed item');
      result.tags.push(undefined);
      result.details.push('No longer on your list');
    } else {
      result.labels.push('');
      result.tags.push('Not on list');
      result.details.push(undefined);
    }
  }
  return result;
}

/**
 * Lots of a list form that hold no photos or video at all. Every lot sent
 * needs a main photo, so these are left out (removed) before sending; a listed
 * one simply stays outstanding. None on any other setup.
 */
export function proposalLotsWithoutMedia(setup: AuctioneerWorkItemSetup | undefined, lots: MixedLot[]): MixedLot[] {
  if (!isProposalListSetup(setup)) return [];
  return lots.filter((lot) => !lot.files.length && !lot.extraFiles.length && !lot.videoFile);
}

/** Why Submit stopped for lots without photos, naming each one as the form shows it. */
export function proposalLotsWithoutMediaPrompt(
  setup: AuctioneerWorkItemSetup | undefined,
  lots: MixedLot[],
  items: readonly AuctioneerProposalItem[] = proposalItemsOf(setup)
): string {
  const empty = new Set(proposalLotsWithoutMedia(setup, lots).map((lot) => lot.id));
  const names = lots.flatMap((lot, index) => {
    if (!empty.has(lot.id)) return [];
    const item = proposalItemOfLot(items, lot);
    return [item ? proposalItemLabel(item) : lot.title || `Lot ${index + 1}`];
  });
  const shown = names.slice(0, 5).join(', ') + (names.length > 5 ? ` and ${names.length - 5} more` : '');
  return `${names.length === 1 ? 'This lot has' : `These ${names.length} lots have`} no photos yet: ${shown}. ` +
    'Every lot sent needs a photo. Capture them, or remove them from this form and send again. ' +
    'A listed item you remove stays to capture; you can add it back from Proposal items.';
}

export const PROPOSAL_ITEM_STATE_LABELS: Record<AuctioneerProposalItemState, string> = {
  outstanding: 'To capture',
  in_other_report: 'In another report',
  returned: 'Returned',
  not_found: 'Not found',
};

/** The confirmation shown before an item is returned as not found. */
export function proposalNotFoundPrompt(item: AuctioneerProposalItem, lot?: MixedLot): string {
  const media = lot ? lot.files.length + lot.extraFiles.length + (lot.videoFile ? 1 : 0) : 0;
  return `Return ${proposalItemLabel(item)} to Auctioneer as not found? It will not be captured.` +
    (media ? ` The ${media} ${media === 1 ? 'photo or video' : 'photos and videos'} taken for it in this form will be removed.` : '');
}

export const PROPOSAL_NOT_FOUND_OFFLINE_MESSAGE =
  'Returning an item as not found needs a connection. Connect, then try again. Nothing was sent.';
