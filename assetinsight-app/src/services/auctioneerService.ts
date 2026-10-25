import api from './api';
import type { UploadContinuationReservation } from './durableContinuationTypes';
import { captureAuthOperation } from './authSessionOperation';

export type AuctioneerReportType = 'asset' | 'lotListing';
export type AuctioneerWorkItemStatus =
  | 'available'
  | 'claimed'
  | 'report_created'
  | 'sent'
  | 'abandoned';

export interface AuctioneerIncomingItem {
  cycleKey: string;
  workItemId?: string;
  contractId: string;
  contractNo: string;
  customerName: string;
  consignorName?: string;
  salespersonName?: string;
  description?: string;
  eventId?: string;
  eventTitle: string;
  eventDate?: string;
  location: string;
  kind: 'scheduleA' | 'unknown';
  lotCount: number;
  status: AuctioneerWorkItemStatus;
  claimedByMe?: boolean;
  selectedReportType?: AuctioneerReportType;
  reopenUntil?: string | null;
  eventTime?: string | null;
  eventClosed?: boolean;
  accessRevision?: string | number;
}

export interface AuctioneerCapturePermission {
  reopen: { allowed: boolean; reason: string | null; reopenUntil: string | null };
  accessRevision?: string | number;
  eventTime?: string | null;
  eventClosed?: boolean;
  confirmationPending?: boolean;
}

export interface AuctioneerReopenReceipt {
  contractId: string;
  reopened: boolean;
  alreadyOpen: boolean;
  accessRevision: string | number;
}

export interface AuctioneerSourceLot {
  sourceKey: string;
  lotId?: string;
  submissionId?: string;
  lotNumber?: string;
  title?: string;
  description?: string;
  categories?: string;
}

export interface AuctioneerWorkItemSetup {
  workItemId: string;
  cycleKey: string;
  kind: 'scheduleA' | 'unknown';
  reportType: AuctioneerReportType;
  clientSubmissionId?: string;
  status?: AuctioneerWorkItemStatus;
  reportId?: string | null;
  canResumeUpload?: boolean;
  contract: {
    id: string;
    contractNo: string;
    customerName: string;
    consignorName?: string;
    salespersonName?: string;
    description?: string;
    eventId?: string;
    eventTitle: string;
    eventDate?: string;
    location: string;
    categories?: string;
  };
  lots: AuctioneerSourceLot[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown): value is string => typeof value === 'string';
const id = (value: unknown): value is string => text(value) && value.trim().length > 0;
const accessRevision = (value: unknown): value is string | number =>
  (id(value) && value.length <= 200) ||
  (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);

// Rendered Completed cards load lazily; cap provider checks during fast scrolling.
let activePermissionReads = 0;
const permissionWaiters: (() => void)[] = [];
async function withPermissionSlot<T>(read: () => Promise<T>): Promise<T> {
  if (activePermissionReads >= 4) await new Promise<void>((resolve) => permissionWaiters.push(resolve));
  else activePermissionReads += 1;
  try {
    return await read();
  } finally {
    const next = permissionWaiters.shift();
    if (next) next();
    else activePermissionReads -= 1;
  }
}

export function parseAuctioneerSetup(value: unknown): AuctioneerWorkItemSetup {
  if (
    !record(value) ||
    !id(value.workItemId) ||
    !id(value.cycleKey) ||
    !['scheduleA', 'unknown'].includes(String(value.kind)) ||
    !['asset', 'lotListing'].includes(String(value.reportType)) ||
    !record(value.contract) ||
    !id(value.contract.id) ||
    !id(value.contract.contractNo) ||
    ![
      'customerName',
      'consignorName',
      'salespersonName',
      'description',
      'eventTitle',
      'location',
      'eventId',
      'eventDate',
      'categories',
    ].every(
      (key) =>
        (value.contract as Record<string, unknown>)[key] == null ||
        text((value.contract as Record<string, unknown>)[key])
    ) ||
    !Array.isArray(value.lots) ||
    !value.lots.every((lot) => record(lot) && id(lot.sourceKey)) ||
    (value.clientSubmissionId != null && !id(value.clientSubmissionId)) ||
    (value.reportId != null && !id(value.reportId)) ||
    (value.canResumeUpload != null && typeof value.canResumeUpload !== 'boolean') ||
    (value.status != null &&
      !['available', 'claimed', 'report_created', 'sent', 'abandoned'].includes(
        String(value.status)
      ))
  ) {
    throw new Error('The Auctioneer work-item setup is incomplete. Reload Incoming and try again.');
  }
  return {
    ...value,
    contract: {
      ...value.contract,
      customerName: value.contract.customerName || '',
      eventTitle: value.contract.eventTitle || '',
      location: value.contract.location || '',
    },
  } as unknown as AuctioneerWorkItemSetup;
}

export function isEditableAuctioneerSetup(
  setup: AuctioneerWorkItemSetup,
  type: AuctioneerReportType
): boolean {
  return (
    setup.reportType === type &&
    setup.status === 'claimed' &&
    !setup.reportId &&
    Boolean(setup.clientSubmissionId) &&
    (setup.kind !== 'scheduleA' || setup.lots.length > 0)
  );
}

export function validateAuctioneerSuccessor(
  previous: AuctioneerWorkItemSetup,
  next: AuctioneerWorkItemSetup
): void {
  if (
    !isEditableAuctioneerSetup(next, previous.reportType) ||
    next.workItemId === previous.workItemId ||
    next.clientSubmissionId === previous.clientSubmissionId ||
    next.contract.id !== previous.contract.id ||
    next.contract.contractNo !== previous.contract.contractNo ||
    (Boolean(previous.contract.eventId) && next.contract.eventId !== previous.contract.eventId) ||
    next.kind !== 'unknown' ||
    next.lots.length !== 0
  ) {
    throw new Error(
      'The next work item is not a fresh lot. Reload Incoming to check its status; no replacement lot was opened.'
    );
  }
}

class AuctioneerService {
  async getStatus(): Promise<{
    configured: boolean;
    enabled: boolean;
    reachable?: boolean;
    message?: string;
  }> {
    const response = await api.get('/auctioneer/status');
    const value = response.data?.data;
    if (
      !record(value) ||
      typeof value.configured !== 'boolean' ||
      typeof value.enabled !== 'boolean'
    ) {
      throw new Error('Auctioneer connection status is unavailable.');
    }
    return value as {
      configured: boolean;
      enabled: boolean;
      reachable?: boolean;
      message?: string;
    };
  }

  async getIncoming(forceRefresh = false): Promise<AuctioneerIncomingItem[]> {
    const response = await api.get(
      '/auctioneer/incoming',
      forceRefresh ? { params: { refresh: true } } : undefined
    );
    const value = response.data?.data;
    const rows = Array.isArray(value) ? value : value?.items;
    if (
      !Array.isArray(rows) ||
      !rows.every(
        (row) =>
          record(row) &&
          id(row.cycleKey) &&
          id(row.contractNo) &&
          ['available', 'claimed', 'report_created', 'sent', 'abandoned'].includes(
            String(row.status)
          ) &&
          [
            'customerName',
            'consignorName',
            'salespersonName',
            'description',
            'eventTitle',
            'location',
          ].every((key) => row[key] == null || text(row[key]))
          && (row.reopenUntil == null || text(row.reopenUntil))
          && (row.eventTime == null || text(row.eventTime))
          && (row.eventClosed == null || typeof row.eventClosed === 'boolean')
          && (row.accessRevision == null || accessRevision(row.accessRevision))
      )
    ) {
      throw new Error('The Auctioneer incoming list is incomplete. Try refreshing it.');
    }
    return rows.map((row) => ({
      ...row,
      customerName: row.customerName || '',
      eventTitle: row.eventTitle || '',
      location: row.location || '',
    })) as AuctioneerIncomingItem[];
  }

  async getCapturePermission(contractId: string): Promise<AuctioneerCapturePermission> {
    if (!id(contractId)) throw new Error('Refresh Incoming to check this contract.');
    const assertCurrent = captureAuthOperation();
    return withPermissionSlot(async () => {
      assertCurrent();
      const response = await api.get(
        `/auctioneer/contracts/${encodeURIComponent(contractId)}/capture-permission`
      );
      const value = response.data?.data;
      if (
        response.data?.success !== true || !record(value) || !record(value.reopen) ||
        typeof value.reopen.allowed !== 'boolean' ||
        !(value.reopen.reason === null || text(value.reopen.reason)) ||
        !(value.reopen.reopenUntil === null || text(value.reopen.reopenUntil)) ||
        (value.accessRevision != null && !accessRevision(value.accessRevision)) ||
        (value.eventTime != null && !text(value.eventTime)) ||
        (value.eventClosed != null && typeof value.eventClosed !== 'boolean') ||
        (value.confirmationPending != null && typeof value.confirmationPending !== 'boolean')
      ) throw new Error('Re-Open availability could not be verified. Refresh Incoming and try again.');
      return value as unknown as AuctioneerCapturePermission;
    });
  }

  async reopenContract(contractId: string): Promise<AuctioneerReopenReceipt> {
    if (!id(contractId)) throw new Error('Refresh Incoming to check this contract.');
    const response = await api.post(
      `/auctioneer/contracts/${encodeURIComponent(contractId)}/reopen`,
      {},
      { skipAuthRefreshReplay: true }
    );
    const value = response.data?.data;
    if (
      response.data?.success !== true || !record(value) || value.contractId !== contractId ||
      !accessRevision(value.accessRevision) ||
      !((value.reopened === true && (value.alreadyOpen === false || value.alreadyOpen == null)) ||
        (value.alreadyOpen === true && (value.reopened === false || value.reopened == null)))
    ) throw new Error('Re-Open was not confirmed. Refresh Incoming to check this contract before trying again.');
    return {
      contractId,
      reopened: value.reopened === true,
      alreadyOpen: value.alreadyOpen === true,
      accessRevision: value.accessRevision,
    };
  }

  async claim(
    cycleKey: string,
    reportType: AuctioneerReportType
  ): Promise<AuctioneerWorkItemSetup> {
    const response = await api.post(`/auctioneer/incoming/${encodeURIComponent(cycleKey)}/claim`, {
      reportType,
    });
    const value = response.data?.data;
    if (!record(value) || !id(value.workItemId))
      throw new Error(
        'The Auctioneer claim did not return a work item. Refresh Incoming before retrying.'
      );
    return this.getSetup(value.workItemId);
  }

  async getSetup(workItemId: string): Promise<AuctioneerWorkItemSetup> {
    const response = await api.get(
      `/auctioneer/work-items/${encodeURIComponent(workItemId)}/setup`
    );
    return parseAuctioneerSetup(response.data?.data);
  }

  async continueWorkItem(workItemId: string, reportId: string): Promise<AuctioneerWorkItemSetup> {
    if (!id(workItemId) || !id(reportId))
      throw new Error('A server-accepted report is required before starting a new lot.');
    const response = await api.post(
      `/auctioneer/work-items/${encodeURIComponent(workItemId)}/continue`,
      { reportId }
    );
    return parseAuctioneerSetup(response.data?.data);
  }

  async continueUpload(
    workItemId: string,
    sessionId: string
  ): Promise<{ reservation: UploadContinuationReservation; setup: AuctioneerWorkItemSetup }> {
    const response = await api.post(
      `/auctioneer/work-items/${encodeURIComponent(workItemId)}/continue-upload`,
      { sessionId },
      { timeout: 30_000 }
    );
    const data = response.data?.data;
    if (
      !record(data) ||
      !record(data.reservation) ||
      data.reservation.status !== 'reserved' ||
      ![
        'id',
        'ownerId',
        'parentWorkItemId',
        'parentSessionId',
        'parentClientSubmissionId',
        'parentCaptureId',
        'successorWorkItemId',
      ].every((key) => id((data.reservation as Record<string, unknown>)[key]))
    ) {
      throw new Error(
        'The next-lot reservation could not be verified. Retry this same Continue request from Drafts.'
      );
    }
    return {
      reservation: data.reservation as UploadContinuationReservation,
      setup: parseAuctioneerSetup(data.setup),
    };
  }
}

export default new AuctioneerService();
