import api from './api';
import service, {
  auctioneerDeliveryErrorMessage,
  deliveryMatchesReport,
  parseAuctioneerDelivery,
  type AuctioneerDeliverySummary,
} from './auctioneerDeliveryService';
import { invalidateAuthOperations } from './authSessionOperation';

jest.mock('./api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));

const fixture = (overrides: Partial<AuctioneerDeliverySummary> = {}): AuctioneerDeliverySummary => ({
  workItemId: 'work/1', reportId: 'report-1', reportModel: 'AssetReport', reportType: 'asset',
  contractId: 'contract-1', contractNo: '94677', accessRevision: 42,
  state: 'ready', canSend: true, canCompleteContract: true, contractCompletionScope: 'user',
  ...overrides,
});
const envelope = (data: unknown) => ({ data: { success: true, data } });
const deferred = () => {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
beforeEach(() => jest.clearAllMocks());

it('loads owner-scoped deliveries without inventing client ownership or platform queries', async () => {
  jest.mocked(api.get).mockResolvedValue(envelope([fixture(), fixture({ workItemId: 'lot-work', reportId: 'lot-report', reportModel: 'LotListing', reportType: 'lotListing' })]));
  const result = await service.getDeliveries();
  expect(api.get).toHaveBeenCalledWith('/auctioneer/deliveries');
  expect(result).toHaveLength(2);
  expect(result[0]).toMatchObject({ reportId: 'report-1', accessRevision: 42 });
});

it.each([
  { success: false, data: [] },
  { data: [] },
  { success: true, data: {} },
  { success: true, data: [fixture(), fixture()] },
  { success: true, data: [{ ...fixture(), canSend: 'true' }] },
])('rejects incomplete, negative or duplicate list responses %#', async (data) => {
  jest.mocked(api.get).mockResolvedValue({ data });
  await expect(service.getDeliveries()).rejects.toThrow('could not be verified');
});

it('matches only exact report identity and matching family, not contract number or legacy aliases', () => {
  expect(deliveryMatchesReport(fixture(), 'report-1', 'AssetReport')).toBe(true);
  expect(deliveryMatchesReport(fixture(), 'other-report', 'AssetReport')).toBe(false);
  expect(deliveryMatchesReport(fixture(), 'report-1', 'LotListing')).toBe(false);
  expect(deliveryMatchesReport(fixture({ reportType: 'lotListing' }), 'report-1', 'AssetReport')).toBe(false);
});

it.each([
  { reportModel: null }, { reportType: 'lotListing' }, { state: 'completed' },
  { workItemId: '' }, { reportId: { _id: 'report-1' } }, { contractId: '' },
  { accessRevision: -1 }, { accessRevision: 1.5 }, { accessRevision: true },
  { canSend: undefined }, { destination: 'PublicAuction' },
  { contractTaskCompleted: 'false' }, { contractCompletionScope: 'everybody' },
  { sentAt: 'not-a-date' }, { error: {} },
])('does not accept a malformed delivery or inferred identity %#', (override) => {
  expect(() => parseAuctioneerDelivery({ ...fixture(), ...override })).toThrow('could not be verified');
});

it('keeps numeric zero revision and optional legacy nulls without copying provider extras', () => {
  const result = parseAuctioneerDelivery({
    ...fixture({ accessRevision: 0 }), destination: null, reportStatus: null, releaseStatus: null,
    sentAt: null, contractClosedAt: null, contractTaskCompleted: null,
    reconciliation: { reason: 'https://internal.example/private' }, secret: 'not-public',
  });
  expect(result.accessRevision).toBe(0);
  expect(result).not.toHaveProperty('secret');
  expect(result).not.toHaveProperty('reconciliation');
  expect(result).not.toHaveProperty('sentAt');
});

it('gets a fresh status through the encoded protected path and validates its immutable context', async () => {
  jest.mocked(api.get).mockResolvedValue(envelope(fixture({ state: 'sent', canSend: false })));
  await expect(service.getDelivery('work/1', fixture())).resolves.toMatchObject({ state: 'sent' });
  expect(api.get).toHaveBeenCalledWith('/auctioneer/deliveries/work%2F1');
});

it.each([
  { workItemId: 'other-work' }, { reportId: 'other-report' }, { contractId: 'other-contract' },
  { reportModel: 'LotListing', reportType: 'lotListing' }, { accessRevision: 43 }, { accessRevision: '42' },
])('rejects status responses for a different work, report, contract or epoch %#', async (override) => {
  jest.mocked(api.get).mockResolvedValue(envelope({ ...fixture(), ...override }));
  await expect(service.getDelivery('work/1', fixture())).rejects.toThrow('could not be verified');
});

it.each(['queued', 'sending', 'sent'] as const)('acknowledges the verified %s state without claiming earlier remote success', async (state) => {
  jest.mocked(api.post).mockResolvedValue(envelope(fixture({ state, canSend: false })));
  await expect(service.sendDelivery(fixture(), { destination: 'LottingBoard' })).resolves.toMatchObject({ state });
  expect(api.post).toHaveBeenCalledWith('/auctioneer/deliveries/work%2F1/send', {
    destination: 'LottingBoard', completeContract: false,
  }, { skipAuthRefreshReplay: true });
  expect(api.post).toHaveBeenCalledTimes(1);
});

it('sends the operations note and close choice explicitly without client actor fields', async () => {
  jest.mocked(api.post).mockResolvedValue(envelope(fixture({ state: 'queued', canSend: false })));
  await service.sendDelivery(fixture(), { destination: 'OpToDoBoard', opTaskDescription: '  Inspect the tractor  ', completeContract: true });
  expect(api.post).toHaveBeenCalledWith('/auctioneer/deliveries/work%2F1/send', {
    destination: 'OpToDoBoard', opTaskDescription: 'Inspect the tractor', completeContract: true,
  }, { skipAuthRefreshReplay: true });
});

it.each([
  [{ destination: 'OpToDoBoard', opTaskDescription: '  ' }, 'Add an Operations'],
  [{ destination: 'OpToDoBoard', opTaskDescription: 'x'.repeat(2001) }, '2,000'],
  [{ destination: 'other' }, 'Choose the Posting'],
  [{ destination: 'LottingBoard', completeContract: 'true' }, 'Choose whether'],
])('validates outbound choices before making a mutation %#', async (input, message) => {
  await expect(service.sendDelivery(fixture(), input as never)).rejects.toThrow(message);
  expect(api.post).not.toHaveBeenCalled();
});

it.each(['not_ready', 'queued', 'sending', 'needs_reconciliation', 'sent'] as const)('does not send while state is %s', async (state) => {
  await expect(service.sendDelivery(fixture({ state }), { destination: 'LottingBoard' })).rejects.toThrow('not ready');
  expect(api.post).not.toHaveBeenCalled();
});

it('honors fresh canSend and canCompleteContract decisions', async () => {
  await expect(service.sendDelivery(fixture({ canSend: false }), { destination: 'LottingBoard' })).rejects.toThrow('not ready');
  await expect(service.sendDelivery(fixture({ canCompleteContract: false }), { destination: 'LottingBoard', completeContract: true })).rejects.toThrow('cannot close');
  expect(api.post).not.toHaveBeenCalled();
});

it('requires an explicit capability before asking to close a contract', async () => {
  await expect(service.sendDelivery(fixture({ canCompleteContract: undefined }), {
    destination: 'LottingBoard', completeContract: true,
  })).rejects.toThrow('cannot close');
  expect(api.post).not.toHaveBeenCalled();
});

it.each([
  { destination: undefined, completeContract: false },
  { destination: 'LottingBoard', completeContract: undefined },
])('never invents missing original settings for a failed retry %#', async (override) => {
  await expect(service.sendDelivery(fixture({ state: 'failed', ...override } as never), {
    destination: 'LottingBoard', completeContract: false,
  })).rejects.toThrow('original delivery settings could not be verified');
  expect(api.post).not.toHaveBeenCalled();
});

it('retries the original saved settings and delivery identity rather than creating another delivery', async () => {
  const prior = fixture({ state: 'failed', destination: 'OpToDoBoard', opTaskDescription: 'Review engine', completeContract: true });
  jest.mocked(api.post).mockResolvedValue(envelope({ ...prior, state: 'queued', canSend: false }));
  await service.sendDelivery(prior, { destination: 'OpToDoBoard', opTaskDescription: 'Review engine', completeContract: true });
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledWith('/auctioneer/deliveries/work%2F1/send', {
    destination: 'OpToDoBoard', opTaskDescription: 'Review engine', completeContract: true,
  }, { skipAuthRefreshReplay: true });
});

it.each([
  { destination: 'LottingBoard', completeContract: true },
  { destination: 'OpToDoBoard', opTaskDescription: 'Different note', completeContract: true },
  { destination: 'OpToDoBoard', opTaskDescription: 'Review engine', completeContract: false },
])('refuses changed failed-delivery settings before sending %#', async (input) => {
  const prior = fixture({ state: 'failed', destination: 'OpToDoBoard', opTaskDescription: 'Review engine', completeContract: true });
  await expect(service.sendDelivery(prior, input as never)).rejects.toThrow('original delivery');
  expect(api.post).not.toHaveBeenCalled();
});

it.each([
  { reportId: 'other-report' }, { workItemId: 'other-work' }, { accessRevision: 43 },
  { accessRevision: undefined }, { state: 'ready' }, { state: 'failed' },
])('does not accept a false or mismatched send receipt %#', async (override) => {
  jest.mocked(api.post).mockResolvedValue(envelope({ ...fixture({ state: 'queued', canSend: false }), ...override }));
  await expect(service.sendDelivery(fixture(), { destination: 'LottingBoard' })).rejects.toThrow('could not be verified');
  expect(api.post).toHaveBeenCalledTimes(1);
});

it.each([
  [{ externalLotId: '  upstream-lot  ' }, { externalLotId: 'upstream-lot' }],
  [{ confirmNotCreated: true }, { confirmNotCreated: true }],
])('reconciles only the same work receipt and leaves an explicit retry rather than auto sending %#', async (input, body) => {
  const prior = fixture({ state: 'needs_reconciliation', canSend: false });
  jest.mocked(api.post).mockResolvedValue(envelope(fixture({ state: 'failed' })));
  await expect(service.reconcileDelivery(prior, input as never)).resolves.toMatchObject({ state: 'failed' });
  expect(api.post).toHaveBeenCalledWith('/auctioneer/deliveries/work%2F1/reconcile', body, { skipAuthRefreshReplay: true });
  expect(api.post).toHaveBeenCalledTimes(1);
});

it.each([{}, { externalLotId: 'lot', confirmNotCreated: true }, { externalLotId: '  ' }, { confirmNotCreated: false }])('refuses ambiguous reconciliation choice %#', async (input) => {
  await expect(service.reconcileDelivery(fixture({ state: 'needs_reconciliation' }), input as never)).rejects.toThrow('choose only one');
  expect(api.post).not.toHaveBeenCalled();
});

it('never automatically replays a failed or lost send response', async () => {
  jest.mocked(api.post).mockRejectedValue(new Error('Network Error'));
  await expect(service.sendDelivery(fixture(), { destination: 'LottingBoard' })).rejects.toThrow('Sending was not confirmed');
  expect(api.post).toHaveBeenCalledTimes(1);
});

it.each(['list', 'status', 'send', 'reconcile'] as const)('rejects late %s results after account change', async (action) => {
  const pending = deferred();
  jest.mocked(api.get).mockReturnValue(pending.promise as never);
  jest.mocked(api.post).mockReturnValue(pending.promise as never);
  const request = action === 'list' ? service.getDeliveries() :
    action === 'status' ? service.getDelivery('work/1', fixture()) :
    action === 'send' ? service.sendDelivery(fixture(), { destination: 'LottingBoard' }) :
    service.reconcileDelivery(fixture({ state: 'needs_reconciliation' }), { confirmNotCreated: true });
  const outcome = request.catch((error) => error);
  invalidateAuthOperations();
  pending.resolve(envelope(action === 'list' ? [fixture()] : fixture({ state: action === 'reconcile' ? 'failed' : 'queued', canSend: false })));
  await expect(outcome).resolves.toMatchObject({ code: 'ERR_CANCELED' });
});

it('suppresses a late failure from a previous account as well as a success', async () => {
  const pending = deferred();
  jest.mocked(api.post).mockReturnValue(pending.promise as never);
  const outcome = service.sendDelivery(fixture(), { destination: 'LottingBoard' }).catch((error) => error);
  invalidateAuthOperations();
  pending.reject({ response: { status: 409, data: { message: 'Old private contract failure' } } });
  await expect(outcome).resolves.toMatchObject({ code: 'ERR_CANCELED' });
});

it.each([
  'Request failed with status code 409', 'Network Error', 'fetch failed',
  'Cannot reach http://127.0.0.1:3331/private', '<html>Provider error</html>',
  'TypeError: credentials is not a function',
])('sanitizes transport/provider diagnostics in stored and immediate errors: %s', (message) => {
  expect(auctioneerDeliveryErrorMessage({ message }, 'Safe recovery guidance')).toBe('Safe recovery guidance');
  expect(parseAuctioneerDelivery(fixture({ error: message })).error).toContain('needs attention');
});

it('preserves the real safe business refusal instead of exposing an HTTP code', async () => {
  const message = 'The Asset Listing must be approved, released, and have all required files before sending.';
  jest.mocked(api.post).mockRejectedValue({ response: { status: 409, data: { code: 'delivery_not_ready', message } }, message: 'Request failed with status code 409' });
  await expect(service.sendDelivery(fixture(), { destination: 'LottingBoard' })).rejects.toThrow(message);
});

it('does not copy arbitrary transport messages even when they look like a short business message', async () => {
  jest.mocked(api.post).mockRejectedValue(new Error('ERR_NETWORK'));
  const error = await service.sendDelivery(fixture(), { destination: 'LottingBoard' }).catch((failure) => failure);
  expect(error.message).toContain('Sending was not confirmed');
  expect(auctioneerDeliveryErrorMessage(error)).toContain('Sending was not confirmed');
  expect(auctioneerDeliveryErrorMessage(new Error('Private transport diagnostics'), 'Safe fallback')).toBe('Safe fallback');
});

it('preserves safe stored backend guidance while suppressing private diagnostics', () => {
  expect(parseAuctioneerDelivery(fixture({ error: 'The delivery must be reconciled before retrying.' })).error).toBe('The delivery must be reconciled before retrying.');
});
