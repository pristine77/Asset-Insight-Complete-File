import type { MixedLot } from '../camera/types';
import type { AuctioneerScheduleAChoice, AuctioneerWorkItemSetup } from '../../services/auctioneerService';
import { isProposalListSetup, normalizeProposalLots, proposalLotSource, proposalSeedLots } from './proposalListPolicy';

// owner 2026-10-28: a lot on a Schedule A contract is not sent until the
// appraiser has chosen its Schedule A item. These are the exact messages.
export const SCHEDULE_A_ITEM_NONE_MESSAGE =
  'No Schedule A item on this contract is marked Several lots in Auctioneer 2.0. Ask the office to tick it on the contract, then try again.';
export const SCHEDULE_A_ITEM_CHOOSE_MESSAGE = 'Choose which Schedule A item these lots belong to.';

// One shared empty list keeps form callbacks that depend on the choices stable.
const NO_SCHEDULE_A_CHOICES: AuctioneerScheduleAChoice[] = [];

/** The items offered for this form; none when the setup does not require one. */
export function scheduleAChoicesFor(setup: AuctioneerWorkItemSetup | undefined): AuctioneerScheduleAChoice[] {
  return setup?.requiresScheduleAItem === true && Array.isArray(setup.scheduleAChoices) && setup.scheduleAChoices.length
    ? setup.scheduleAChoices
    : NO_SCHEDULE_A_CHOICES;
}

/** A chosen (or saved) parent lot counts only while it is still offered. */
export function validScheduleAChoice(choices: AuctioneerScheduleAChoice[], parentLotId: unknown): string | undefined {
  return typeof parentLotId === 'string' && choices.some((choice) => choice.parentLotId === parentLotId)
    ? parentLotId
    : undefined;
}

/** Why Submit must stop, or undefined when the lots may be sent. */
export function scheduleAItemBlockMessage(
  required: boolean,
  choices: AuctioneerScheduleAChoice[],
  parentLotId: string | undefined
): string | undefined {
  if (!required) return undefined;
  if (!choices.length) return SCHEDULE_A_ITEM_NONE_MESSAGE;
  return validScheduleAChoice(choices, parentLotId) ? undefined : SCHEDULE_A_ITEM_CHOOSE_MESSAGE;
}

export { scheduleAItemLotField } from '../../services/scheduleAItemLotField';

export function auctioneerSeedLots(setup: AuctioneerWorkItemSetup): MixedLot[] {
  // owner 2026-10-28: a Proposal worked from its list starts with one lot per
  // listed item still to capture. Only a setup that carries the list; every
  // other kind "unknown" setup still starts empty.
  if (isProposalListSetup(setup)) return proposalSeedLots(setup);
  const count = setup.kind === 'scheduleA' ? setup.lots.length : 0;
  return Array.from({ length: count }, (_, index) => ({
    id: `auctioneer-${setup.workItemId}-${index + 1}`,
    mode: 'single_lot' as const,
    files: [], extraFiles: [], coverIndex: 0,
  }));
}

export function hasValidAuctioneerLotStructure(setup: AuctioneerWorkItemSetup | undefined, lots: MixedLot[]): boolean {
  if (!setup || setup.kind !== 'scheduleA') return true;
  return lots.length === setup.lots.length && lots.every((lot, index) =>
    lot.id === `auctioneer-${setup.workItemId}-${index + 1}` && lot.mode === 'single_lot');
}

/**
 * The source fields one lot sends. A Schedule A lot names its line by position;
 * on a Proposal list (owner 2026-10-28) a listed lot names its item by its own
 * id, so removing or reordering lots never moves a key to another lot.
 */
/**
 * The lots a form keeps after a change: a changed Schedule A layout is refused
 * (as before), and on a Proposal list each listed lot stays one Bundle lot
 * (owner 2026-10-28). Any other setup keeps exactly what it was given.
 */
export function acceptAuctioneerLots(
  setup: AuctioneerWorkItemSetup | undefined,
  previous: MixedLot[],
  next: MixedLot[]
): MixedLot[] {
  return hasValidAuctioneerLotStructure(setup, next) ? normalizeProposalLots(setup, next) : previous;
}

export function auctioneerLotSource(setup: AuctioneerWorkItemSetup | undefined, index: number, lot?: Pick<MixedLot, 'id'>) {
  if (isProposalListSetup(setup)) return proposalLotSource(setup, lot);
  const source = setup?.kind === 'scheduleA' ? setup.lots[index] : undefined;
  return source ? {
    source_key: source.sourceKey,
    source_lot_id: source.lotId,
    source_submission_id: source.submissionId,
  } : {};
}

export function acceptedAuctioneerReportId(value: unknown): string | undefined {
  const reportId = value && typeof value === 'object' ? (value as { reportId?: unknown }).reportId : undefined;
  return typeof reportId === 'string' && reportId.trim() ? reportId.trim() : undefined;
}
