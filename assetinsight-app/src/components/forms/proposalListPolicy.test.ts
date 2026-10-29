import {
  acceptAuctioneerLots,
  auctioneerLotSource,
  auctioneerSeedLots,
  hasValidAuctioneerLotStructure,
} from './auctioneerFormPolicy';
import {
  isProposalListSetup,
  normalizeProposalLots,
  proposalItemLotId,
  proposalItemSourceKeyOfLot,
  proposalLotPresentation,
  proposalLotsWithoutMedia,
  proposalLotsWithoutMediaPrompt,
  proposalNotFoundPrompt,
} from './proposalListPolicy';
import { proposalItemLotField } from '../../services/proposalItemLotField';
import type { MixedLot } from '../camera/types';
import type { AuctioneerProposalItem, AuctioneerWorkItemSetup } from '../../services/auctioneerService';

// owner 2026-10-28: a Proposal worked from its uploaded list starts with one
// lot per listed item still to capture; each sends its item's source key, the
// lots the user adds send none (items that were not on the list), and a setup
// without a list behaves exactly as before.
const item = (lineId: string, state: AuctioneerProposalItem['state'], fields: Partial<AuctioneerProposalItem> = {}): AuctioneerProposalItem => ({
  lineId, sourceKey: `proposal-line:${lineId}`, title: `Item ${lineId}`, state, ...fields,
});
const items = [
  item('L1', 'outstanding', { lotNumber: '12', title: '2019 CAT Forklift', serialNumber: 'CAT-991' }),
  item('L2', 'returned'),
  item('L3', 'not_found'),
  item('L4', 'in_other_report'),
  item('L5', 'outstanding'),
];
const setup = (fields: Partial<AuctioneerWorkItemSetup> = {}): AuctioneerWorkItemSetup => ({
  workItemId: 'work', cycleKey: 'cycle', kind: 'unknown', reportType: 'asset',
  clientSubmissionId: 'submission', status: 'claimed', reportId: null,
  contract: { id: 'contract', contractNo: 'P-100', customerName: '', eventTitle: '', location: '' },
  lots: [], requiresScheduleAItem: false, scheduleAChoices: [],
  proposalList: { items }, ...fields,
});
const extra = (id = 'lot-extra', files = 1): MixedLot => ({
  id, mode: 'per_item', files: Array.from({ length: files }, (_, index) => ({ uri: `file:///${id}-${index}.jpg` })) as any,
  extraFiles: [], coverIndex: 0,
});

it('seeds one single-lot lot per outstanding item, carrying its item in the lot id', () => {
  const lots = auctioneerSeedLots(setup());
  expect(lots).toEqual([
    { id: proposalItemLotId('proposal-line:L1'), mode: 'single_lot', lotNumber: '12', title: '2019 CAT Forklift', files: [], extraFiles: [], coverIndex: 0 },
    { id: proposalItemLotId('proposal-line:L5'), mode: 'single_lot', title: 'Item L5', files: [], extraFiles: [], coverIndex: 0 },
  ]);
  expect(lots.map(proposalItemSourceKeyOfLot)).toEqual(['proposal-line:L1', 'proposal-line:L5']);
  // Returned, not found and in-another-report items are never seeded.
  expect(lots.some((lot) => /L2|L3|L4/.test(lot.id))).toBe(false);
});

it('seeds nothing for an empty list and changes nothing for setups without a list', () => {
  expect(auctioneerSeedLots(setup({ proposalList: { items: [] } }))).toEqual([]);
  const plain = setup({ proposalList: undefined });
  expect(isProposalListSetup(plain)).toBe(false);
  expect(auctioneerSeedLots(plain)).toEqual([]);
  // A Schedule A setup still seeds one locked lot per line, whatever else it carries.
  const scheduleA = setup({ kind: 'scheduleA', lots: [{ sourceKey: 'line-a' }, { sourceKey: 'line-b' }] });
  expect(isProposalListSetup(scheduleA)).toBe(false);
  expect(auctioneerSeedLots(scheduleA).map((lot) => lot.id)).toEqual(['auctioneer-work-1', 'auctioneer-work-2']);
  expect(auctioneerLotSource(scheduleA, 1)).toEqual({ source_key: 'line-b', source_lot_id: undefined, source_submission_id: undefined });
});

it('keeps any source key intact through a file-name-safe lot id', () => {
  for (const key of ['proposal-line:L1', 'proposal-line:7f3a-22', 'proposal-line:a b/c:d_é%', 'proposal-line:😀']) {
    const lotId = proposalItemLotId(key);
    expect(lotId).toMatch(/^listed-[A-Za-z0-9_-]+$/);
    expect(proposalItemSourceKeyOfLot({ id: lotId })).toBe(key);
  }
  for (const lotId of ['lot-123', 'auctioneer-work-1', 'listed-', 'listed-bad_zz', 'listed-a b', '']) {
    expect(proposalItemSourceKeyOfLot({ id: lotId })).toBeUndefined();
  }
  expect(proposalItemSourceKeyOfLot(undefined)).toBeUndefined();
});

it('sends source_key for listed lots only, never for extras, and nothing on other setups', () => {
  const [listed] = auctioneerSeedLots(setup());
  expect(auctioneerLotSource(setup(), 0, listed)).toEqual({ source_key: 'proposal-line:L1' });
  expect(auctioneerLotSource(setup(), 1, extra())).toEqual({});
  // A listed lot kept from a draft after its item left the list still names it;
  // the server answers with its own refusal instead of a silent extra.
  expect(auctioneerLotSource(setup({ proposalList: { items: [] } }), 0, listed)).toEqual({ source_key: 'proposal-line:L1' });
  expect(auctioneerLotSource(setup({ proposalList: undefined }), 0, listed)).toEqual({});
  expect(auctioneerLotSource(undefined, 0, listed)).toEqual({});
});

it('keeps listed lots one Bundle lot and leaves everything else untouched', () => {
  const [listed] = auctioneerSeedLots(setup());
  const lots = [{ ...listed, mode: 'per_photo' as const }, extra()];
  const normalized = normalizeProposalLots(setup(), lots);
  expect(normalized.map((lot) => lot.mode)).toEqual(['single_lot', 'per_item']);
  // Nothing to change: the very same array, so no extra render.
  expect(normalizeProposalLots(setup(), normalized)).toBe(normalized);
  expect(normalizeProposalLots(setup({ proposalList: undefined }), lots)).toBe(lots);
  expect(acceptAuctioneerLots(setup(), [], lots).map((lot) => lot.mode)).toEqual(['single_lot', 'per_item']);
  // Removing or adding lots is allowed on a list (no locked structure).
  expect(hasValidAuctioneerLotStructure(setup(), [extra()])).toBe(true);
  expect(acceptAuctioneerLots(setup({ proposalList: undefined }), [], lots)).toBe(lots);
});

it('labels listed lots with lot number, title and serial, and tags extras as not on the list', () => {
  const [listed] = auctioneerSeedLots(setup());
  const stale = { ...listed, id: proposalItemLotId('proposal-line:GONE'), title: 'Old item' };
  expect(proposalLotPresentation(setup(), [listed, extra(), stale])).toEqual({
    labels: ['Lot 12 · 2019 CAT Forklift', '', 'Old item'],
    tags: [undefined, 'Not on list', undefined],
    details: ['S/N CAT-991', undefined, 'No longer on your list'],
    listed: [true, false, true],
  });
  expect(proposalLotPresentation(setup({ proposalList: undefined }), [extra()])).toBeUndefined();
});

it('finds lots without any photo or video and names them for the Submit prompt', () => {
  const seeded = auctioneerSeedLots(setup());
  const lots = [seeded[0], extra(), seeded[1], { ...extra('lot-empty', 0) }];
  expect(proposalLotsWithoutMedia(setup(), lots).map((lot) => lot.id)).toEqual([seeded[0].id, seeded[1].id, 'lot-empty']);
  expect(proposalLotsWithoutMediaPrompt(setup(), lots)).toContain('These 3 lots have no photos yet: Lot 12 · 2019 CAT Forklift, Item L5, Lot 4.');
  // A lot with only a report-only photo or a video is kept.
  const withExtra = { ...seeded[0], extraFiles: [{ uri: 'file:///extra.jpg' }] as any };
  const withVideo = { ...seeded[1], videoFile: { uri: 'file:///clip.mp4' } as any };
  expect(proposalLotsWithoutMedia(setup(), [withExtra, withVideo])).toEqual([]);
  // Other setups keep today's behaviour (the server explains an empty lot).
  expect(proposalLotsWithoutMedia(setup({ proposalList: undefined }), lots)).toEqual([]);
});

it('words the Not found confirmation, including photos it would drop', () => {
  expect(proposalNotFoundPrompt(items[0])).toBe('Return Lot 12 · 2019 CAT Forklift to Auctioneer as not found? It will not be captured.');
  const [lot] = auctioneerSeedLots(setup());
  expect(proposalNotFoundPrompt(items[0], { ...lot, files: [{ uri: 'a' }, { uri: 'b' }] as any }))
    .toContain('The 2 photos and videos taken for it in this form will be removed.');
});

it('lets the offline queue keep only a listed item key', () => {
  expect(proposalItemLotField('proposal-line:L1')).toEqual({ source_key: 'proposal-line:L1' });
  for (const value of ['line-a', 'proposal-line:', undefined, 7, 'work:unknown:1']) {
    expect(proposalItemLotField(value)).toEqual({});
  }
});
