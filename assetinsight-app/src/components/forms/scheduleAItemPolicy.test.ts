import {
  SCHEDULE_A_ITEM_CHOOSE_MESSAGE,
  SCHEDULE_A_ITEM_NONE_MESSAGE,
  scheduleAChoicesFor,
  scheduleAItemBlockMessage,
  scheduleAItemLotField,
  validScheduleAChoice,
} from './auctioneerFormPolicy';
import type { AuctioneerWorkItemSetup } from '../../services/auctioneerService';

// owner 2026-10-28: a lot on a Schedule A contract is never sent without its
// Schedule A item; contracts without that requirement behave exactly as before.
const choices = [
  { lineId: 'line-1', title: '2021 Ford F150', parentLotId: 'parent-lot-1' },
  { lineId: 'line-2', title: 'Misc Shop Tools', parentLotId: 'parent-lot-2' },
];
const setup = (fields: Partial<AuctioneerWorkItemSetup> = {}) => ({
  workItemId: 'work', cycleKey: 'cycle', kind: 'unknown', reportType: 'asset',
  contract: { id: 'contract', contractNo: '93530.3-A', customerName: '', eventTitle: '', location: '' },
  lots: [], ...fields,
}) as AuctioneerWorkItemSetup;

it('offers choices only when the setup requires a Schedule A item', () => {
  expect(scheduleAChoicesFor(setup({ requiresScheduleAItem: true, scheduleAChoices: choices }))).toBe(choices);
  expect(scheduleAChoicesFor(setup({ requiresScheduleAItem: false, scheduleAChoices: choices }))).toEqual([]);
  // A draft snapshot saved by an older app has neither field.
  expect(scheduleAChoicesFor(setup())).toEqual([]);
  expect(scheduleAChoicesFor(undefined)).toEqual([]);
  // The same empty list every time, so form callbacks that depend on it stay stable.
  expect(scheduleAChoicesFor(setup())).toBe(scheduleAChoicesFor(undefined));
});

it('keeps a chosen item only while it is still offered', () => {
  expect(validScheduleAChoice(choices, 'parent-lot-2')).toBe('parent-lot-2');
  expect(validScheduleAChoice(choices, 'parent-lot-gone')).toBeUndefined();
  expect(validScheduleAChoice([], 'parent-lot-2')).toBeUndefined();
  expect(validScheduleAChoice(choices, undefined)).toBeUndefined();
  expect(validScheduleAChoice(choices, { parentLotId: 'parent-lot-2' })).toBeUndefined();
});

it('blocks Submit with the exact plain-English reasons', () => {
  expect(scheduleAItemBlockMessage(false, [], undefined)).toBeUndefined();
  expect(scheduleAItemBlockMessage(true, [], undefined)).toBe(
    'No Schedule A item on this contract is marked Several lots in Auctioneer 2.0. Ask the office to tick it on the contract, then try again.'
  );
  expect(scheduleAItemBlockMessage(true, choices, undefined)).toBe('Choose which Schedule A item these lots belong to.');
  expect(scheduleAItemBlockMessage(true, choices, 'parent-lot-1')).toBeUndefined();
  expect(SCHEDULE_A_ITEM_NONE_MESSAGE).toMatch(/^No Schedule A item/);
  expect(SCHEDULE_A_ITEM_CHOOSE_MESSAGE).toMatch(/^Choose which/);
});

it('adds the lot field only for a chosen item', () => {
  expect(scheduleAItemLotField('parent-lot-1')).toEqual({ schedule_a_parent_lot_id: 'parent-lot-1' });
  expect(scheduleAItemLotField(undefined)).toEqual({});
});
