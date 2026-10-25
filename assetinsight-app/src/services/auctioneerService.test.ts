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
