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
  /**
   * owner 2026-10-28: a Proposal worked from its uploaded Schedule A list.
   * lotCount is then this user's outstanding listed items. Only ever true.
   */
  proposalList?: boolean;
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
  /**
   * owner 2026-10-28: the Schedule A item this source lot comes from, and
   * whether that item is ticked "Several lots" in Auctioneer 2.0.
   * parseAuctioneerSetup always sets severalLots (false on older servers); the
   * line and title are present only when the server knows them.
   */
  severalLots?: boolean;
  scheduleALineId?: string;
  scheduleAItemTitle?: string;
}

/**
 * A Schedule A item ticked "Several lots" that already has its Auctioneer lot
 * (owner 2026-10-28). parentLotId is what a lot sends as
 * schedule_a_parent_lot_id to say which item it belongs to.
 */
export interface AuctioneerScheduleAChoice {
  lineId: string;
  title: string;
  parentLotId: string;
}

/**
 * Where one listed Proposal item stands for this user (owner 2026-10-28):
 *   outstanding      still to be captured: the form offers it;
 *   in_other_report  one of this user's other reports, not yet sent, has it;
 *   returned         Auctioneer already holds a return for it (green);
 *   not_found        this user returned it as not found (red).
 */
export type AuctioneerProposalItemState = 'outstanding' | 'in_other_report' | 'returned' | 'not_found';

/**
 * One item of a Proposal's Schedule A list pushed to this user. A report lot
 * that captures it sends sourceKey as its source_key; a lot without one is an
 * item that was not on the list (blue).
 */
export interface AuctioneerProposalItem {
  lineId: string;
  sourceKey: string;
  title: string;
  lotNumber?: string;
  serialNumber?: string;
  year?: string;
  make?: string;
  model?: string;
  description?: string;
  state: AuctioneerProposalItemState;
}

export interface AuctioneerProposalList {
  items: AuctioneerProposalItem[];
}

/** What returning listed items as not found sent back (owner 2026-10-28). */
export interface AuctioneerProposalNotFoundResult {
  /** The items this request returned; an item already not found is not repeated. */
  notFound: string[];
  /** Whether the Proposal still waits in Asset Insight for other listed items; null when unknown. */
  remainsInAssetInsight: boolean | null;
  setup: AuctioneerWorkItemSetup;
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
  /**
   * owner 2026-10-28: true when this is a lot without its own Schedule A line
   * (kind "unknown") on a contract that has a Schedule A. Its lots are not sent
   * until the appraiser chooses one of scheduleAChoices (Schedule A order; the
   * server refreshes the list on every setup read). parseAuctioneerSetup always
   * sets both; they are optional because a draft saved by an older app keeps an
   * offline snapshot without them.
   */
  requiresScheduleAItem?: boolean;
  scheduleAChoices?: AuctioneerScheduleAChoice[];
  /**
   * owner 2026-10-28: present only for a Proposal worked from its uploaded
   * Schedule A list (kind "unknown", no lots of its own). The form seeds one
   * lot per outstanding item and may add items that were not listed. Absent on
   * every other work item, which then behaves exactly as before.
   */
  proposalList?: AuctioneerProposalList;
}

const record =(value: unknown): value is Record<string, unknown> =>
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
  // The raw list never passes through unchecked: either the normalized one or none.
  const { proposalList: rawProposalList, ...fields } = value;
  const proposalList = parseProposalList(rawProposalList);
  return {
    ...fields,
    contract: {
      ...value.contract,
      customerName: value.contract.customerName || '',
      eventTitle: value.contract.eventTitle || '',
      location: value.contract.location || '',
    },
    lots: (value.lots as Record<string, unknown>[]).map(parseSourceLotScheduleA),
    // Older servers send neither field: nothing is required and nothing is offered.
    requiresScheduleAItem: value.requiresScheduleAItem === true,
    scheduleAChoices: parseScheduleAChoices(value.scheduleAChoices),
    ...(proposalList ? { proposalList } : {}),
  } as unknown as AuctioneerWorkItemSetup;
}

const PROPOSAL_ITEM_STATES: readonly AuctioneerProposalItemState[] = [
  'outstanding', 'in_other_report', 'returned', 'not_found',
];
const PROPOSAL_ITEM_TEXT_FIELDS = [
  'lotNumber', 'serialNumber', 'year', 'make', 'model', 'description',
] as const;

/**
 * A Proposal's listed items for this user (owner 2026-10-28), or undefined
 * when the setup has no list (every other work item). An item without its line
 * or source key cannot be captured or returned, so it is left out; a repeated
 * line keeps its first entry. An unknown state is read as "returned": the item
 * is then shown but never offered for capture or Not found.
 */
function parseProposalList(value: unknown): AuctioneerProposalList | undefined {
  if (!record(value)) return undefined;
  const seenLines = new Set<string>();
  const seenKeys = new Set<string>();
  const items = (Array.isArray(value.items) ? value.items : []).flatMap((item): AuctioneerProposalItem[] => {
    if (!record(item) || !id(item.lineId) || !id(item.sourceKey)) return [];
    const lineId = item.lineId.trim();
    const sourceKey = item.sourceKey.trim();
    if (seenLines.has(lineId) || seenKeys.has(sourceKey)) return [];
    seenLines.add(lineId);
    seenKeys.add(sourceKey);
    const optional: Partial<AuctioneerProposalItem> = {};
    for (const key of PROPOSAL_ITEM_TEXT_FIELDS) {
      if (id(item[key])) optional[key] = (item[key] as string).trim();
    }
    return [{
      lineId,
      sourceKey,
      title: id(item.title) ? item.title.trim() : 'Proposal item',
      ...optional,
      state: PROPOSAL_ITEM_STATES.includes(item.state as AuctioneerProposalItemState)
        ? (item.state as AuctioneerProposalItemState)
        : 'returned',
    }];
  });
  return { items };
}

// owner 2026-10-28: optional Schedule A fields of a source lot. A malformed
// line or title is left out rather than failing the whole setup.
function parseSourceLotScheduleA(lot: Record<string, unknown>): Record<string, unknown> {
  const { scheduleALineId, scheduleAItemTitle, ...rest } = lot;
  return {
    ...rest,
    severalLots: lot.severalLots === true,
    ...(id(scheduleALineId) ? { scheduleALineId } : {}),
    ...(id(scheduleAItemTitle) ? { scheduleAItemTitle: scheduleAItemTitle.trim() } : {}),
  };
}

/**
 * Keeps only complete choices (owner 2026-10-28): an entry without a line,
 * title or parent lot cannot be shown or sent. A second entry with the same
 * parent lot would send the same value, so the first one is kept.
 */
function parseScheduleAChoices(value: unknown): AuctioneerScheduleAChoice[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((choice) => {
    if (!record(choice) || !id(choice.lineId) || !id(choice.title) || !id(choice.parentLotId)) return [];
    if (seen.has(choice.parentLotId)) return [];
    seen.add(choice.parentLotId);
    return [{ lineId: choice.lineId, title: choice.title.trim(), parentLotId: choice.parentLotId }];
  });
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
    return rows.map(({ proposalList, ...row }) => ({
      ...row,
      customerName: row.customerName || '',
      eventTitle: row.eventTitle || '',
      location: row.location || '',
      // owner 2026-10-28: only a real true marks a Proposal list row.
      ...(proposalList === true ? { proposalList: true } : {}),
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

  /**
   * Returns listed Proposal items to Auctioneer as not found (owner
   * 2026-10-28): the red outcome, for an item the user could not find. The
   * server returns them at once, with no report, and answers with the
   * refreshed setup. Needs a connection; it is never queued.
   */
  async markProposalItemsNotFound(
    workItemId: string,
    lineIds: string[]
  ): Promise<AuctioneerProposalNotFoundResult> {
    const requested = Array.isArray(lineIds) ? lineIds.map((lineId) => (text(lineId) ? lineId.trim() : '')) : [];
    if (
      !id(workItemId) ||
      !requested.length ||
      requested.length > 500 ||
      requested.some((lineId) => !lineId) ||
      new Set(requested).size !== requested.length
    ) {
      throw new Error('Choose the listed items to return as not found.');
    }
    const response = await api.post(
      `/auctioneer/work-items/${encodeURIComponent(workItemId)}/proposal-items/not-found`,
      { lineIds: requested }
    );
    const data = response.data?.data;
    if (
      response.data?.success !== true ||
      !record(data) ||
      !Array.isArray(data.notFound) ||
      !data.notFound.every(id) ||
      !(data.remainsInAssetInsight === null || data.remainsInAssetInsight === undefined ||
        typeof data.remainsInAssetInsight === 'boolean')
    ) {
      throw new Error('Auctioneer did not confirm the not-found items. Reopen the Proposal from Incoming to check them.');
    }
    const setup = parseAuctioneerSetup(data.setup);
    if (setup.workItemId !== workItemId) {
      throw new Error('This Incoming assignment changed. Close this form and reopen it from Incoming.');
    }
    return {
      notFound: data.notFound as string[],
      remainsInAssetInsight: typeof data.remainsInAssetInsight === 'boolean' ? data.remainsInAssetInsight : null,
      setup,
    };
  }
}

export default new AuctioneerService();
