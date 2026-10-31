import API, { type RetriableAxiosConfig } from "@/lib/api";

export type AuctioneerReportType = "asset" | "lotListing";
export type AuctioneerIncomingKind = "scheduleA" | "unknown";
export type AuctioneerIncomingStatus =
  | "available"
  | "claimed"
  | "report_created"
  | "sent"
  | "abandoned";

export type AuctioneerPersonRef = {
  _id?: string;
  id?: string;
  name?: string;
  username?: string;
  email?: string;
};

export type AuctioneerContractReopenMetadata = {
  reopenUntil?: string | null;
  eventTime?: string;
  eventClosed?: boolean;
  accessRevision?: string | number;
};

export type AuctioneerCapturePermission = AuctioneerContractReopenMetadata & {
  reopen: { allowed: boolean; reason: string | null; reopenUntil: string | null };
  confirmationPending?: boolean;
};

export type AuctioneerContractReopen = {
  contractId: string;
  reopened: boolean;
  alreadyOpen: boolean;
  accessRevision: string | number;
};

export type AuctioneerIncomingItem = AuctioneerContractReopenMetadata & {
  cycleKey: string;
  workItemId?: string;
  contractId: string;
  contractNo: string;
  customerName: string;
  consignorName?: string;
  salespersonName?: string;
  /** What the office wrote on the contract, e.g. "Farm equipment". */
  description?: string;
  eventId?: string;
  eventTitle: string;
  eventDate?: string;
  location: string;
  kind: AuctioneerIncomingKind;
  lotCount: number;
  status: AuctioneerIncomingStatus;
  claimedBy?: AuctioneerPersonRef | string | null;
  claimedByMe?: boolean;
  selectedReportType?: AuctioneerReportType;
  /** A Proposal worked from its list (owner 2026-10-28); lotCount is the user's items to capture. */
  proposalList?: boolean;
};

export type AuctioneerSourceLot = {
  sourceKey: string;
  lotId?: string;
  submissionId?: string;
  lotNumber?: string;
  title?: string;
  description?: string;
  details?: string;
  categories?: string;
  serialNumber?: string;
  make?: string;
  model?: string;
  year?: string;
  conditionReport?: string;
  services?: string[];
  sourcePhotoCount?: number;
  /**
   * The office ticked "Several lots" on this Schedule A item in Auctioneer 2.0:
   * it comes back as more than one lot, so the appraiser may split it here.
   * Auctioneer refuses extra lots split off an item that is not ticked (owner
   * 2026-10-28). normalizeSetup always sets it; false when the server omits it.
   */
  severalLots?: boolean;
  /** The Schedule A line this lot was made from, when Auctioneer names it. */
  scheduleALineId?: string;
  /** That Schedule A line's item title, e.g. "2021 Ford F150". */
  scheduleAItemTitle?: string;
};

/**
 * A Schedule A item the lots of a successor ("unknown") work item can be sent
 * against: one the office ticked "Several lots" that already has an Auctioneer
 * lot. parentLotId is that lot, and is what a submission sends back.
 */
export type AuctioneerScheduleAChoice = {
  lineId: string;
  title: string;
  parentLotId: string;
};

export type AuctioneerWorkItemSetup = {
  workItemId: string;
  cycleKey: string;
  kind: AuctioneerIncomingKind;
  reportType: AuctioneerReportType;
  clientSubmissionId?: string;
  status?: AuctioneerIncomingStatus;
  reportId?: string;
  canResumeUpload?: boolean;
  contract: AuctioneerContractReopenMetadata & {
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
    /** The sale's currency from Auctioneer 2.0, e.g. "USD" (owner, 2026-10-31: "US sales come through as USD"). */
    currency?: string;
    categories?: string;
  };
  lots: AuctioneerSourceLot[];
  /*
     Owner 2026-10-28: lots made on a Schedule A contract beyond the lines it
     lists ("Create Lot & Continue", a Re-Open) arrive on an "unknown" work item
     with no lines, and used to reach Auctioneer orphaned. When this is true the
     appraiser must choose which Schedule A item the form's lots belong to, from
     scheduleAChoices (server order, refreshed on every setup request), before
     anything is sent.

     normalizeSetup always sets both. They stay optional because a setup can
     also reach a form from a report-form handoff written before this change;
     readers treat a missing value as false / no choices.
  */
  requiresScheduleAItem?: boolean;
  scheduleAChoices?: AuctioneerScheduleAChoice[];
  /**
   * Present only on a Proposal worked from its list (owner 2026-10-28): the
   * items the office pushed to this user, each with the source key a lot
   * carries to capture it. The form starts with one lot per "outstanding"
   * item; lots without a listed key go back as items that were not listed.
   */
  proposalList?: { items: AuctioneerProposalItem[] };
};

/** Where one of the user's listed Proposal items stands. */
export type AuctioneerProposalItemState =
  | "outstanding"
  | "in_other_report"
  | "returned"
  | "not_found";

export type AuctioneerProposalItem = {
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
};

export type AuctioneerDeliveryState =
  | "not_ready"
  | "ready"
  | "queued"
  | "sending"
  | "failed"
  | "needs_reconciliation"
  | "sent";

export type AuctioneerDeliverySummary = {
  workItemId: string;
  reportId?: string;
  reportModel?: "AssetReport" | "LotListing";
  reportType?: AuctioneerReportType;
  /** The Auctioneer contract this delivery belongs to. */
  contractId?: string;
  contractNo?: string;
  /** Access epoch saved with this delivery; never inferred from another report. */
  accessRevision?: string | number;
  state: AuctioneerDeliveryState;
  canSend?: boolean;
  canCompleteContract?: boolean;
  /**
   * What closing means for this delivery. "user": the work is assigned to the
   * signed-in user, and closing closes THEIR part — the contract completes
   * once every assigned person has closed theirs. "contract": older unassigned
   * work, where closing completes the contract task itself. Absent from older
   * servers.
   */
  contractCompletionScope?: "user" | "contract";
  destination?: "LottingBoard" | "OpToDoBoard";
  opTaskDescription?: string;
  completeContract?: boolean;
  /** When Auctioneer confirmed the close (the user's part, or the contract). */
  contractClosedAt?: string;
  /** Whether the whole contract was complete when that close was confirmed. */
  contractTaskCompleted?: boolean;
  contractCloseUserStatus?: "completed" | "revoked";
  error?: string;
  sentAt?: string;
  updatedAt?: string;
};

/** Auctioneer's answer when the signed-in user closed their part of a contract. */
export type AuctioneerContractPartClose = {
  contractId: string;
  contractNo?: string;
  closedAt: string;
  /** Every assigned person has now closed theirs: the contract is complete. */
  taskCompleted: boolean;
  /** The contract had already completed before this close. */
  alreadyCompleted: boolean;
  /**
   * The user's assignment as Auctioneer reports it: "completed" for a closed
   * part, "revoked" when they had been taken off the contract (nothing of
   * theirs to close), null when Auctioneer named no status.
   */
  userStatus: string | null;
};

export type AuctioneerSendDeliveryInput = {
  destination: "LottingBoard" | "OpToDoBoard";
  opTaskDescription?: string;
  completeContract?: boolean;
};

export type AuctioneerReconcileDeliveryInput =
  | { externalLotId: string }
  | { confirmNotCreated: true };

type UnknownRecord = Record<string, any>;

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? (value as UnknownRecord) : {};
}

function unwrap(value: unknown): unknown {
  const record = asRecord(value);
  return record.data ?? value;
}

function textValue(...values: unknown[]) {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return "";
}

// Contact roles are explicit API metadata, never inferred from the customer,
// claimant or appraiser. Older servers may omit them entirely.
function contactName(...values: unknown[]): string | undefined {
  return values.find((value): value is string =>
    typeof value === "string" && Boolean(value.trim())
  )?.trim();
}

function contractDescription(...values: unknown[]): string | undefined {
  return values.find((value): value is string =>
    typeof value === "string" && Boolean(value.trim())
  )?.trim();
}

function accessRevision(value: unknown): string | number | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  return undefined;
}

function reopenMetadata(raw: UnknownRecord, contract: UnknownRecord): AuctioneerContractReopenMetadata {
  const until = raw.reopenUntil ?? contract.reopenUntil;
  const eventTime = raw.eventTime ?? contract.eventTime;
  const eventClosed = raw.eventClosed ?? contract.eventClosed;
  return {
    reopenUntil: typeof until === "string" && Number.isFinite(Date.parse(until)) ? until : undefined,
    eventTime: typeof eventTime === "string" && eventTime.trim() ? eventTime : undefined,
    eventClosed: typeof eventClosed === "boolean" ? eventClosed : undefined,
    accessRevision: accessRevision(raw.accessRevision ?? contract.accessRevision),
  };
}

const REOPEN_REFUSALS: Record<string, string> = {
  LOTS_CLOSING_STARTED: "This event's lots have started closing, so this contract can no longer be re-opened.",
  EVENT_CLOSED: "This event is closed or cancelled, so this contract cannot be re-opened.",
  PROPOSAL_REVIEWED: "This proposal has already been reviewed. Contact your office before adding more lots.",
  REVOKED: "Your assignment to this contract has been revoked. Contact your office to check access.",
  NO_GRANT: "You are not currently assigned to this contract. Contact your office to check access.",
  AMBIGUOUS_REOPEN_USER: "Auctioneer could not identify your contract assignment. Ask your office to check your user assignment.",
};

/** Only known business reasons reach this lifecycle action; transport details stay private. */
export function auctioneerReopenErrorMessage(error: unknown): string {
  const raw = asRecord(error);
  const response = asRecord(raw.response);
  const data = asRecord(response.data);
  const nested = asRecord(data.data);
  const code = data.code ?? nested.code ?? raw.code;
  if (typeof code === "string" && Object.hasOwn(REOPEN_REFUSALS, code)) return REOPEN_REFUSALS[code];
  if (response.status === 401) return "Your sign-in needs refreshing. Sign in again, then check this contract before re-opening it.";
  if (response.status === 403) return "You no longer have permission to re-open this contract. Contact your office to check access.";
  return "Re-opening was not confirmed. Refresh Incoming to check this contract before trying again. Your existing reports are unchanged.";
}

function normalizeKind(value: unknown, record: UnknownRecord): AuctioneerIncomingKind {
  const kind = textValue(value).toLowerCase();
  if (kind.includes("unknown")) return "unknown";
  if (record.hasUnknownLots && !record.hasScheduleA) return "unknown";
  return "scheduleA";
}

function normalizeReportType(value: unknown): AuctioneerReportType | undefined {
  const normalized = textValue(value).replace(/[-_\s]/g, "").toLowerCase();
  if (normalized === "asset" || normalized === "assetreport") return "asset";
  if (normalized === "lotlisting" || normalized === "lot") return "lotListing";
  return undefined;
}

function normalizeStatus(value: unknown): AuctioneerIncomingStatus {
  const normalized = textValue(value).replace(/[-\s]/g, "_").toLowerCase();
  if (normalized === "sent") return "sent";
  if (normalized === "report_created" || normalized === "reportcreated") {
    return "report_created";
  }
  if (normalized === "abandoned") return "abandoned";
  if (normalized === "claimed" || normalized === "in_progress") return "claimed";
  return "available";
}

function normalizeIncomingItem(value: unknown): AuctioneerIncomingItem {
  const item = asRecord(value);
  const contract = asRecord(item.contract ?? item.contractSnapshot);
  const event = asRecord(item.event ?? contract.event);
  const customer = asRecord(item.customer ?? contract.customer);
  const workItem = asRecord(item.workItem);
  const claim = asRecord(item.claim);
  const claimedBy =
    item.claimedBy ??
    workItem.claimedBy ??
    item.claimed_by ??
    claim.user ??
    claim.owner;
  const contractId = textValue(
    item.contractId,
    item.contract_id,
    contract.id,
    contract._id
  );
  const cycleKey = textValue(item.cycleKey, item.cycle_key, workItem.cycleKey);
  const lots = Array.isArray(item.lots) ? item.lots : [];
  const tasks = Array.isArray(item.tasks) ? item.tasks : [];

  return {
    ...reopenMetadata(item, contract),
    cycleKey: cycleKey || contractId,
    workItemId: textValue(
      item.workItemId,
      item.work_item_id,
      workItem.id,
      workItem._id,
      item._id
    ) || undefined,
    contractId,
    contractNo: textValue(
      item.contractNo,
      item.contract_no,
      contract.contractNo,
      contract.contract_no,
      contract.number
    ),
    customerName: textValue(
      item.customerName,
      item.customer_name,
      contract.customerName,
      contract.customer_name,
      customer.name,
      customer.companyName,
      customer.company_name
    ),
    consignorName: contactName(
      item.consignorName, item.consignor_name,
      contract.consignorName, contract.consignor_name
    ),
    salespersonName: contactName(
      item.salespersonName, item.salesperson_name,
      contract.salespersonName, contract.salesperson_name
    ),
    description: contractDescription(item.description, contract.description),
    eventId:
      textValue(item.eventId, item.event_id, contract.eventId, event.id, event._id) ||
      undefined,
    eventTitle: textValue(
      item.eventTitle,
      item.event_title,
      contract.eventTitle,
      event.title,
      event.name
    ),
    eventDate:
      textValue(
        item.eventDate,
        item.event_date,
        item.closeDate,
        contract.eventDate,
        contract.closeDate,
        event.date,
        event.closeDate
      ) || undefined,
    location: textValue(
      item.location,
      item.saleLocation,
      contract.location,
      contract.saleLocation,
      event.location
    ),
    kind: normalizeKind(item.kind ?? item.sourceKind, {
      ...contract,
      ...item,
    }),
    lotCount:
      Number(item.lotCount ?? item.lot_count ?? (lots.length || tasks.length)) ||
      0,
    status: normalizeStatus(item.status ?? item.state ?? workItem.status),
    claimedBy: claimedBy || null,
    claimedByMe: Boolean(item.claimedByMe ?? item.claimed_by_me),
    selectedReportType: normalizeReportType(
      item.selectedReportType ??
        item.selected_report_type ??
        item.reportType ??
        item.report_type ??
        workItem.reportType
    ),
    ...(item.proposalList === true ? { proposalList: true } : {}),
  };
}

function normalizeLot(value: unknown, index: number): AuctioneerSourceLot {
  const task = asRecord(value);
  const lot = asRecord(task.lot ?? task.asset ?? value);
  const submission = asRecord(task.submission);
  const lotId = textValue(lot.id, lot._id, lot.lotId, task.lotId);
  const submissionId = textValue(
    submission.id,
    submission._id,
    task.submissionId,
    task.submissionGuid
  );
  const lotNumber = textValue(lot.lotNumber, lot.lot_number, lot.number);
  return {
    sourceKey:
      textValue(task.sourceKey, task.source_key, lot.sourceKey) ||
      `${lotId || "unknown"}:${submissionId || index}`,
    lotId: lotId || undefined,
    submissionId: submissionId || undefined,
    lotNumber: lotNumber || undefined,
    title: textValue(lot.title, lot.name, lot.asset_name) || undefined,
    description: textValue(lot.description, task.description) || undefined,
    details: textValue(lot.details, lot.specifications, task.details) || undefined,
    categories:
      textValue(lot.categories, lot.category, task.categories) || undefined,
    serialNumber:
      textValue(lot.serialNumber, lot.serial_number, lot.serialNo) || undefined,
    make: textValue(lot.make, lot.manufacturer) || undefined,
    model: textValue(lot.model) || undefined,
    year: textValue(lot.year) || undefined,
    conditionReport:
      textValue(
        lot.conditionReport,
        lot.condition_report,
        task.conditionReport
      ) || undefined,
    services: (Array.isArray(lot.services) ? lot.services : [])
      .map((service) =>
        typeof service === "string"
          ? service.trim()
          : textValue(
              asRecord(service).name,
              asRecord(service).title,
              asRecord(service).serviceName,
              asRecord(service).code
            )
      )
      .filter(Boolean),
    sourcePhotoCount:
      Number(lot.sourcePhotoCount ?? lot.source_photo_count) || undefined,
    // Only an explicit true unlocks splitting; older servers omit the flag.
    severalLots: (task.severalLots ?? lot.severalLots) === true,
    ...optionalText("scheduleALineId", task.scheduleALineId ?? lot.scheduleALineId),
    ...optionalText("scheduleAItemTitle", task.scheduleAItemTitle ?? lot.scheduleAItemTitle),
  };
}

/** A trimmed, non-blank string under `key`, or nothing at all. */
function optionalText<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
  return typeof value === "string" && value.trim()
    ? ({ [key]: value.trim() } as Record<K, string>)
    : {};
}

/*
   Choices are offered to the appraiser and one is sent back as
   schedule_a_parent_lot_id, so an entry missing any of its three strings is
   dropped rather than guessed at. A repeated parentLotId would be two options
   with the same value, so only its first entry is kept. Server order is kept.
*/
function normalizeScheduleAChoices(value: unknown): AuctioneerScheduleAChoice[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const choices: AuctioneerScheduleAChoice[] = [];
  for (const entry of value) {
    const choice = asRecord(entry);
    const { lineId, title, parentLotId } = {
      ...optionalText("lineId", choice.lineId),
      ...optionalText("title", choice.title),
      ...optionalText("parentLotId", choice.parentLotId),
    };
    if (!lineId || !title || !parentLotId || seen.has(parentLotId)) continue;
    seen.add(parentLotId);
    choices.push({ lineId, title, parentLotId });
  }
  return choices;
}

const PROPOSAL_ITEM_STATES = new Set<AuctioneerProposalItemState>([
  "outstanding", "in_other_report", "returned", "not_found",
]);

/**
 * The listed items, checked rather than trusted: an item without its line or
 * key cannot be captured or returned and is dropped, a repeat is dropped, and
 * a state this client does not know is read as "returned" — never offered for
 * capture, because capturing it could replace a return made elsewhere.
 */
function normalizeProposalList(value: unknown): AuctioneerWorkItemSetup["proposalList"] {
  const raw = asRecord(value);
  if (!Array.isArray(raw.items)) return undefined;
  const seen = new Set<string>();
  const items: AuctioneerProposalItem[] = [];
  for (const entry of raw.items) {
    const item = asRecord(entry);
    const lineId = textValue(item.lineId);
    const sourceKey = textValue(item.sourceKey);
    if (!lineId || !sourceKey || seen.has(lineId)) continue;
    seen.add(lineId);
    const state = textValue(item.state) as AuctioneerProposalItemState;
    items.push({
      lineId,
      sourceKey,
      title: textValue(item.title) || "Proposal item",
      ...optionalText("lotNumber", typeof item.lotNumber === "number" ? String(item.lotNumber) : item.lotNumber),
      ...optionalText("serialNumber", item.serialNumber),
      ...optionalText("year", typeof item.year === "number" ? String(item.year) : item.year),
      ...optionalText("make", item.make),
      ...optionalText("model", item.model),
      ...optionalText("description", item.description),
      state: PROPOSAL_ITEM_STATES.has(state) ? state : "returned",
    });
  }
  return { items };
}

function normalizeSetup(value: unknown): AuctioneerWorkItemSetup {
  const envelope = asRecord(unwrap(value));
  const raw = asRecord(
    envelope.setup ??
      envelope.workItem ??
      envelope.work_item ??
      envelope
  );
  const snapshot = asRecord(raw.snapshot ?? raw.sourceSnapshot);
  const contract = asRecord(raw.contract ?? snapshot.contract);
  const event = asRecord(raw.event ?? contract.event ?? snapshot.event);
  const customer = asRecord(raw.customer ?? contract.customer ?? snapshot.customer);
  const lotValues =
    (Array.isArray(raw.lots) && raw.lots) ||
    (Array.isArray(raw.tasks) && raw.tasks) ||
    (Array.isArray(snapshot.lots) && snapshot.lots) ||
    (Array.isArray(snapshot.tasks) && snapshot.tasks) ||
    [];

  const workItemId = textValue(raw.workItemId, raw.work_item_id, raw.id, raw._id);
  const status = textValue(raw.status, raw.state);
  return {
    workItemId,
    cycleKey: textValue(raw.cycleKey, raw.cycle_key),
    kind: normalizeKind(raw.kind ?? raw.sourceKind ?? raw.source_kind ?? snapshot.kind, {
      ...contract,
      ...snapshot,
    }),
    reportType:
      normalizeReportType(
        raw.reportType ??
          raw.report_type ??
          raw.selectedReportType ??
          raw.selected_report_type
      ) || "asset",
    clientSubmissionId:
      textValue(raw.clientSubmissionId, raw.client_submission_id) || undefined,
    status: status ? normalizeStatus(status) : undefined,
    reportId: textValue(raw.reportId, raw.report_id) || undefined,
    canResumeUpload: typeof raw.canResumeUpload === "boolean" ? raw.canResumeUpload : undefined,
    contract: {
      ...reopenMetadata(raw, contract),
      id: textValue(
        raw.contractId,
        raw.contract_id,
        contract.id,
        contract._id,
        contract.contractId,
        contract.contract_id
      ),
      contractNo: textValue(
        raw.contractNo,
        contract.contractNo,
        contract.contract_no,
        contract.number
      ),
      customerName: textValue(
        raw.customerName,
        raw.customer_name,
        contract.customerName,
        contract.customer_name,
        customer.name,
        customer.companyName,
        customer.company_name
      ),
      consignorName: contactName(
        raw.consignorName, raw.consignor_name,
        contract.consignorName, contract.consignor_name
      ),
      salespersonName: contactName(
        raw.salespersonName, raw.salesperson_name,
        contract.salespersonName, contract.salesperson_name
      ),
      description: contractDescription(raw.description, contract.description),
      eventId:
        textValue(raw.eventId, contract.eventId, event.id, event._id) || undefined,
      eventTitle: textValue(
        raw.eventTitle,
        contract.eventTitle,
        event.title,
        event.name
      ),
      eventDate:
        textValue(
          raw.eventDate,
          contract.eventDate,
          contract.closeDate,
          event.date,
          event.closeDate
        ) || undefined,
      location: textValue(
        raw.location,
        contract.location,
        contract.saleLocation,
        event.location
      ),
      // Only a three-letter code; anything else leaves the form's own detection in charge.
      currency: /^[A-Z]{3}$/.test(textValue(contract.currency).toUpperCase())
        ? textValue(contract.currency).toUpperCase()
        : undefined,
      categories:
        textValue(raw.categories, contract.categories, snapshot.categories) ||
        undefined,
    },
    lots: lotValues.map(normalizeLot),
    requiresScheduleAItem: raw.requiresScheduleAItem === true,
    scheduleAChoices: normalizeScheduleAChoices(raw.scheduleAChoices),
    ...(raw.proposalList !== undefined && normalizeProposalList(raw.proposalList)
      ? { proposalList: normalizeProposalList(raw.proposalList) }
      : {}),
  };
}

function normalizeDelivery(value: unknown): AuctioneerDeliverySummary {
  const raw = asRecord(value);
  const delivery = asRecord(raw.delivery);
  return {
    workItemId: textValue(
      raw.workItemId,
      raw.work_item_id,
      raw.id,
      raw._id
    ),
    reportId: textValue(raw.reportId, raw.report_id, raw.linkedReportId) || undefined,
    reportModel: raw.reportModel ?? raw.linkedReportModel,
    reportType: normalizeReportType(raw.reportType),
    contractId: textValue(raw.contractId, raw.contract_id) || undefined,
    contractNo: textValue(raw.contractNo, raw.contract_no) || undefined,
    accessRevision: accessRevision(raw.accessRevision),
    state: textValue(
      delivery.state,
      delivery.status,
      raw.state,
      raw.status,
      raw.deliveryState
    )
      .replace(/[-\s]/g, "_")
      .toLowerCase() as AuctioneerDeliveryState,
    canSend:
      typeof raw.canSend === "boolean"
        ? raw.canSend
        : typeof delivery.canSend === "boolean"
          ? delivery.canSend
          : undefined,
    canCompleteContract:
      typeof raw.canCompleteContract === "boolean"
        ? raw.canCompleteContract
        : typeof delivery.canCompleteContract === "boolean"
          ? delivery.canCompleteContract
          : undefined,
    destination: delivery.destination ?? raw.destination,
    opTaskDescription:
      textValue(delivery.opTaskDescription, raw.opTaskDescription) || undefined,
    // Only the two documented meanings; anything else reads as unknown, which
    // the dialog treats as the older whole-contract wording.
    contractCompletionScope:
      raw.contractCompletionScope === "user" ||
      raw.contractCompletionScope === "contract"
        ? raw.contractCompletionScope
        : undefined,
    completeContract: Boolean(
      delivery.completeContract ?? raw.completeContract
    ),
    contractClosedAt:
      textValue(delivery.contractClosedAt, raw.contractClosedAt) || undefined,
    contractTaskCompleted:
      typeof raw.contractTaskCompleted === "boolean"
        ? raw.contractTaskCompleted
        : undefined,
    contractCloseUserStatus: raw.contractCloseUserStatus === "completed" || raw.contractCloseUserStatus === "revoked"
      ? raw.contractCloseUserStatus : undefined,
    error: textValue(delivery.error, raw.error) || undefined,
    sentAt: textValue(delivery.sentAt, raw.sentAt) || undefined,
    updatedAt: textValue(delivery.updatedAt, raw.updatedAt) || undefined,
  };
}

export const AuctioneerService = {
  async getStatus() {
    const response = await API.get("/auctioneer/status");
    return unwrap(response.data) as {
      enabled: boolean;
      configured: boolean;
      reachable?: boolean;
      message?: string;
      apiKeyConfigured?: boolean;
      verificationEndpoint?: "/health" | "/auth/verify" | null;
    };
  },

  async getIncoming(forceRefresh = false): Promise<AuctioneerIncomingItem[]> {
    const response = await API.get("/auctioneer/incoming", {
      ...(forceRefresh ? { params: { refresh: true } } : {}),
    });
    const payload = unwrap(response.data);
    const record = asRecord(payload);
    const values = Array.isArray(payload)
      ? payload
      : record.items ?? record.contracts ?? record.incoming ?? [];
    return (Array.isArray(values) ? values : []).map(normalizeIncomingItem);
  },

  async getIncomingSummary(): Promise<{ availableCount: number }> {
    const response = await API.get("/auctioneer/incoming/summary");
    const payload = asRecord(unwrap(response.data));
    return {
      availableCount: Math.max(0, Number(payload.availableCount) || 0),
    };
  },

  async getCapturePermission(contractId: string): Promise<AuctioneerCapturePermission> {
    const response = await API.get(
      `/auctioneer/contracts/${encodeURIComponent(contractId)}/capture-permission`
    );
    const raw = asRecord(unwrap(response.data));
    const reopen = asRecord(raw.reopen);
    if (asRecord(response.data).success !== true || typeof reopen.allowed !== "boolean" ||
      (raw.contractId !== undefined && raw.contractId !== contractId)) {
      throw new Error("Re-open permission could not be confirmed.");
    }
    return {
      ...reopenMetadata(raw, {}),
      confirmationPending: raw.confirmationPending === true,
      reopen: {
        allowed: reopen.allowed === true,
        reason: typeof reopen.reason === "string" ? reopen.reason : null,
        reopenUntil: typeof reopen.reopenUntil === "string" && Number.isFinite(Date.parse(reopen.reopenUntil))
          ? reopen.reopenUntil : null,
      },
    };
  },

  async reopenContractPart(contractId: string): Promise<AuctioneerContractReopen> {
    const response = await API.post(
      `/auctioneer/contracts/${encodeURIComponent(contractId)}/reopen`,
      {},
      { _retry: true, timeout: 30_000 } as RetriableAxiosConfig
    );
    const raw = asRecord(unwrap(response.data));
    const revision = accessRevision(raw.accessRevision);
    if (asRecord(response.data).success !== true || raw.contractId !== contractId ||
      typeof raw.reopened !== "boolean" || typeof raw.alreadyOpen !== "boolean" ||
      raw.reopened === raw.alreadyOpen || revision === undefined) {
      throw new Error("Re-opening was not confirmed.");
    }
    return { contractId, reopened: raw.reopened, alreadyOpen: raw.alreadyOpen, accessRevision: revision };
  },

  async claim(cycleKey: string, reportType: AuctioneerReportType) {
    const response = await API.post(
      `/auctioneer/incoming/${encodeURIComponent(cycleKey)}/claim`,
      { reportType }
    );
    const claimed = normalizeSetup(response.data);
    if (
      claimed.workItemId &&
      (!claimed.contract.id || !claimed.contract.contractNo)
    ) {
      return AuctioneerService.getSetup(claimed.workItemId);
    }
    return claimed;
  },

  async getSetup(workItemId: string, options?: { signal?: AbortSignal }) {
    const response = await API.get(
      `/auctioneer/work-items/${encodeURIComponent(workItemId)}/setup`,
      options
    );
    return normalizeSetup(response.data);
  },

  async continueWorkItem(
    workItemId: string,
    reportId: string
  ): Promise<AuctioneerWorkItemSetup> {
    const response = await API.post(
      `/auctioneer/work-items/${encodeURIComponent(workItemId)}/continue`,
      { reportId }
    );
    return normalizeSetup(response.data);
  },
  /**
   * Returns listed Proposal items the appraiser could not find to Auctioneer
   * at once, as not found (owner 2026-10-28). Not replayed automatically: the
   * server answers a repeat harmlessly, but the person decides to repeat it.
   */
  async markProposalItemsNotFound(
    workItemId: string,
    lineIds: string[]
  ): Promise<{ notFound: string[]; remainsInAssetInsight: boolean | null; setup: AuctioneerWorkItemSetup }> {
    const response = await API.post(
      `/auctioneer/work-items/${encodeURIComponent(workItemId)}/proposal-items/not-found`,
      { lineIds },
      { _retry: true, timeout: 30_000 } as RetriableAxiosConfig
    );
    const raw = asRecord(unwrap(response.data));
    if (asRecord(response.data).success !== true || !Array.isArray(raw.notFound)) {
      throw new Error("Auctioneer did not confirm the not-found items. Refresh the Proposal before trying again.");
    }
    const setup = normalizeSetup(raw.setup);
    const requested = new Set(lineIds);
    const confirmed = new Set(raw.notFound.filter((lineId): lineId is string => typeof lineId === "string"));
    // An idempotent answer may contain no new returns: its refreshed setup
    // must then explicitly confirm each requested item as already not found.
    const alreadyNotFound = new Set(setup.proposalList?.items.filter((item) => item.state === "not_found").map((item) => item.lineId));
    if (setup.workItemId !== workItemId || requested.size !== lineIds.length ||
      !lineIds.length || raw.notFound.some((lineId) => typeof lineId !== "string" || !requested.has(lineId)) ||
      lineIds.some((lineId) => !confirmed.has(lineId) && !alreadyNotFound.has(lineId))) {
      throw new Error("Auctioneer did not confirm the not-found items. Refresh the Proposal before trying again.");
    }
    return {
      notFound: [...confirmed],
      remainsInAssetInsight:
        typeof raw.remainsInAssetInsight === "boolean" ? raw.remainsInAssetInsight : null,
      setup,
    };
  },

  async releaseClaim(workItemId: string) {
    await API.delete(
      `/auctioneer/work-items/${encodeURIComponent(workItemId)}/claim`
    );
  },

  async getDeliveries(): Promise<AuctioneerDeliverySummary[]> {
    const response = await API.get("/auctioneer/deliveries");
    const payload = unwrap(response.data);
    const record = asRecord(payload);
    const values = Array.isArray(payload)
      ? payload
      : record.items ?? record.deliveries ?? [];
    return (Array.isArray(values) ? values : []).map(normalizeDelivery);
  },

  async sendDelivery(
    workItemId: string,
    input: AuctioneerSendDeliveryInput
  ): Promise<AuctioneerDeliverySummary> {
    const response = await API.post(
      `/auctioneer/deliveries/${encodeURIComponent(workItemId)}/send`,
      input
    );
    return normalizeDelivery(unwrap(response.data));
  },

  async reconcileDelivery(
    workItemId: string,
    input: AuctioneerReconcileDeliveryInput
  ): Promise<AuctioneerDeliverySummary> {
    const response = await API.post(
      `/auctioneer/deliveries/${encodeURIComponent(workItemId)}/reconcile`,
      input
    );
    return normalizeDelivery(unwrap(response.data));
  },

  /**
   * Close the signed-in user's own part of a contract without sending
   * anything. The server takes the user from the session, so nothing about
   * who is closing is sent from here.
   */
  async closeContractPart(
    contractId: string,
    revision?: string | number
  ): Promise<AuctioneerContractPartClose> {
    if (revision !== undefined && accessRevision(revision) === undefined) {
      throw new Error("Contract access changed. Refresh Reports before closing your part.");
    }
    const response = await API.post(
      `/auctioneer/contracts/${encodeURIComponent(contractId)}/close-my-part`,
      revision === undefined ? {} : { accessRevision: revision },
      { _retry: true, timeout: 30_000 } as RetriableAxiosConfig
    );
    const raw = asRecord(unwrap(response.data));
    // An empty/mismatched success is not a receipt for closing this contract.
    // Do not replay a lifecycle mutation automatically after authentication errors.
    if (
      asRecord(response.data).success !== true || raw.contractId !== contractId ||
      typeof raw.closedAt !== "string" || !Number.isFinite(Date.parse(raw.closedAt)) ||
      typeof raw.taskCompleted !== "boolean" || typeof raw.alreadyCompleted !== "boolean" ||
      (raw.taskCompleted !== true && raw.userStatus !== "completed" && raw.userStatus !== "revoked")
    ) {
      throw new Error("Contract completion was not confirmed. Refresh Reports to check its status before trying again.");
    }
    return {
      contractId,
      contractNo: textValue(raw.contractNo) || undefined,
      closedAt: raw.closedAt,
      taskCompleted: raw.taskCompleted === true,
      alreadyCompleted: raw.alreadyCompleted === true,
      userStatus:
        typeof raw.userStatus === "string" && raw.userStatus.trim()
          ? raw.userStatus.trim()
          : null,
    };
  },
};

export default AuctioneerService;
