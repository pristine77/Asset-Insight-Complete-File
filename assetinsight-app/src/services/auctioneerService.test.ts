import api from './api';
import auctioneerService, {
  isEditableAuctioneerSetup,
  parseAuctioneerSetup,
  validateAuctioneerSuccessor,
} from './auctioneerService';
import {
  auctioneerSeedLots,
  auctioneerLotSource,
  hasValidAuctioneerLotStructure,
} from '../components/forms/auctioneerFormPolicy';
import { invalidateAuthOperations } from './authSessionOperation';

jest.mock('./api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
const fixture = () => ({
  workItemId: 'parent',
  cycleKey: 'cycle',
  reportType: 'asset' as const,
  kind: 'scheduleA' as const,
  clientSubmissionId: 'submission-parent',
  status: 'claimed' as const,
  reportId: null,
  contract: { id: 'contract', contractNo: '93530.3-A', eventId: 'event-original' },
  lots: [
    { sourceKey: 'source-one', lotId: 'lot-one' },
    { sourceKey: 'source-two', lotId: 'lot-two' },
  ],
});
beforeEach(() => jest.clearAllMocks());

it('loads Incoming through the protected production API path and preserves contract metadata', async () => {
  const row = {
    cycleKey: 'cycle',
    contractId: 'contract',
    contractNo: '93530',
    kind: 'unknown',
    lotCount: 0,
    status: 'available',
    consignorName: 'Consignor',
    salespersonName: 'Salesperson',
    description: 'Farm equipment',
  };
  jest.mocked(api.get).mockResolvedValue({ data: { data: { items: [row] } } });
  const result = await auctioneerService.getIncoming(true);
  expect(api.get).toHaveBeenCalledWith('/auctioneer/incoming', { params: { refresh: true } });
  expect(result[0]).toMatchObject({ ...row, customerName: '', eventTitle: '', location: '' });
});

it('rejects malformed metadata instead of rendering an incomplete queue as success', async () => {
  jest
    .mocked(api.get)
    .mockResolvedValue({
      data: {
        data: [{ cycleKey: 'cycle', contractNo: '93530', status: 'available', description: {} }],
      },
    });
  await expect(auctioneerService.getIncoming()).rejects.toThrow('incomplete');
});

it('checks Re-Open through the authenticated contract route and preserves explicit permission and revision', async () => {
  const permission = { reopen: { allowed: true, reason: null, reopenUntil: '2026-10-27T15:00:00.000Z' }, accessRevision: 0, eventClosed: false };
  jest.mocked(api.get).mockResolvedValue({ data: { success: true, data: permission } });
  expect(await auctioneerService.getCapturePermission('contract/1')).toEqual(permission);
  expect(api.get).toHaveBeenCalledWith('/auctioneer/contracts/contract%2F1/capture-permission');
});

it.each([
  {},
  { reopen: { allowed: 'true', reason: null, reopenUntil: null } },
  { reopen: { allowed: true, reason: null } },
  { reopen: { allowed: false, reason: null, reopenUntil: null }, confirmationPending: 'true' },
  { reopen: { allowed: true, reason: null, reopenUntil: null }, accessRevision: -1 },
])('rejects unverified Re-Open permission %#', async (data) => {
  jest.mocked(api.get).mockResolvedValue({ data: { success: true, data } });
  await expect(auctioneerService.getCapturePermission('contract')).rejects.toThrow('could not be verified');
});

it.each([
  { reopened: true, alreadyOpen: false, accessRevision: 'new-revision' },
  { reopened: false, alreadyOpen: true, accessRevision: 0 },
])('accepts a verified Re-Open receipt without sending a client actor %#', async (result) => {
  jest.mocked(api.post).mockResolvedValue({ data: { success: true, data: { contractId: 'contract/1', ...result } } });
  expect(await auctioneerService.reopenContract('contract/1')).toEqual({ contractId: 'contract/1', ...result });
  expect(api.post).toHaveBeenCalledWith('/auctioneer/contracts/contract%2F1/reopen', {}, { skipAuthRefreshReplay: true });
  expect(api.post).toHaveBeenCalledTimes(1);
});

it.each([
  {},
  { contractId: 'contract', reopened: true },
  { contractId: 'other', reopened: true, accessRevision: 2 },
  { contractId: 'contract', reopened: true, alreadyOpen: true, accessRevision: 2 },
  { contractId: 'contract', reopened: false, alreadyOpen: false, accessRevision: 2 },
  { contractId: 'contract', reopened: true, accessRevision: -1 },
])('does not claim success for ambiguous Re-Open receipt %#', async (data) => {
  jest.mocked(api.post).mockResolvedValue({ data: { success: true, data } });
  await expect(auctioneerService.reopenContract('contract')).rejects.toThrow('not confirmed');
});

it('limits lazy permission reads to four and discards queued reads after the account session changes', async () => {
  const resolve: ((value: unknown) => void)[] = [];
  jest.mocked(api.get).mockImplementation(() => new Promise((done) => resolve.push(done)));
  const results = Array.from({ length: 6 }, (_, index) => auctioneerService.getCapturePermission(`contract-${index}`));
  const settled = Promise.allSettled(results);
  expect(api.get).toHaveBeenCalledTimes(4);
  invalidateAuthOperations();
  resolve.forEach((done) => done({ data: { success: true, data: { reopen: { allowed: false, reason: null, reopenUntil: null } } } }));
  const outcomes = await settled;
  expect(api.get).toHaveBeenCalledTimes(4);
  expect(outcomes.slice(4).every((value) => value.status === 'rejected')).toBe(true);
});

it('reserves a queued continuation with normal protected auth and no transfer-grant rotation or secret header', async () => {
  const next = {
    ...fixture(),
    workItemId: 'next',
    clientSubmissionId: 'submission-next',
    kind: 'unknown',
    lots: [],
  };
  const reservation = {
    id: 'reservation',
    status: 'reserved',
    ownerId: 'owner',
    parentWorkItemId: 'parent/1',
    parentSessionId: 'session',
    parentClientSubmissionId: 'submission-parent',
    parentCaptureId: 'capture',
    successorWorkItemId: 'next',
  };
  jest
    .mocked(api.post)
    .mockResolvedValue({ data: { success: true, data: { reservation, setup: next } } });
  const result = await auctioneerService.continueUpload('parent/1', 'session');
  expect(result.reservation).toEqual(reservation);
  expect(api.post).toHaveBeenCalledWith(
    '/auctioneer/work-items/parent%2F1/continue-upload',
    { sessionId: 'session' },
    { timeout: 30_000 }
  );
  expect(api.post).toHaveBeenCalledTimes(1);
});

it.each([{}, { status: 'accepted' }, { id: 'reservation', status: 'reserved', ownerId: 'owner' }])(
  'rejects incomplete queued continuation receipts %#',
  async (reservation) => {
    jest.mocked(api.post).mockResolvedValue({ data: { data: { reservation, setup: fixture() } } });
    await expect(auctioneerService.continueUpload('parent', 'session')).rejects.toThrow(
      'could not be verified'
    );
  }
);

it('accepts optional/null display metadata and preserves explicit used-report state', () => {
  const parsed = parseAuctioneerSetup({
    ...fixture(),
    contract: { ...fixture().contract, customerName: null },
    status: 'report_created',
    reportId: 'report',
  });
  expect(parsed.contract).toMatchObject({ customerName: '', eventTitle: '', location: '' });
  expect(parsed.reportId).toBe('report');
  expect(isEditableAuctioneerSetup(parsed, 'asset')).toBe(false);
});

it.each([
  {},
  { ...fixture(), lots: null },
  { ...fixture(), workItemId: '' },
  { ...fixture(), status: 'future-state' },
  { ...fixture(), contract: { id: 'contract', contractNo: '93530.3-A', eventDate: {} } },
])('rejects incomplete or unsafe setup %#', (value) => {
  expect(() => parseAuctioneerSetup(value)).toThrow(/incomplete/);
});

it('claims by encoded cycle key and then fetches the full authoritative setup', async () => {
  jest.mocked(api.post).mockResolvedValue({ data: { data: { workItemId: 'work/1 ?' } } });
  jest
    .mocked(api.get)
    .mockResolvedValue({ data: { data: { ...fixture(), workItemId: 'work/1 ?' } } });
  const value = await auctioneerService.claim('cycle/1 ?', 'asset');
  expect(api.post).toHaveBeenCalledWith('/auctioneer/incoming/cycle%2F1%20%3F/claim', {
    reportType: 'asset',
  });
  expect(api.get).toHaveBeenCalledWith('/auctioneer/work-items/work%2F1%20%3F/setup');
  expect(value.workItemId).toBe('work/1 ?');
});

it('continues only with an explicit report ID and never sends previous source lots', async () => {
  const next = {
    ...fixture(),
    workItemId: 'next',
    clientSubmissionId: 'submission-next',
    kind: 'unknown',
    lots: [],
  };
  jest.mocked(api.post).mockResolvedValue({ data: { data: next } });
  await expect(auctioneerService.continueWorkItem('parent/1', '')).rejects.toThrow(
    /accepted report/
  );
  expect(api.post).not.toHaveBeenCalled();
  const result = await auctioneerService.continueWorkItem('parent/1', 'report-parent');
  expect(api.post).toHaveBeenCalledWith('/auctioneer/work-items/parent%2F1/continue', {
    reportId: 'report-parent',
  });
  expect(() => validateAuctioneerSuccessor(parseAuctioneerSetup(fixture()), result)).not.toThrow();
  expect(auctioneerSeedLots(result)).toEqual([]);
  expect(auctioneerLotSource(result, 0)).toEqual({});
});

it.each([
  { workItemId: 'parent' },
  { clientSubmissionId: 'submission-parent' },
  { status: 'report_created', reportId: 'existing' },
  { kind: 'scheduleA' },
  { lots: [{ sourceKey: 'old-source' }] },
  { reportType: 'lotListing' },
  { contract: { id: 'other', contractNo: '93530.3-A' } },
  { status: 'abandoned' },
  { contract: { ...fixture().contract, eventId: 'changed-event' } },
])('rejects unsafe successor %#', (change) => {
  const previous = parseAuctioneerSetup(fixture());
  const next = parseAuctioneerSetup({
    ...fixture(),
    workItemId: 'next',
    clientSubmissionId: 'submission-next',
    kind: 'unknown',
    lots: [],
    ...change,
  });
  expect(() => validateAuctioneerSuccessor(previous, next)).toThrow(/not a fresh lot/);
});

it('locks Schedule A identities, count, order and grouping while allowing original media edits', () => {
  const current = parseAuctioneerSetup(fixture());
  const lots = auctioneerSeedLots(current);
  expect(hasValidAuctioneerLotStructure(current, lots)).toBe(true);
  expect(hasValidAuctioneerLotStructure(current, lots.slice(1))).toBe(false);
  expect(hasValidAuctioneerLotStructure(current, [...lots].reverse())).toBe(false);
  expect(hasValidAuctioneerLotStructure(current, [...lots, lots[0]])).toBe(false);
  expect(
    hasValidAuctioneerLotStructure(
      current,
      lots.map((lot) => ({ ...lot, mode: 'per_photo' }))
    )
  ).toBe(false);
  expect(
    hasValidAuctioneerLotStructure(
      current,
      lots.map((lot) => ({
        ...lot,
        files: [{ uri: 'file:///photo.jpg', name: 'photo.jpg', type: 'image/jpeg' }],
      }))
    )
  ).toBe(true);
  expect(auctioneerLotSource(current, 1)).toEqual({
    source_key: 'source-two',
    source_lot_id: 'lot-two',
    source_submission_id: undefined,
  });
});

it('allows newly verified event metadata for a legacy setup without guessing or overriding a known event', () => {
  const previous = parseAuctioneerSetup({
    ...fixture(),
    contract: { ...fixture().contract, eventId: undefined },
  });
  const next = parseAuctioneerSetup({
    ...fixture(),
    workItemId: 'next',
    clientSubmissionId: 'submission-next',
    kind: 'unknown',
    lots: [],
  });
  expect(() => validateAuctioneerSuccessor(previous, next)).not.toThrow();
  expect(() =>
    validateAuctioneerSuccessor(next, {
      ...next,
      workItemId: 'third',
      clientSubmissionId: 'submission-third',
      contract: { ...next.contract, eventId: undefined },
    })
  ).toThrow(/not a fresh lot/);
});

// owner 2026-10-28: a lot without its own Schedule A line must name a Schedule A
// item ticked "Several lots" before it is sent.
describe('Schedule A item setup fields', () => {
  const unknownLot = () => ({ ...fixture(), workItemId: 'next', clientSubmissionId: 'submission-next', kind: 'unknown', lots: [] });

  it('defaults every new field for an older server that sends none of them', () => {
    const parsed = parseAuctioneerSetup(fixture());
    expect(parsed.requiresScheduleAItem).toBe(false);
    expect(parsed.scheduleAChoices).toEqual([]);
    expect(parsed.lots.map((lot) => lot.severalLots)).toEqual([false, false]);
    expect(parsed.lots[0]).not.toHaveProperty('scheduleALineId');
    expect(parsed.lots[0]).not.toHaveProperty('scheduleAItemTitle');
    expect(parsed.lots[0]).toMatchObject({ sourceKey: 'source-one', lotId: 'lot-one' });
  });

  it('keeps the requirement, the choices in Schedule A order and each source lot\'s item', () => {
    const parsed = parseAuctioneerSetup({
      ...unknownLot(),
      requiresScheduleAItem: true,
      scheduleAChoices: [
        { lineId: 'line-1', title: ' 2021 Ford F150 ', parentLotId: 'parent-1' },
        { lineId: 'line-2', title: 'Misc Shop Tools', parentLotId: 'parent-2' },
      ],
    });
    expect(parsed.requiresScheduleAItem).toBe(true);
    expect(parsed.scheduleAChoices).toEqual([
      { lineId: 'line-1', title: '2021 Ford F150', parentLotId: 'parent-1' },
      { lineId: 'line-2', title: 'Misc Shop Tools', parentLotId: 'parent-2' },
    ]);
    const scheduleA = parseAuctioneerSetup({
      ...fixture(),
      lots: [
        { sourceKey: 'source-one', severalLots: true, scheduleALineId: 'line-1', scheduleAItemTitle: '2021 Ford F150' },
        { sourceKey: 'source-two', severalLots: 'yes', scheduleALineId: '', scheduleAItemTitle: 7 },
      ],
    });
    expect(scheduleA.lots[0]).toEqual({ sourceKey: 'source-one', severalLots: true, scheduleALineId: 'line-1', scheduleAItemTitle: '2021 Ford F150' });
    expect(scheduleA.lots[1]).toEqual({ sourceKey: 'source-two', severalLots: false });
    // The successor check still accepts a fresh lot that carries the new fields.
    expect(() => validateAuctioneerSuccessor(parseAuctioneerSetup(fixture()), parsed)).not.toThrow();
  });

  it('drops malformed or repeated choices instead of offering an item that cannot be sent', () => {
    const parsed = parseAuctioneerSetup({
      ...unknownLot(),
      requiresScheduleAItem: true,
      scheduleAChoices: [
        null, 'line-0', {},
        { lineId: '', title: 'No line', parentLotId: 'parent-a' },
        { lineId: 'line-b', title: '   ', parentLotId: 'parent-b' },
        { lineId: 'line-c', title: 'No parent lot', parentLotId: '' },
        { lineId: 'line-d', title: 'Number parent', parentLotId: 42 },
        { lineId: 'line-e', title: 'Kept', parentLotId: 'parent-e' },
        { lineId: 'line-f', title: 'Same parent lot', parentLotId: 'parent-e' },
      ],
    });
    expect(parsed.scheduleAChoices).toEqual([{ lineId: 'line-e', title: 'Kept', parentLotId: 'parent-e' }]);
  });

  it.each([undefined, null, 'true', 1, {}])('treats a requirement of %p as not required and a non-list as no choices', (value) => {
    const parsed = parseAuctioneerSetup({ ...unknownLot(), requiresScheduleAItem: value, scheduleAChoices: value });
    expect(parsed.requiresScheduleAItem).toBe(false);
    expect(parsed.scheduleAChoices).toEqual([]);
  });

  it('reads the refreshed list on every setup request', async () => {
    jest.mocked(api.get).mockResolvedValue({ data: { data: { ...unknownLot(), requiresScheduleAItem: true,
      scheduleAChoices: [{ lineId: 'line-1', title: 'Misc Shop Tools', parentLotId: 'parent-1' }] } } });
    const value = await auctioneerService.getSetup('next');
    expect(value.requiresScheduleAItem).toBe(true);
    expect(value.scheduleAChoices).toEqual([{ lineId: 'line-1', title: 'Misc Shop Tools', parentLotId: 'parent-1' }]);
  });
});

// owner 2026-10-28: a Proposal worked item by item from its uploaded list.
describe('Proposal list', () => {
  const listSetup = (items: unknown) => ({
    ...fixture(), workItemId: 'list-work', clientSubmissionId: 'submission-list', kind: 'unknown', lots: [],
    proposalList: { items },
  });
  const listed = (lineId: string, state = 'outstanding', fields: Record<string, unknown> = {}) => ({
    lineId, sourceKey: `proposal-line:${lineId}`, title: `Item ${lineId}`, state, ...fields,
  });

  it('keeps each listed item with its state and only the text fields it really has', () => {
    const parsed = parseAuctioneerSetup(listSetup([
      listed('L1', 'outstanding', { lotNumber: ' 12 ', title: ' 2019 CAT Forklift ', serialNumber: 'CAT-991', year: '2019', make: 'CAT', model: 'GP25', description: 'Propane' }),
      listed('L2', 'returned', { serialNumber: 42, make: '' }),
      listed('L3', 'not_found'),
      listed('L4', 'in_other_report', { title: '   ' }),
    ]));
    expect(parsed.proposalList?.items).toEqual([
      { lineId: 'L1', sourceKey: 'proposal-line:L1', title: '2019 CAT Forklift', lotNumber: '12', serialNumber: 'CAT-991', year: '2019', make: 'CAT', model: 'GP25', description: 'Propane', state: 'outstanding' },
      { lineId: 'L2', sourceKey: 'proposal-line:L2', title: 'Item L2', state: 'returned' },
      { lineId: 'L3', sourceKey: 'proposal-line:L3', title: 'Item L3', state: 'not_found' },
      { lineId: 'L4', sourceKey: 'proposal-line:L4', title: 'Proposal item', state: 'in_other_report' },
    ]);
    // A list work item is still a fresh lots-free item for Create Lot & Continue.
    expect(() => validateAuctioneerSuccessor(parseAuctioneerSetup(fixture()), parsed)).not.toThrow();
  });

  it('drops items that cannot be captured or returned, repeats, and reads an unknown state as not offered', () => {
    const parsed = parseAuctioneerSetup(listSetup([
      null, 'L0', {},
      { sourceKey: 'proposal-line:X', title: 'No line', state: 'outstanding' },
      { lineId: 'L-no-key', title: 'No key', state: 'outstanding' },
      { lineId: '  ', sourceKey: 'proposal-line:blank', state: 'outstanding' },
      listed('L1'),
      listed('L1', 'outstanding', { title: 'Repeated line' }),
      { ...listed('L9'), sourceKey: 'proposal-line:L1' },
      listed('L5', 'archived'),
      listed('L6', null as unknown as string),
    ]));
    expect(parsed.proposalList?.items).toEqual([
      { lineId: 'L1', sourceKey: 'proposal-line:L1', title: 'Item L1', state: 'outstanding' },
      { lineId: 'L5', sourceKey: 'proposal-line:L5', title: 'Item L5', state: 'returned' },
      { lineId: 'L6', sourceKey: 'proposal-line:L6', title: 'Item L6', state: 'returned' },
    ]);
    expect(parseAuctioneerSetup({ ...listSetup([]), proposalList: { items: 'all' } }).proposalList).toEqual({ items: [] });
  });

  it.each([undefined, null, 'yes', ['L1'], 7])('treats a proposalList of %p as no list at all', (value) => {
    const parsed = parseAuctioneerSetup({ ...listSetup([]), proposalList: value });
    expect(parsed).not.toHaveProperty('proposalList');
  });

  it('adds nothing to a setup without a list', () => {
    expect(parseAuctioneerSetup(fixture())).not.toHaveProperty('proposalList');
  });

  it('marks only a true proposalList on Incoming rows', async () => {
    const row = { cycleKey: 'cycle', contractId: 'contract', contractNo: 'P-100', kind: 'unknown', lotCount: 3, status: 'available' };
    jest.mocked(api.get).mockResolvedValue({ data: { data: [{ ...row, proposalList: true }, { ...row, cycleKey: 'other', proposalList: 'yes' }, { ...row, cycleKey: 'plain' }] } });
    const [list, odd, plain] = await auctioneerService.getIncoming();
    expect(list.proposalList).toBe(true);
    expect(odd).not.toHaveProperty('proposalList');
    expect(plain).not.toHaveProperty('proposalList');
  });

  it('returns listed items as not found with exactly the documented body and reads the refreshed setup', async () => {
    jest.mocked(api.post).mockResolvedValue({ data: { success: true, data: {
      notFound: ['L1'], remainsInAssetInsight: true,
      setup: listSetup([listed('L1', 'not_found'), listed('L2')]),
    } } });
    const result = await auctioneerService.markProposalItemsNotFound('list-work', [' L1 ']);
    expect(api.post).toHaveBeenCalledWith('/auctioneer/work-items/list-work/proposal-items/not-found', { lineIds: ['L1'] });
    expect(result.notFound).toEqual(['L1']);
    expect(result.remainsInAssetInsight).toBe(true);
    expect(result.setup.proposalList?.items.map((item) => item.state)).toEqual(['not_found', 'outstanding']);
  });

  it('reads a missing remainsInAssetInsight as unknown', async () => {
    jest.mocked(api.post).mockResolvedValue({ data: { success: true, data: { notFound: [], setup: listSetup([listed('L1', 'not_found')]) } } });
    await expect(auctioneerService.markProposalItemsNotFound('list-work', ['L1'])).resolves.toMatchObject({ notFound: [], remainsInAssetInsight: null });
  });

  it('accepts an idempotent item alongside newly confirmed not-found items', async () => {
    jest.mocked(api.post).mockResolvedValue({ data: { success: true, data: {
      notFound: ['L2'], setup: listSetup([listed('L1', 'not_found'), listed('L2', 'not_found')]),
    } } });
    await expect(auctioneerService.markProposalItemsNotFound('list-work', ['L1', 'L2']))
      .resolves.toMatchObject({ notFound: ['L2'], remainsInAssetInsight: null });
  });

  it.each([
    { notFound: [], items: [listed('L1')], requested: ['L1'] },
    { notFound: ['OTHER'], items: [listed('L1')], requested: ['L1'] },
    { notFound: ['L1', 'L1'], items: [listed('L1', 'not_found')], requested: ['L1'] },
    { notFound: ['L1'], items: [listed('L1', 'not_found'), listed('L2')], requested: ['L1', 'L2'] },
  ])('rejects a receipt that does not confirm precisely the requested items %#', async ({ notFound, items, requested }) => {
    jest.mocked(api.post).mockResolvedValue({ data: { success: true, data: { notFound, setup: listSetup(items) } } });
    await expect(auctioneerService.markProposalItemsNotFound('list-work', requested))
      .rejects.toThrow('Auctioneer did not confirm the not-found items.');
  });

  it('rejects an answer without a matching Proposal list even when its receipt names the item', async () => {
    jest.mocked(api.post).mockResolvedValue({ data: { success: true, data: {
      notFound: ['L1'], setup: { ...fixture(), workItemId: 'list-work' },
    } } });
    await expect(auctioneerService.markProposalItemsNotFound('list-work', ['L1']))
      .rejects.toThrow('Auctioneer did not confirm the not-found items.');
  });

  it('rejects a late not-found receipt from an earlier sign-in session', async () => {
    let resolve!: (value: any) => void;
    jest.mocked(api.post).mockReturnValue(new Promise(done => { resolve = done; }));
    const pending = auctioneerService.markProposalItemsNotFound('list-work', ['L1']);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'ERR_CANCELED' });
    invalidateAuthOperations();
    resolve({ data: { success: true, data: { notFound: ['L1'], setup: listSetup([listed('L1', 'not_found')]) } } });
    await rejected;
  });

  it.each([
    [[]],
    [['L1', 'L1']],
    [['L1', '  ']],
    [Array.from({ length: 501 }, (_, index) => `L${index}`)],
  ])('refuses %p before contacting the server', async (lineIds) => {
    await expect(auctioneerService.markProposalItemsNotFound('list-work', lineIds as string[])).rejects.toThrow('Choose the listed items');
    expect(api.post).not.toHaveBeenCalled();
  });

  it.each([
    [{ success: false, data: {} }],
    [{ success: true, data: { notFound: 'L1', setup: {} } }],
    [{ success: true, data: { notFound: ['L1'], remainsInAssetInsight: 'yes', setup: {} } }],
    [{ success: true, data: { notFound: ['L1'], setup: { ...fixture(), workItemId: 'someone-else' } } }],
  ])('does not report success for an unconfirmed answer %#', async (body) => {
    jest.mocked(api.post).mockResolvedValue({ data: body });
    await expect(auctioneerService.markProposalItemsNotFound('list-work', ['L1'])).rejects.toThrow();
  });

  it('passes a server refusal through unchanged for the form to show', async () => {
    const refusal = { response: { status: 409, data: { code: 'auctioneer_proposal_item_not_outstanding', message: 'This item was already returned.' } } };
    jest.mocked(api.post).mockRejectedValue(refusal);
    await expect(auctioneerService.markProposalItemsNotFound('list-work', ['L1'])).rejects.toBe(refusal);
  });
});

/*
 * Owner, 2026-10-31: "US sales come through as USD" and the valuation must be
 * done in the right currency. The sale's currency arrives with the contract;
 * only a three-letter code is taken.
 */
it.each([['USD', 'USD'], ['usd', 'USD'], ['US dollars', undefined], [undefined, undefined]])('reads the sale currency %j as %j', (currency, expected) => {
  const parsed = parseAuctioneerSetup({ ...fixture(), contract: { ...fixture().contract, currency } });
  expect(parsed.contract.currency).toBe(expected);
});

/*
 * Arrival photo requests (owner, 2026-11-03): "Its just file copy only". The
 * phone reads this user's open requests and sends one request's photos; the
 * server watermarks them and copies them to the lot's Office Only section.
 */
describe('arrival photo requests', () => {
  const row = {
    requestId: 'request-1',
    lotId: 'lot-1',
    lotNumber: '3012',
    description: '2014 John Deere 8360R',
    requestedBy: 'Office',
    officeOnlyPhotoCount: 2,
  };

  it('reads the open requests and leaves out rows without a request or lot', async () => {
    jest.mocked(api.get).mockResolvedValue({ data: { success: true, data: [row, { lotId: 'lot-2' }, { requestId: 'r3' }] } });
    const rows = await auctioneerService.getArrivalPhotoRequests();
    expect(api.get).toHaveBeenCalledWith('/auctioneer/arrival-photo-requests');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ requestId: 'request-1', lotNumber: '3012', officeOnlyPhotoCount: 2, serialNumber: null });
  });

  it('says so when the list cannot be read', async () => {
    jest.mocked(api.get).mockResolvedValue({ data: { success: true, data: 'nope' } });
    await expect(auctioneerService.getArrivalPhotoRequests()).rejects.toThrow('arrival photo requests could not be read');
  });

  it('sends every photo in one multipart request to that request only', async () => {
    jest.mocked(api.post).mockResolvedValue({ data: { success: true, data: { sent: 2, stored: 2, skipped: 0, photoCount: 2 } } });
    const result = await auctioneerService.sendArrivalPhotos('request-1', [
      { uri: 'file:///photos/front.jpg' },
      { uri: 'file:///photos/plate.jpg', name: 'plate.jpg', type: 'image/jpeg' },
    ]);
    expect(result).toEqual({ sent: 2, stored: 2, skipped: 0, photoCount: 2 });
    const [url, body] = jest.mocked(api.post).mock.calls[0];
    expect(url).toBe('/auctioneer/arrival-photo-requests/request-1/photos');
    expect((body as FormData).getAll('photos')).toHaveLength(2);
  });

  it('refuses to send without a request or without photos', async () => {
    await expect(auctioneerService.sendArrivalPhotos('', [{ uri: 'file:///a.jpg' }])).rejects.toThrow('Choose the arrival photo request');
    await expect(auctioneerService.sendArrivalPhotos('request-1', [])).rejects.toThrow('Take or add the arrival photos');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('does not report success without the server confirming', async () => {
    jest.mocked(api.post).mockResolvedValue({ data: { success: false } });
    await expect(auctioneerService.sendArrivalPhotos('request-1', [{ uri: 'file:///a.jpg' }])).rejects.toThrow('did not confirm');
  });
});


describe('arrival delivery confirmation safety', () => {
  it.each([{}, { sent: 1, stored: 0, skipped: 0, photoCount: 0 },
    { sent: 2, stored: 2, skipped: 0, photoCount: 2 },
    { sent: 1, stored: 1, skipped: 0, photoCount: 0 },
    { sent: 1, stored: -1, skipped: 2, photoCount: 1 },
    { sent: 1, stored: 0.5, skipped: 0.5, photoCount: 1 },
  ])('refuses incomplete or invalid receipts: %j', async data => {
    jest.mocked(api.post).mockResolvedValue({ data: { success: true, data } });
    await expect(auctioneerService.sendArrivalPhotos('request', [{ uri: 'file:///original.jpg' }])).rejects.toThrow('did not confirm');
  });
  it('accepts a fully accounted duplicate receipt', async () => {
    jest.mocked(api.post).mockResolvedValue({ data: { success: true, data: { sent: 2, stored: 0, skipped: 2, photoCount: 1 } } });
    await expect(auctioneerService.sendArrivalPhotos('request', [{ uri: 'file:///a.jpg' }, { uri: 'file:///same.jpg' }])).resolves.toMatchObject({ sent: 2, skipped: 2 });
    expect(jest.mocked(api.post).mock.calls[0][2]).toMatchObject({ skipAuthRefreshReplay: true });
  });
  it('ignores progress and receipt after a sign-in session changes', async () => {
    let resolve!: (value: any) => void;
    jest.mocked(api.post).mockReturnValue(new Promise(done => { resolve = done; }));
    const progress = jest.fn();
    const sent = auctioneerService.sendArrivalPhotos('request', [{ uri: 'file:///a.jpg' }], progress);
    const settled = sent.catch(error => error);
    const options = jest.mocked(api.post).mock.calls[0][2] as any;
    options.onUploadProgress({ loaded: 10, total: 10 });
    expect(progress).toHaveBeenLastCalledWith(95);
    invalidateAuthOperations();
    options.onUploadProgress({ loaded: 10, total: 10 });
    expect(progress).toHaveBeenCalledTimes(1);
    resolve({ data: { success: true, data: { sent: 1, stored: 1, skipped: 0, photoCount: 1 } } });
    expect(await settled).toMatchObject({ code: 'ERR_CANCELED' });
  });
});


describe('Completed arrival history boundary', () => {
  const completed = {requestId:'completed-one',lotId:'lot-one',receivedAt:'2026-11-04T20:00:00Z',photoCount:4,description:'Tractor'};
  it('accepts a confirmed empty list and correctly typed completed rows', async () => {
    jest.mocked(api.get).mockResolvedValueOnce({data:{success:true,data:[]}}).mockResolvedValueOnce({data:{success:true,data:[completed]}});
    await expect(auctioneerService.getCompletedArrivalPhotoRequests()).resolves.toEqual([]);
    await expect(auctioneerService.getCompletedArrivalPhotoRequests()).resolves.toEqual([expect.objectContaining(completed)]);
  });
  it.each([null,7,{}, {...completed,photoCount:-1}, {...completed,photoCount:1.5}, {...completed,photoCount:'4'}, {...completed,photoCount:Infinity}, {...completed,description:{unexpected:true}}])('rejects a malformed row without filtering it into empty history: %j', async (row) => {
    jest.mocked(api.get).mockResolvedValue({data:{success:true,data:[row]}});
    await expect(auctioneerService.getCompletedArrivalPhotoRequests()).rejects.toThrow('could not be read');
  });
  it('rejects an explicit unsuccessful response even with an empty data array', async () => {
    jest.mocked(api.get).mockResolvedValue({data:{success:false,data:[]}});
    await expect(auctioneerService.getCompletedArrivalPhotoRequests()).rejects.toThrow('could not be read');
  });
});
