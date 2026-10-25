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
    categories?: string;
  };
  lots: AuctioneerSourceLot[];
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
  };
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
      categories:
        textValue(raw.categories, contract.categories, snapshot.categories) ||
        undefined,
    },
    lots: lotValues.map(normalizeLot),
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
