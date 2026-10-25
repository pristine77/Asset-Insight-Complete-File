import api from './api';
import { captureAuthOperation } from './authSessionOperation';

export type AuctioneerDeliveryState =
  | 'not_ready'
  | 'ready'
  | 'queued'
  | 'sending'
  | 'failed'
  | 'needs_reconciliation'
  | 'sent';
export type AuctioneerDeliveryDestination = 'LottingBoard' | 'OpToDoBoard';
export type AuctioneerDeliveryReportModel = 'AssetReport' | 'LotListing';

export interface AuctioneerDeliverySummary {
  workItemId: string;
  reportId: string;
  reportModel: AuctioneerDeliveryReportModel;
  reportType: 'asset' | 'lotListing';
  contractId: string;
  contractNo?: string;
  accessRevision?: string | number;
  state: AuctioneerDeliveryState;
  canSend: boolean;
  filesReady?: boolean;
  reportStatus?: string;
  releaseStatus?: string;
  destination?: AuctioneerDeliveryDestination;
  opTaskDescription?: string;
  canCompleteContract?: boolean;
  contractCompletionScope?: 'user' | 'contract';
  completeContract?: boolean;
  contractClosedAt?: string;
  contractTaskCompleted?: boolean;
  contractCloseUserStatus?: 'completed' | 'revoked';
  sentAt?: string;
  updatedAt?: string;
  error?: string;
}

export interface AuctioneerSendDeliveryInput {
  destination: AuctioneerDeliveryDestination;
  opTaskDescription?: string;
  completeContract?: boolean;
}

export type AuctioneerReconcileDeliveryInput =
  | { externalLotId: string; confirmNotCreated?: never }
  | { confirmNotCreated: true; externalLotId?: never };

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const id = (value: unknown): value is string =>
  typeof value === 'string' && Boolean(value.trim()) && value.length <= 200;
const revision = (value: unknown): value is string | number =>
  id(value) || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
const optionalString = (value: unknown): value is string | null | undefined =>
  value == null || typeof value === 'string';
const optionalBoolean = (value: unknown): value is boolean | null | undefined =>
  value == null || typeof value === 'boolean';
const states: AuctioneerDeliveryState[] = [
  'not_ready', 'ready', 'queued', 'sending', 'failed', 'needs_reconciliation', 'sent',
];
const destination = (value: unknown): value is AuctioneerDeliveryDestination =>
  value === 'LottingBoard' || value === 'OpToDoBoard';
class AuctioneerDeliveryError extends Error {}
const deliveryError = (message: string) => new AuctioneerDeliveryError(message);
const invalidResponse = () => deliveryError(
  'The Auctioneer delivery status could not be verified. Refresh Reports before trying again.'
);

/** Provider addresses and Axios diagnostics are not useful recovery instructions. */
export function auctioneerDeliveryErrorMessage(
  error: unknown,
  fallback = 'The Auctioneer delivery could not be confirmed. Refresh Reports before trying again.'
): string {
  const raw = record(error) ? error : {};
  const response = record(raw.response) ? raw.response : {};
  const body = record(response.data) ? response.data : {};
  const nested = record(body.error) ? body.error : {};
  const candidate = body.message ?? nested.message ??
    (error instanceof AuctioneerDeliveryError ? error.message : undefined);
  if (
    typeof candidate === 'string' && candidate.trim() && candidate.length <= 1000 &&
    !/https?:\/\/|localhost|127\.\d+\.\d+\.\d+|\[::1\]|status code|fetch failed|network error|timeout|ECONN|ENOTFOUND|<!doctype|<html|stack trace|is not a function|TypeError|SyntaxError/i.test(candidate)
  ) return candidate.trim();
  if (response.status === 401) return 'Your session has expired. Sign in again before sending this report.';
  if (response.status === 403) return 'Your account no longer has access to send this report. Refresh Reports or contact your administrator.';
  if (response.status === 404) return 'This Auctioneer delivery is no longer available. Refresh Reports to check its current status.';
  if (response.status === 409) return 'This delivery or contract has changed. Refresh Reports before continuing; your report and photos are unchanged.';
  if ([502, 503, 504].includes(Number(response.status))) return 'The server could not connect to Auctioneer. Refresh the delivery status before retrying; your report and photos are unchanged.';
  return fallback;
}

export function parseAuctioneerDelivery(value: unknown): AuctioneerDeliverySummary {
  if (
    !record(value) || !id(value.workItemId) || !id(value.reportId) ||
    !id(value.contractId) ||
    !((value.reportModel === 'AssetReport' && value.reportType === 'asset') ||
      (value.reportModel === 'LotListing' && value.reportType === 'lotListing')) ||
    !states.includes(value.state as AuctioneerDeliveryState) ||
    typeof value.canSend !== 'boolean' ||
    (value.accessRevision != null && !revision(value.accessRevision)) ||
    (value.destination != null && !destination(value.destination)) ||
    !['contractNo', 'opTaskDescription', 'reportStatus', 'releaseStatus', 'error'].every(
      (key) => optionalString(value[key])
    ) ||
    !['canCompleteContract', 'completeContract', 'contractTaskCompleted', 'filesReady'].every(
      (key) => optionalBoolean(value[key])
    ) ||
    (value.contractCompletionScope != null && !['user', 'contract'].includes(String(value.contractCompletionScope))) ||
    (value.contractCloseUserStatus != null && !['completed', 'revoked'].includes(String(value.contractCloseUserStatus))) ||
    !['sentAt', 'updatedAt', 'contractClosedAt'].every((key) =>
      value[key] == null || (typeof value[key] === 'string' && Number.isFinite(Date.parse(value[key] as string))))
  ) throw invalidResponse();

  // Never carry arbitrary provider fields or nested reconciliation evidence into the UI.
  const result: AuctioneerDeliverySummary = {
    workItemId: value.workItemId,
    reportId: value.reportId,
    reportModel: value.reportModel,
    reportType: value.reportType,
    contractId: value.contractId,
    state: value.state as AuctioneerDeliveryState,
    canSend: value.canSend,
  };
  const stringKeys = [
    'contractNo', 'opTaskDescription', 'reportStatus', 'releaseStatus', 'contractClosedAt',
    'sentAt', 'updatedAt',
  ] as const;
  for (const key of stringKeys) if (typeof value[key] === 'string') result[key] = value[key];
  for (const key of ['canCompleteContract', 'completeContract', 'contractTaskCompleted', 'filesReady'] as const) {
    if (typeof value[key] === 'boolean') result[key] = value[key];
  }
  if (value.accessRevision != null) result.accessRevision = value.accessRevision as string | number;
  if (destination(value.destination)) result.destination = value.destination;
  if (value.contractCompletionScope === 'user' || value.contractCompletionScope === 'contract') result.contractCompletionScope = value.contractCompletionScope;
  if (value.contractCloseUserStatus === 'completed' || value.contractCloseUserStatus === 'revoked') result.contractCloseUserStatus = value.contractCloseUserStatus;
  if (typeof value.error === 'string' && value.error.trim()) result.error = auctioneerDeliveryErrorMessage(
    { response: { data: { message: value.error } } },
    'Auctioneer delivery needs attention. Refresh its status before retrying.'
  );
  return result;
}

export function deliveryMatchesReport(
  delivery: AuctioneerDeliverySummary,
  reportId: string,
  model: AuctioneerDeliveryReportModel
): boolean {
  return delivery.reportId === reportId && delivery.reportModel === model &&
    delivery.reportType === (model === 'AssetReport' ? 'asset' : 'lotListing');
}

export function sameDeliveryIdentity(expected: AuctioneerDeliverySummary, actual: AuctioneerDeliverySummary): boolean {
  return expected.workItemId === actual.workItemId &&
    deliveryMatchesReport(actual, expected.reportId, expected.reportModel) &&
    expected.contractId === actual.contractId && expected.accessRevision === actual.accessRevision;
}

function readEnvelope(response: { data?: unknown }): unknown {
  if (!record(response.data) || response.data.success !== true) throw invalidResponse();
  return response.data.data;
}

async function scoped<T>(action: () => Promise<T>, fallback: string): Promise<T> {
  const assertCurrent = captureAuthOperation();
  try {
    assertCurrent();
    const result = await action();
    assertCurrent();
    return result;
  } catch (error) {
    assertCurrent();
    throw deliveryError(auctioneerDeliveryErrorMessage(error, fallback));
  }
}

class AuctioneerDeliveryService {
  getDeliveries(): Promise<AuctioneerDeliverySummary[]> {
    return scoped(async () => {
      const value = readEnvelope(await api.get('/auctioneer/deliveries'));
      if (!Array.isArray(value)) throw invalidResponse();
      const rows = value.map(parseAuctioneerDelivery);
      if (new Set(rows.map((row) => row.workItemId)).size !== rows.length) throw invalidResponse();
      return rows;
    }, 'Auctioneer deliveries could not be loaded. Retry from Reports.');
  }

  getDelivery(workItemId: string, expected?: AuctioneerDeliverySummary): Promise<AuctioneerDeliverySummary> {
    return scoped(async () => {
      if (!id(workItemId) || (expected && expected.workItemId !== workItemId)) throw invalidResponse();
      const result = parseAuctioneerDelivery(readEnvelope(await api.get(
        `/auctioneer/deliveries/${encodeURIComponent(workItemId)}`
      )));
      if (result.workItemId !== workItemId || (expected && !sameDeliveryIdentity(expected, result))) throw invalidResponse();
      return result;
    }, 'The Auctioneer delivery status could not be loaded. Refresh Reports before sending.');
  }

  sendDelivery(delivery: AuctioneerDeliverySummary, input: AuctioneerSendDeliveryInput): Promise<AuctioneerDeliverySummary> {
    return scoped(async () => {
      const expected = parseAuctioneerDelivery(delivery);
      if (!expected.canSend || !['ready', 'failed'].includes(expected.state)) throw deliveryError('This report is not ready to send. Refresh Reports to check its current status.');
      if (!destination(input.destination)) throw deliveryError('Choose the Posting Board or Operations To-Do destination.');
      if (input.opTaskDescription != null && typeof input.opTaskDescription !== 'string') throw deliveryError('Enter a valid Operations To-Do note.');
      const note = input.opTaskDescription?.trim() || '';
      if (input.destination === 'OpToDoBoard' && !note) throw deliveryError('Add an Operations To-Do note before sending.');
      if (note.length > 2000) throw deliveryError('The Operations To-Do note cannot exceed 2,000 characters.');
      if (input.completeContract != null && typeof input.completeContract !== 'boolean') throw deliveryError('Choose whether to close your part of the contract.');
      if (input.completeContract === true && expected.canCompleteContract !== true) throw deliveryError('Your account cannot close this contract. Send without closing it.');
      const body: AuctioneerSendDeliveryInput = {
        destination: input.destination,
        ...(input.destination === 'OpToDoBoard' ? { opTaskDescription: note } : {}),
        completeContract: input.completeContract === true,
      };
      if (expected.state === 'failed') {
        if (!expected.destination || typeof expected.completeContract !== 'boolean') throw deliveryError('The original delivery settings could not be verified. Refresh Reports before retrying.');
        if (body.destination !== expected.destination ||
          (body.opTaskDescription || '') !== (expected.opTaskDescription || '') ||
          body.completeContract !== expected.completeContract
        ) throw deliveryError('Retry must use the original delivery destination, note and close choice.');
      }
      const result = parseAuctioneerDelivery(readEnvelope(await api.post(
        `/auctioneer/deliveries/${encodeURIComponent(expected.workItemId)}/send`,
        body,
        { skipAuthRefreshReplay: true }
      )));
      if (!sameDeliveryIdentity(expected, result) || !['queued', 'sending', 'sent'].includes(result.state)) throw invalidResponse();
      return result;
    }, 'Sending was not confirmed. Refresh the delivery status before retrying; do not create another report.');
  }

  reconcileDelivery(delivery: AuctioneerDeliverySummary, input: AuctioneerReconcileDeliveryInput): Promise<AuctioneerDeliverySummary> {
    return scoped(async () => {
      const expected = parseAuctioneerDelivery(delivery);
      if (expected.state !== 'needs_reconciliation') throw deliveryError('Refresh Reports to check whether this delivery still needs reconciliation.');
      const externalLotId = 'externalLotId' in input && typeof input.externalLotId === 'string' ? input.externalLotId.trim() : '';
      const confirmNotCreated = input.confirmNotCreated === true;
      if (Boolean(externalLotId) === confirmNotCreated || ('externalLotId' in input && !id(externalLotId))) throw deliveryError('Enter the existing Auctioneer lot ID or confirm no lot was created; choose only one option.');
      const result = parseAuctioneerDelivery(readEnvelope(await api.post(
        `/auctioneer/deliveries/${encodeURIComponent(expected.workItemId)}/reconcile`,
        externalLotId ? { externalLotId } : { confirmNotCreated: true },
        { skipAuthRefreshReplay: true }
      )));
      if (!sameDeliveryIdentity(expected, result) || result.state !== 'failed') throw invalidResponse();
      return result;
    }, 'Reconciliation was not confirmed. Refresh the delivery status before trying again.');
  }
}

export default new AuctioneerDeliveryService();
