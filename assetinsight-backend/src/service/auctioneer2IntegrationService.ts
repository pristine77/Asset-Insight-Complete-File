/**
 * Coordinates Auctioneer2 intake, claim ownership, report linkage, readiness, and queue
 * handoff. Atomic conditional updates enforce one active claim/report type per incoming
 * cycle, short-lived read caches reduce provider load, and payload hashes lock retry
 * settings so durable delivery checkpoints remain meaningful.
 */
import { createHash } from "crypto";
import { buildAuctioneerVideoManifest } from "./auctioneer2VideoManifest.js";
import { assertAuctioneerContractSendOpen, assertAuctioneerContractCaptureRevision, getAuctioneerContractCaptureState, assertNoQueuedContinuationUpload, beginAuctioneerContractClose, confirmAuctioneerContractClose, withAuctioneerContractOperation } from "./auctioneerContractCloseService.js";
import AuctioneerContractClose from "../models/auctioneerContractClose.model.js";
import type { ReportSubmissionAdmissionLease } from "./reportSubmissionAdmissionService.js";
import { Types } from "mongoose";
import AssetReport from "../models/asset.model.js";
import { createLotPhotoResolver, firstReportImageManifest } from "../utils/lotPhotoOrder.js";
import AuctioneerWorkItem, {
  type AuctioneerDeliveryDestination,
  type AuctioneerReportType,
  type IAuctioneerSourceLot,
  type IAuctioneerWorkItem,
} from "../models/auctioneerWorkItem.model.js";
import LotListing from "../models/lotListing.model.js";
import ReportJob from "../models/reportJob.model.js";
import User from "../models/user.model.js";
import ReportUploadSession from "../models/reportUploadSession.model.js";
import type { AuthRequest } from "../middleware/auth.middleware.js";
import { hasCurrentTransferGrant, reportTransferSnapshotHash, verifyForegroundTransferDevice } from "./reportTransferService.js";
import { createMongoReportJob } from "../utils/reportJobMongoQueue.js";
import { resolveReportGenerationStateForProfile } from "../utils/reportFileState.js";
import { auctioneer2ActiveContractKey } from "../utils/auctioneer2WorkItemKeys.js";
import {
  AuctioneerEventIdentityError,
  normalizeAuctioneerEventId,
  readAuctioneerContractIdentityCandidates,
  readAuctioneerEventIdentity,
  resolveAuctioneerEventIdentity,
} from "../utils/auctioneerEventIdentity.js";
import {
  AUCTIONEER2_INCOMING_CONTRACT_STATUS,
  Auctioneer2ClientError,
  type Auctioneer2Record,
  closeContractPartForUser,
  getContractLots,
  getLot,
  listIncomingContracts,
  listIncomingTasks,
} from "./auctioneer2Client.js";

export class Auctioneer2ServiceError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = "Auctioneer2ServiceError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function reconcileEventIdentity(sources: unknown[], standaloneEvents: unknown[] = []): string | undefined {
  try {
    return resolveAuctioneerEventIdentity([
      ...sources.map((source) => readAuctioneerEventIdentity(source)),
      ...standaloneEvents.map((source) => readAuctioneerEventIdentity(source, { standaloneEvent: true })),
    ]);
  } catch (error) {
    if (error instanceof AuctioneerEventIdentityError) throw new Auctioneer2ServiceError(error.message, 409, error.code);
    throw error;
  }
}

function assertEventContractContext(source: unknown, contractId: string, standaloneContract = false): void {
  if (readAuctioneerContractIdentityCandidates(source, { standaloneContract }).some((id) => id !== contractId)) {
    throw new Auctioneer2ServiceError(
      "The imported auction event metadata refers to a different contract. Refresh Incoming before retrying.",
      409, "auctioneer_event_context_changed"
    );
  }
}

type NormalizedContract = {
  id: string;
  contractNo: string;
  status?: string;
  customerName?: string;
  consignorName?: string;
  salespersonName?: string;
  /** Free text the office wrote on the contract, e.g. "Farm equipment". */
  description?: string;
  eventId?: string;
  eventTitle?: string;
  eventDate?: string;
  eventTime?: string;
  eventClosed?: boolean;
  reopenUntil?: string;
  location?: string;
  categories?: string;
  hasScheduleA?: boolean;
  hasUnknownLots?: boolean;
  lotCount?: number;
  assignedUserId?: string;
  assignedUserName?: string;
  assignedUserEmail?: string;
  raw: Auctioneer2Record;
};

type NormalizedTask = {
  id?: string;
  contractId?: string;
  contractNo?: string;
  submissionId?: string;
  lotId?: string;
  eventId?: string;
  assignedUserId?: string;
  assignedUserName?: string;
  assignedUserEmail?: string;
  raw: Auctioneer2Record;
  embeddedLot?: Auctioneer2Record;
};

type IncomingSource = {
  contracts: Auctioneer2Record[];
  tasks: Auctioneer2Record[];
};

type ExpiringRecords = {
  records: Auctioneer2Record[];
  expiresAt: number;
};

const contractCaches = new Map<string, ExpiringRecords>();
const contractPromises = new Map<string, Promise<Auctioneer2Record[]>>();
const incomingCacheGenerations = new Map<string, number>();
const taskCaches = new Map<string, ExpiringRecords>();
const taskPromises = new Map<string, Promise<Auctioneer2Record[]>>();

function isRecord(value: unknown): value is Auctioneer2Record {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getPath(record: Auctioneer2Record, path: string): unknown {
  let value: unknown = record;
  for (const part of path.split(".")) {
    if (!isRecord(value)) return undefined;
    value = value[part];
  }
  return value;
}

function firstValue(record: Auctioneer2Record, paths: string[]): unknown {
  for (const path of paths) {
    const value = getPath(record, path);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function textValue(record: Auctioneer2Record, paths: string[]): string | undefined {
  const value = firstValue(record, paths);
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return undefined;
}

type ContractContactNames = { consignorName?: string; salespersonName?: string };
const CONTRACT_CONTACT_PATHS = {
  consignorName: ["consignorName", "consignor_name", "consignerName", "consigner_name", "consignor.name", "consignor.displayName", "consigner.name", "consigner.displayName"],
  salespersonName: ["salespersonName", "salesperson_name", "salesPersonName", "sales_person_name", "salesperson.name", "salesperson.displayName", "salesPerson.name", "salesPerson.displayName"],
} satisfies Record<keyof ContractContactNames, string[]>;

// Display metadata only: never infer either role from the customer, assignee,
// appraiser, a user ID, email address, or an arbitrary nested provider object.
function contractContactNames(source: unknown, contractId: string): ContractContactNames {
  if (!isRecord(source) || readAuctioneerContractIdentityCandidates(source).some((id) => id !== contractId)) return {};
  const contexts = [source, ...["contract", "lot.contract", "asset.contract", "item.contract"]
    .map((path) => getPath(source, path)).filter(isRecord)];
  const names: ContractContactNames = {};
  for (const field of ["consignorName", "salespersonName"] as const) {
    for (const context of contexts) {
      for (const path of CONTRACT_CONTACT_PATHS[field]) {
        const raw = getPath(context, path);
        if (typeof raw !== "string" || raw.length > 300) continue;
        const value = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
        if (value) { names[field] = value; break; }
      }
      if (names[field]) break;
    }
  }
  return names;
}

function savedContractContactNames(workItem: {
  contract: { id: string };
  snapshot?: { contract?: unknown; tasks?: unknown[] };
}): ContractContactNames {
  const contractId = workItem.contract.id;
  const result = contractContactNames(workItem.contract, contractId);
  if (result.consignorName && result.salespersonName) return result;
  // Legacy snapshots may contain these names even though the old projection
  // dropped them. Read that evidence without rewriting the frozen work item.
  for (const source of [workItem.snapshot?.contract, ...(workItem.snapshot?.tasks || [])]) {
    if (result.consignorName && result.salespersonName) break;
    if (!isRecord(source)) continue;
    if (source === workItem.snapshot?.contract &&
        readAuctioneerContractIdentityCandidates(source, { standaloneContract: true }).some((id) => id !== contractId)) continue;
    const names = contractContactNames(source, contractId);
    result.consignorName ||= names.consignorName;
    result.salespersonName ||= names.salespersonName;
  }
  return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined));
}

// Authority aliases are not display fallbacks: ignore invalid/blank containers,
// but never prefer one explicit owner/status over contradictory evidence.
function authorityTextValue(record: Auctioneer2Record, paths: string[]): string | undefined {
  const values = paths.map((path) => getPath(record, path))
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim()).filter(Boolean);
  if (new Set(values.map((value) => value.toLowerCase())).size > 1) {
    throw new Auctioneer2ServiceError(
      "Auctioneer 2.0 returned conflicting assignment or status values.",
      502, "auctioneer2_invalid_response"
    );
  }
  return values[0];
}

function assignmentValues(record: Auctioneer2Record) {
  return {
    assignedUserId: authorityTextValue(record, [
      "assignedTo.id",
      "assignedTo._id",
      "assigned_to.id",
      "assigned_to._id",
      "assignedTo",
      "assigned_to",
      "assignedUserId",
      "assigned_user_id",
      "assetInsightUserId",
      "asset_insight_user_id",
      "assignedUser.id",
      "assignedUser._id",
      "assignee.id",
      "assignee._id",
    ]),
    assignedUserName: textValue(record, [
      "assignedTo.displayName",
      "assignedTo.username",
      "assignedTo.name",
      "assigned_to.displayName",
      "assigned_to.username",
      "assigned_to.name",
      "assignedUserName",
      "assigned_user_name",
      "assetInsightUserName",
      "asset_insight_user_name",
      "assignedUser.displayName",
      "assignedUser.username",
      "assignedUser.name",
      "assignee.displayName",
      "assignee.username",
      "assignee.name",
    ]),
    assignedUserEmail: textValue(record, [
      "assignedTo.email",
      "assigned_to.email",
      "assignedUserEmail",
      "assigned_user_email",
      "assetInsightUserEmail",
      "asset_insight_user_email",
      "assignedUser.email",
      "assignee.email",
    ]),
  };
}

function booleanValue(record: Auctioneer2Record, paths: string[]): boolean | undefined {
  const value = firstValue(record, paths);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    if (["true", "yes", "1"].includes(value.toLowerCase())) return true;
    if (["false", "no", "0"].includes(value.toLowerCase())) return false;
  }
  return undefined;
}

function numberValue(record: Auctioneer2Record, paths: string[]): number | undefined {
  const value = firstValue(record, paths);
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nestedRecord(record: Auctioneer2Record, paths: string[]): Auctioneer2Record | undefined {
  const value = firstValue(record, paths);
  return isRecord(value) ? value : undefined;
}

function normalizedRecordArray(
  record: Auctioneer2Record,
  paths: string[],
  stringField: "name" | "url"
): Auctioneer2Record[] {
  for (const path of paths) {
    const value = getPath(record, path);
    if (!Array.isArray(value)) continue;
    return value
      .map((item) =>
        isRecord(item)
          ? item
          : typeof item === "string" && item.trim()
            ? { [stringField]: item.trim() }
            : null
      )
      .filter((item): item is Auctioneer2Record => Boolean(item));
  }
  return [];
}

function categoryText(record: Auctioneer2Record): string | undefined {
  const value = firstValue(record, ["categories", "category", "assetCategory", "asset_category"]);
  if (Array.isArray(value)) {
    const categories = value
      .map((item) => (typeof item === "string" ? item : isRecord(item) ? textValue(item, ["name", "title"]) : undefined))
      .filter((item): item is string => Boolean(item));
    return categories.length ? categories.join(", ") : undefined;
  }
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeAuctioneer2Contract(raw: Auctioneer2Record): NormalizedContract | null {
  const id = textValue(raw, [
    "id",
    "_id",
    "contractId",
    "contract_id",
    "contractGuid",
    "contract_guid",
    "uuid",
  ]);
  if (!id) return null;
  const contractNo =
    textValue(raw, [
      "contractNo",
      "contract_no",
      "contractNumber",
      "contract_number",
      "number",
    ]) || id;
  return {
    id,
    contractNo,
    status: authorityTextValue(raw, ["status", "contractStatus", "contract_status"]),
    ...assignmentValues(raw),
    ...contractContactNames(raw, id),
    customerName: textValue(raw, [
      "customerName",
      "customer_name",
      "customer.name",
      "clientName",
      "client.name",
      "ownerName",
    ]),
    // The contract's own description only — never a nested contract's, for
    // the same reason the contact names ignore a foreign embedded contract.
    description: textValue(raw, ["description", "contractDescription", "contract_description"]),
    eventId: reconcileEventIdentity([raw]),
    eventTime: textValue(raw, ["eventTime"]),
    ...(typeof raw.eventClosed === "boolean" ? { eventClosed: raw.eventClosed } : {}),
    reopenUntil: textValue(raw, ["reopenUntil"]),
    eventTitle: textValue(raw, [
      "eventTitle",
      "event_title",
      "event.title",
      "event.name",
      "auctionTitle",
    ]),
    eventDate: textValue(raw, [
      "eventDate",
      "event_date",
      "event.date",
      "closeDate",
      "saleDate",
    ]),
    location: textValue(raw, [
      "location",
      "saleLocation",
      "sale_location",
      "event.location",
      "address",
    ]),
    categories: categoryText(raw),
    hasScheduleA: booleanValue(raw, ["hasScheduleA", "has_schedule_a", "scheduleA"]),
    hasUnknownLots: booleanValue(raw, ["hasUnknownLots", "has_unknown_lots", "unknownLots"]),
    lotCount: numberValue(raw, [
      "lotCount",
      "lot_count",
      "lotsCount",
      "scheduleALotCount",
      "unknownLotCount",
    ]),
    raw,
  };
}

function isIncomingProposalContract(contract: NormalizedContract): boolean {
  return (
    contract.status?.trim().toLowerCase() ===
    AUCTIONEER2_INCOMING_CONTRACT_STATUS.toLowerCase()
  );
}

function normalizeTask(raw: Auctioneer2Record): NormalizedTask {
  const embeddedLot = nestedRecord(raw, ["lot", "asset", "item"]);
  const submission = nestedRecord(raw, ["submission"]);
  return {
    ...assignmentValues(raw),
    id: textValue(raw, ["id", "taskId", "task_id"]),
    contractId:
      textValue(raw, ["contractId", "contract_id", "contract.id"]) ||
      (embeddedLot ? textValue(embeddedLot, ["contractId", "contract_id", "contract.id"]) : undefined),
    contractNo: textValue(raw, [
      "contractNo",
      "contract_no",
      "contractNumber",
      "contract.contractNo",
    ]),
    submissionId:
      textValue(raw, ["submissionId", "submission_id", "submissionGuid", "submission_guid"]) ||
      (submission ? textValue(submission, ["id", "guid", "submissionId"]) : undefined),
    lotId:
      textValue(raw, ["lotRowGuid", "lot_row_guid", "lotId", "lot_id"]) ||
      (embeddedLot
        ? textValue(embeddedLot, [
            "rowGuid",
            "row_guid",
            "lotRowGuid",
            "lot_row_guid",
            "id",
            "lotId",
            "lot_id",
          ])
        : undefined),
    eventId: reconcileEventIdentity([raw]),
    raw,
    embeddedLot,
  };
}

export function normalizeAuctioneer2Lot(
  raw: Auctioneer2Record,
  fallback: { sourceKey: string; lotId?: string; submissionId?: string }
): IAuctioneerSourceLot {
  const lotNumberValue = firstValue(raw, ["lotNumber", "lot_number", "number", "contractLotRef"]);
  const yearValue = firstValue(raw, ["year", "manufactureYear", "manufacture_year"]);
  const serialNumber = textValue(raw, [
    "serialNumber",
    "serial_number",
    "serialNo",
    "serial_no",
    "sn_vin",
    "vin",
  ]);
  const explicitYear =
    typeof yearValue === "number"
      ? yearValue
      : typeof yearValue === "string" && yearValue.trim()
        ? yearValue
        : undefined;
  const services = normalizedRecordArray(
    raw,
    ["services", "selectedServices", "submission.selectedServices", "lot.services"],
    "name"
  );
  const sourcePhotos = normalizedRecordArray(
    raw,
    ["photos", "sourcePhotos", "images", "lot.photos"],
    "url"
  );
  return {
    sourceKey: fallback.sourceKey,
    lotId:
      textValue(raw, [
        "rowGuid",
        "row_guid",
        "lotRowGuid",
        "lot_row_guid",
        "id",
        "lotId",
        "lot_id",
      ]) || fallback.lotId,
    submissionId:
      textValue(raw, ["submissionId", "submission_id", "submissionGuid", "submission_guid"]) ||
      fallback.submissionId,
    lotNumber:
      typeof lotNumberValue === "string" || typeof lotNumberValue === "number"
        ? lotNumberValue
        : undefined,
    title: textValue(raw, ["title", "name", "assetTitle", "asset_title"]),
    description: textValue(raw, ["description", "assetDescription", "asset_description"]),
    details: textValue(raw, ["details", "notes", "specifications"]),
    categories: categoryText(raw),
    serialNumber,
    make: textValue(raw, ["make", "manufacturer"]),
    model: textValue(raw, ["model"]),
    // Keep source provenance intact here. VIN decoding happens later in the
    // report enrichment pipeline, where an authoritative vPIC year can take
    // precedence over the deterministic 10th-character fallback.
    year: explicitYear,
    conditionReport: textValue(raw, [
      "conditionReport",
      "condition_report",
      "condition",
      "conditionNotes",
    ]),
    ...(services.length ? { services } : {}),
    ...(sourcePhotos.length ? { sourcePhotos } : {}),
    raw,
  };
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function incomingAssignment(tasks: NormalizedTask[]) {
  const task = tasks.find((item) => item.assignedUserId);
  return {
    assignedUserId: task?.assignedUserId,
    assignedUserName: task?.assignedUserName,
    assignedUserEmail: task?.assignedUserEmail,
  };
}

function userIdsMatch(first: string, second: string) {
  return first.trim().toLowerCase() === second.trim().toLowerCase();
}

function taskCycleKeyFor(contractId: string, task: NormalizedTask): string {
  const identity = task.lotId
    ? `lot:${task.lotId}`
    : task.id
      ? `task:${task.id}`
      : task.submissionId
        ? `submission:${task.submissionId}`
        : "";
  if (!identity) {
    throw new Auctioneer2ServiceError(
      "Auctioneer 2.0 returned an incoming task without a stable lot, submission, or task ID.",
      502,
      "auctioneer2_invalid_response"
    );
  }
  // Known Auctioneer lots retain the same cycle even if their surrounding task
  // or submission identifiers change. Namespacing also prevents unrelated ID
  // types from colliding when the provider happens to reuse an opaque value.
  return stableHash(`${contractId}:${identity}`);
}

function proposalContractCycleKey(contractId: string): string {
  return stableHash(`${contractId}:proposal-contract`);
}

function addTaskIdentityCycleKeys(
  keys: Set<string>,
  contractId: string,
  task: Pick<NormalizedTask, "id" | "lotId" | "submissionId" | "raw">
) {
  if (task.lotId) {
    keys.add(taskCycleKeyFor(contractId, { lotId: task.lotId, raw: task.raw }));
  }
  if (task.id) {
    keys.add(taskCycleKeyFor(contractId, { id: task.id, raw: task.raw }));
  }
  if (task.submissionId) {
    keys.add(
      taskCycleKeyFor(contractId, {
        submissionId: task.submissionId,
        raw: task.raw,
      })
    );
  }
}

function snapshotTaskCycleKeys(workItem: any): string[] {
  const contractId = String(workItem?.contract?.id || "").trim();
  const snapshotTasks = Array.isArray(workItem?.snapshot?.tasks)
    ? workItem.snapshot.tasks
    : [];
  if (!contractId) return [];
  const keys = new Set<string>();
  for (const rawTask of snapshotTasks) {
    if (!isRecord(rawTask)) continue;
    const task = normalizeTask(rawTask);
    if (!task.submissionId && !task.id && !task.lotId) continue;
    addTaskIdentityCycleKeys(keys, contractId, task);
  }
  const snapshotLots = Array.isArray(workItem?.snapshot?.lots)
    ? workItem.snapshot.lots
    : [];
  for (const rawLot of snapshotLots) {
    if (!isRecord(rawLot)) continue;
    const lotId = textValue(rawLot, [
      "rowGuid",
      "row_guid",
      "lotRowGuid",
      "lot_row_guid",
      "lotId",
      "lot_id",
      "id",
    ]);
    const submissionId = textValue(rawLot, [
      "submissionId",
      "submission_id",
      "submissionGuid",
      "submission_guid",
    ]);
    if (!lotId && !submissionId) continue;
    addTaskIdentityCycleKeys(keys, contractId, {
      lotId,
      submissionId,
      raw: rawLot,
    });
  }
  const deliveryLots = Array.isArray(workItem?.delivery?.lots)
    ? workItem.delivery.lots
    : [];
  for (const checkpoint of deliveryLots) {
    if (!isRecord(checkpoint)) continue;
    for (const lotId of [checkpoint.sourceLotId, checkpoint.createdLotId]) {
      const normalizedLotId =
        typeof lotId === "string" || typeof lotId === "number"
          ? String(lotId).trim()
          : "";
      if (!normalizedLotId) continue;
      addTaskIdentityCycleKeys(keys, contractId, {
        lotId: normalizedLotId,
        raw: checkpoint,
      });
    }
    for (const submissionId of [
      checkpoint.sourceSubmissionId,
      checkpoint.createdSubmissionId,
    ]) {
      const normalizedSubmissionId =
        typeof submissionId === "string" || typeof submissionId === "number"
          ? String(submissionId).trim()
          : "";
      if (!normalizedSubmissionId) continue;
      addTaskIdentityCycleKeys(keys, contractId, {
        submissionId: normalizedSubmissionId,
        raw: checkpoint,
      });
    }
  }
  return [...keys];
}

function contractCacheKey(userId: string): string {
  return userId.trim().toLowerCase();
}

function taskCacheKey(userId: string, contractId?: string): string {
  return `${userId.trim().toLowerCase()}\u0000${String(contractId || "").trim()}`;
}

// Cache completed reads briefly and coalesce identical in-flight reads. The latter is
// important under dashboard fan-out: a TTL alone would still issue concurrent misses.
async function loadContractsForUser(
  userId: string,
  force = false
): Promise<Auctioneer2Record[]> {
  const key = contractCacheKey(userId);
  const now = Date.now();
  for (const [cachedKey, cachedValue] of contractCaches) {
    if (cachedValue.expiresAt <= now && !contractPromises.has(cachedKey)) {
      contractCaches.delete(cachedKey);
    }
  }
  const cached = contractCaches.get(key);
  if (!force && cached && cached.expiresAt > now) return cached.records;
  const inFlight = contractPromises.get(key);
  if (!force && inFlight) return inFlight;
  const generation = incomingCacheGenerations.get(key) || 0;
  const promise = listIncomingContracts(userId, true)
    .then((contracts) => validateAssignedContracts(contracts, userId))
    .then((contracts) => {
      if ((incomingCacheGenerations.get(key) || 0) === generation) contractCaches.set(key, {
        records: contracts,
        expiresAt: Date.now() + 15_000,
      });
      return contracts;
    })
    .finally(() => {
      if (contractPromises.get(key) === promise) contractPromises.delete(key);
    });
  contractPromises.set(key, promise);
  return promise;
}

function validateAssignedContracts(
  records: Auctioneer2Record[],
  requestedUserId: string
): Auctioneer2Record[] {
  for (const record of records) {
    const contract = normalizeAuctioneer2Contract(record);
    if (!contract) {
      throw new Auctioneer2ServiceError(
        "Auctioneer 2.0 returned an incoming contract without a stable ID.",
        502,
        "auctioneer2_invalid_response"
      );
    }
    if (isIncomingProposalContract(contract) && !contract.assignedUserId) {
      throw new Auctioneer2ServiceError(
        "Auctioneer 2.0 returned a proposal contract without an Asset Insight assignee.",
        502,
        "auctioneer2_invalid_response"
      );
    }
    if (
      contract.assignedUserId &&
      !userIdsMatch(contract.assignedUserId, requestedUserId)
    ) {
      throw new Auctioneer2ServiceError(
        "Auctioneer 2.0 returned work assigned to a different Asset Insight user.",
        502,
        "auctioneer2_invalid_response"
      );
    }
  }
  return records;
}

function validateAssignedTasks(
  records: Auctioneer2Record[],
  requestedUserId: string
): Auctioneer2Record[] {
  // Treat cross-user data as an invalid provider response, never as an item that can be
  // hidden in presentation code; this is an authorization boundary as well as validation.
  for (const record of records) {
    const assignment = normalizeTask(record).assignedUserId;
    if (assignment && !userIdsMatch(assignment, requestedUserId)) {
      throw new Auctioneer2ServiceError(
        "Auctioneer 2.0 returned work assigned to a different Asset Insight user.",
        502,
        "auctioneer2_invalid_response"
      );
    }
  }
  return records;
}

async function loadTasksForUser(
  userId: string,
  force = false,
  contractId?: string
): Promise<Auctioneer2Record[]> {
  const key = taskCacheKey(userId, contractId);
  const now = Date.now();
  for (const [cachedKey, cachedValue] of taskCaches) {
    if (cachedValue.expiresAt <= now && !taskPromises.has(cachedKey)) {
      taskCaches.delete(cachedKey);
    }
  }
  const cached = taskCaches.get(key);
  if (!force && cached && cached.expiresAt > now) return cached.records;
  const inFlight = taskPromises.get(key);
  if (!force && inFlight) return inFlight;
  const generation = incomingCacheGenerations.get(contractCacheKey(userId)) || 0;
  const promise = listIncomingTasks(userId, contractId)
    .then((tasks) => validateAssignedTasks(tasks, userId))
    .then((tasks) => {
      if ((incomingCacheGenerations.get(contractCacheKey(userId)) || 0) === generation) taskCaches.set(key, {
        records: tasks,
        expiresAt: Date.now() + 15_000,
      });
      return tasks;
    })
    .finally(() => {
      if (taskPromises.get(key) === promise) taskPromises.delete(key);
    });
  taskPromises.set(key, promise);
  return promise;
}

async function loadIncomingSource(
  userId: string,
  force = false
): Promise<IncomingSource> {
  const contracts = await loadContractsForUser(userId, force);
  // Proposal contracts are the current visibility authority and must remain
  // usable even when the legacy task feed is unavailable. Keep successful
  // task rows additive for older assignments, but never make proposal cards
  // depend on them.
  const hasProposalContracts = contracts.some((raw) => {
    const contract = normalizeAuctioneer2Contract(raw);
    return contract ? isIncomingProposalContract(contract) : false;
  });
  let tasks: Auctioneer2Record[];
  try {
    tasks = await loadTasksForUser(userId, force);
  } catch (error) {
    // Only tolerate an unavailable/unsupported legacy provider route. Domain
    // validation failures (especially a cross-user task assignment) still fail
    // closed and must never be downgraded to an empty feed.
    if (
      !hasProposalContracts ||
      !(error instanceof Auctioneer2ClientError)
    ) {
      throw error;
    }
    tasks = [];
  }
  return { contracts, tasks };
}

export function clearAuctioneer2IncomingCacheForTests() {
  contractCaches.clear();
  contractPromises.clear();
  incomingCacheGenerations.clear();
  taskCaches.clear();
  taskPromises.clear();
}

export function clearAuctioneer2IncomingCacheForUser(userId: string) {
  const userKey = contractCacheKey(userId);
  incomingCacheGenerations.set(userKey, (incomingCacheGenerations.get(userKey) || 0) + 1);
  contractPromises.delete(userKey);
  contractCaches.delete(contractCacheKey(userId));
  const prefix = `${userId.trim().toLowerCase()}\u0000`;
  for (const key of taskCaches.keys()) {
    if (key.startsWith(prefix)) taskCaches.delete(key);
  }
  for (const key of taskPromises.keys()) if (key.startsWith(prefix)) taskPromises.delete(key);
}
const clearAuctioneer2IncomingCache = clearAuctioneer2IncomingCacheForUser;

function publicClaimedBy(value: unknown): { id: string; name: string } | undefined {
  if (!isRecord(value)) return undefined;
  const rawId = value._id ?? value.id;
  const id =
    typeof rawId === "string" ||
    typeof rawId === "number" ||
    typeof rawId === "bigint"
      ? String(rawId).trim()
      : rawId
        ? String(rawId)
        : "";
  if (!id) return undefined;
  return {
    id,
    name: textValue(value, ["username", "email"]) || "Another user",
  };
}

function isSentWorkItem(workItem: any): boolean {
  return workItem?.status === "sent" || workItem?.delivery?.status === "sent";
}

function publicIncomingStatus(workItem: any): "available" | "claimed" | "report_created" | "sent" {
  if (!workItem) return "available";
  if (isSentWorkItem(workItem)) return "sent";
  if (workItem.status === "report_created" || workItem.linkedReportId) return "report_created";
  return "claimed";
}

type IncomingCycle = {
  cycleKey: string;
  contract: NormalizedContract;
  tasks: NormalizedTask[];
  kind: "scheduleA" | "unknown";
  source: "proposalContract" | "task";
  assignedUserId?: string;
  assignedUserName?: string;
  assignedUserEmail?: string;
  accessRevision?: string | number;
};

/**
 * The contract block a task carries, normalised — when it names the task's
 * own contract and nothing else.
 *
 * Auctioneer 2.0 sends one since 2026-09-30 so a lot-level assignment can
 * show its customer, salesperson, event, location and description: such a
 * contract is not in the contract listing, and these rows read "Not
 * supplied" throughout. A block naming another contract is ignored, as a
 * foreign embedded contract's names are. A block whose event data
 * contradicts itself is ignored rather than fatal: the task's own identity
 * already carries the event.
 */
function embeddedTaskContract(source: unknown, contractId: string): NormalizedContract | undefined {
  if (!isRecord(source)) return undefined;
  const block = nestedRecord(source, ["contract", "lot.contract"]);
  if (!block) return undefined;
  const candidates = readAuctioneerContractIdentityCandidates(block, { standaloneContract: true });
  if (candidates.length === 0 || candidates.some((id) => id !== contractId)) return undefined;
  try {
    return normalizeAuctioneer2Contract(block) ?? undefined;
  } catch (error) {
    if (error instanceof Auctioneer2ServiceError || error instanceof AuctioneerEventIdentityError) return undefined;
    throw error;
  }
}

const CONTRACT_DISPLAY_FIELDS = [
  "customerName", "consignorName", "salespersonName", "description", "eventTitle", "eventDate", "location",
] as const;

/** Fill what the primary source left blank from the block, never overriding it. */
function withContractDetails(contract: NormalizedContract, details?: NormalizedContract): NormalizedContract {
  if (!details) return contract;
  // A display fallback must not attach another event's title/date to the
  // primary contract. Claim reconciliation enforces this identity too.
  reconcileEventIdentity([{ eventId: contract.eventId }, { eventId: details.eventId }]);
  const filled: NormalizedContract = { ...contract };
  for (const field of CONTRACT_DISPLAY_FIELDS) {
    if (!filled[field] && details[field]) filled[field] = details[field];
  }
  return filled;
}

function buildTaskFirstCycles(source: IncomingSource): IncomingCycle[] {
  const tasks = source.tasks.map(normalizeTask);
  const contractsById = new Map<string, NormalizedContract>();
  const contractsByNumber = new Map<string, NormalizedContract>();
  source.contracts.forEach((raw) => {
    const contract = normalizeAuctioneer2Contract(raw);
    if (!contract) return;
    contractsById.set(contract.id, contract);
    if (!contractsByNumber.has(contract.contractNo)) {
      contractsByNumber.set(contract.contractNo, contract);
    }
  });

  const cycles = new Map<string, IncomingCycle>();
  tasks.forEach((task) => {
    const enriched =
      (task.contractId ? contractsById.get(task.contractId) : undefined) ||
      (task.contractNo ? contractsByNumber.get(task.contractNo) : undefined);
    const fallbackId = task.contractId || task.contractNo;
    if (!enriched && !fallbackId) {
      throw new Auctioneer2ServiceError(
        "Auctioneer 2.0 returned an incoming task without a contract reference.",
        502,
        "auctioneer2_invalid_response"
      );
    }
    const taskNames = contractContactNames(task.raw, enriched?.id || fallbackId!);
    const embedded = embeddedTaskContract(task.raw, enriched?.id || fallbackId!);
    const contract = withContractDetails(
      enriched
        ? { ...taskNames, ...enriched }
        : ({
          id: fallbackId!,
          contractNo: task.contractNo || fallbackId!,
          eventId: task.eventId,
          ...taskNames,
          raw: {},
        } satisfies NormalizedContract),
      embedded,
    );
    const cycleKey = taskCycleKeyFor(contract.id, task);
    if (cycles.has(cycleKey)) return;
    const scheduleA =
      contract.hasScheduleA === true || Boolean(task.lotId);
    cycles.set(cycleKey, {
      cycleKey,
      contract,
      tasks: [task],
      kind: (scheduleA ? "scheduleA" : "unknown") as "scheduleA" | "unknown",
      source: "task",
      ...incomingAssignment([task]),
    });
  });
  return [...cycles.values()];
}

function taskBelongsToContract(
  task: NormalizedTask,
  contract: NormalizedContract
): boolean {
  return (
    task.contractId === contract.id ||
    (!task.contractId &&
      Boolean(task.contractNo) &&
      task.contractNo === contract.contractNo)
  );
}

function buildIncomingCycles(source: IncomingSource): IncomingCycle[] {
  const proposalContracts = new Map<string, NormalizedContract>();
  const legacyContracts: Auctioneer2Record[] = [];
  for (const raw of source.contracts) {
    const contract = normalizeAuctioneer2Contract(raw);
    if (!contract) continue;
    if (isIncomingProposalContract(contract)) {
      proposalContracts.set(contract.id, contract);
    } else {
      legacyContracts.push(raw);
    }
  }

  const normalizedTasks = source.tasks.map(normalizeTask);
  const proposalCycles = [...proposalContracts.values()].map((contract) => {
    const contractTasks = normalizedTasks.filter((task) =>
      taskBelongsToContract(task, contract)
    );
    return {
      cycleKey: proposalContractCycleKey(contract.id),
      contract,
      tasks: contractTasks,
      kind: (contract.hasScheduleA === true ? "scheduleA" : "unknown") as
        | "scheduleA"
        | "unknown",
      source: "proposalContract" as const,
      assignedUserId: contract.assignedUserId,
      assignedUserName: contract.assignedUserName,
      assignedUserEmail: contract.assignedUserEmail,
    };
  });

  const legacyTasks = source.tasks.filter((raw) => {
    const task = normalizeTask(raw);
    return ![...proposalContracts.values()].some((contract) =>
      taskBelongsToContract(task, contract)
    );
  });
  return [
    ...proposalCycles,
    ...buildTaskFirstCycles({ contracts: legacyContracts, tasks: legacyTasks }),
  ];
}

export async function listAuctioneerIncoming(force: boolean, userId: string) {
  if (!userId || !Types.ObjectId.isValid(userId)) {
    throw new Auctioneer2ServiceError(
      "The authenticated user is invalid.",
      401,
      "invalid_user"
    );
  }
  const source = await loadIncomingSource(userId, force);
  const contracts = source.contracts.map(normalizeAuctioneer2Contract).filter((c): c is NormalizedContract => Boolean(c));
  const captureStates = await AuctioneerContractClose.find({ user: userId, contractId: { $in: contracts.map(c => c.id) } }).lean();
  const stateByContract = new Map(captureStates.map(state => [state.contractId, state]));
  const rows: IncomingCycle[] = buildIncomingCycles(source).filter(row => !stateByContract.has(row.contract.id));
  for (const contract of contracts) {
    const state = stateByContract.get(contract.id);
    if (state?.status === "open" && state.reopenCycleKey) rows.push({ cycleKey: state.reopenCycleKey,
      contract, tasks: [], kind: "unknown", source: "proposalContract", assignedUserId: userId,
      accessRevision: state.accessRevision });
  }
  const liveContractIds = [
    ...new Set(rows.map((row) => String(row.contract.id))),
  ];
  const workItemClauses: Record<string, unknown>[] = [
    {
      claimedBy: userId,
      activeContractKey: { $type: "string" },
      status: { $in: ["claimed", "report_created"] },
    },
  ];
  if (rows.length) {
    workItemClauses.push({
      cycleKey: { $in: rows.map((row) => row.cycleKey) },
    });
    // Canonical per-lot cycle keys intentionally differ from the historical
    // submission-first and aggregate keys. Inspect blocking snapshots for the
    // same contracts across all users so a reassigned legacy lot cannot be
    // claimed and reported twice.
    workItemClauses.push({
      "contract.id": { $in: liveContractIds },
      $or: [
        { status: { $in: ["claimed", "report_created", "sent"] } },
        { "delivery.status": "sent" },
      ],
    });
  }
  const workItems = await AuctioneerWorkItem.find({
    $or: workItemClauses,
  })
    .populate("claimedBy", "username email")
    .lean();
  const byCycle = new Map(workItems.map((item: any) => [String(item.cycleKey), item]));
  const blockingCoverageByCycle = new Map<string, any>();
  const sentCoverageCycleKeys = new Set<string>();
  const sentContractIds = new Set<string>();
  workItems
    .filter((item: any) =>
      isSentWorkItem(item) ||
      ["claimed", "report_created"].includes(String(item.status))
    )
    .forEach((workItem: any) => {
      const coveredCycleKeys = snapshotTaskCycleKeys(workItem);
      if (isSentWorkItem(workItem)) {
        sentCoverageCycleKeys.add(String(workItem.cycleKey));
        if (workItem.contract?.id) {
          sentContractIds.add(String(workItem.contract.id));
        }
        coveredCycleKeys.forEach((coveredCycleKey) =>
          sentCoverageCycleKeys.add(coveredCycleKey)
        );
      }
      coveredCycleKeys.forEach((coveredCycleKey) => {
        const current = blockingCoverageByCycle.get(coveredCycleKey);
        if (!current || String(workItem.cycleKey) === coveredCycleKey) {
          blockingCoverageByCycle.set(coveredCycleKey, workItem);
        }
      });
    });
  const proposalWorkItemByContract = new Map<string, any>();
  for (const workItem of workItems as any[]) {
    const contractId = String(workItem.contract?.id || "");
    if (!contractId || isSentWorkItem(workItem)) continue;
    const current = proposalWorkItemByContract.get(contractId);
    const belongsToCurrentUser =
      String(workItem.claimedBy?._id || workItem.claimedBy) === userId;
    const currentBelongsToCurrentUser = current
      ? String(current.claimedBy?._id || current.claimedBy) === userId
      : false;
    if (!current || (belongsToCurrentUser && !currentBelongsToCurrentUser)) {
      proposalWorkItemByContract.set(contractId, workItem);
    }
  }
  const ownedActiveItems = workItems.filter(
    (item: any) =>
      item.activeContractKey &&
      ["claimed", "report_created"].includes(String(item.status)) &&
      String(item.claimedBy?._id || item.claimedBy) === userId
  );
  // Historical contract-batch items can contain more than one task. Preserve
  // the frozen batch once, suppress only its already-snapshotted task cycles,
  // and leave newly assigned cycles under the same contract visible.
  const legacyCoveredCycleKeys = new Set<string>();
  ownedActiveItems.forEach((workItem: any) => {
    snapshotTaskCycleKeys(workItem).forEach((coveredCycleKey) => {
      if (coveredCycleKey !== String(workItem.cycleKey)) {
        legacyCoveredCycleKeys.add(coveredCycleKey);
      }
    });
  });
  const visibleRows = rows.filter(
    (row) =>
      !(row.source === "proposalContract" && row.accessRevision === undefined
        ? sentContractIds.has(row.contract.id)
        : sentCoverageCycleKeys.has(row.cycleKey)) &&
      (byCycle.has(row.cycleKey) ||
        !legacyCoveredCycleKeys.has(row.cycleKey))
  );

  const matchedWorkItemIds = new Set<string>();
  const liveRows = visibleRows.map(
    ({
      cycleKey,
      contract,
      tasks: contractTasks,
      kind,
      source: cycleSource,
      assignedUserId,
      assignedUserName,
      assignedUserEmail,
    }) => {
      const workItem: any =
        byCycle.get(cycleKey) ||
        (cycleSource === "proposalContract" && stateByContract.get(contract.id)?.status !== "open"
          ? proposalWorkItemByContract.get(contract.id)
          : blockingCoverageByCycle.get(cycleKey));
      if (workItem?._id) matchedWorkItemIds.add(String(workItem._id));
      const workItemClaimantId = String(
        workItem?.claimedBy?._id || workItem?.claimedBy || ""
      );
      const belongsToCurrentUser =
        !workItem || userIdsMatch(workItemClaimantId, userId);
      const ownedWorkItem = belongsToCurrentUser ? workItem : undefined;
      const claimedBy = belongsToCurrentUser
        ? publicClaimedBy(workItem?.claimedBy)
        : undefined;
      const publicContract = ownedWorkItem?.contract || contract;
      const publicKind = ownedWorkItem?.kind || kind;
      const frozenLotCount = ownedWorkItem
        ? ownedWorkItem.snapshot?.lots?.length ||
          ownedWorkItem.snapshot?.tasks?.length ||
          contractTasks.length ||
          contract.lotCount ||
          0
        : contractTasks.length || contract.lotCount || 0;
      const publicAssignedUserId = ownedWorkItem?.assignmentUserId
        ? String(ownedWorkItem.assignmentUserId)
        : assignedUserId || userId;
      return {
        cycleKey:
          cycleSource === "proposalContract" && ownedWorkItem?.cycleKey
            ? String(ownedWorkItem.cycleKey)
            : cycleKey,
        contractId: publicContract.id,
        contractNo: publicContract.contractNo,
        ...(publicContract.customerName
          ? { customerName: publicContract.customerName }
          : {}),
        ...(publicContract.description ? { description: publicContract.description } : {}),
        ...(ownedWorkItem ? savedContractContactNames(ownedWorkItem) : contractContactNames(publicContract, publicContract.id)),
        ...(publicContract.eventTitle ? { eventTitle: publicContract.eventTitle } : {}),
        ...(publicContract.eventDate ? { eventDate: publicContract.eventDate } : {}),
        ...(contract.reopenUntil ? { reopenUntil: contract.reopenUntil } : {}),
        ...(contract.eventTime ? { eventTime: contract.eventTime } : {}),
        ...(contract.eventClosed !== undefined ? { eventClosed: contract.eventClosed } : {}),
        ...(stateByContract.get(contract.id)?.accessRevision !== undefined ? { accessRevision: stateByContract.get(contract.id)!.accessRevision } : {}),
        ...(publicContract.location ? { location: publicContract.location } : {}),
        kind: publicKind,
        lotCount: frozenLotCount,
        pendingLotCount: 0,
        status: belongsToCurrentUser
          ? publicIncomingStatus(workItem)
          : "claimed",
        ...(publicAssignedUserId
          ? {
              assignedUser: {
                id: publicAssignedUserId,
                ...(assignedUserName ? { name: assignedUserName } : {}),
                ...(assignedUserEmail ? { email: assignedUserEmail } : {}),
              },
              assignedToCurrentUser: userIdsMatch(publicAssignedUserId, userId),
            }
          : {}),
        ...(claimedBy ? { claimedBy } : {}),
        ...(belongsToCurrentUser && workItem?._id
          ? { workItemId: String(workItem._id) }
          : {}),
        ...(belongsToCurrentUser && workItem?.selectedReportType
          ? { selectedReportType: workItem.selectedReportType as AuctioneerReportType }
          : {}),
      };
    }
  );
  const liveCycleKeys = new Set(rows.map((row) => row.cycleKey));
  const frozenRows = ownedActiveItems
    .filter(
      (workItem: any) =>
        !liveCycleKeys.has(String(workItem.cycleKey)) &&
        !matchedWorkItemIds.has(String(workItem._id))
    )
    .map((workItem: any) => {
      const claimedBy = publicClaimedBy(workItem.claimedBy);
      const contract = workItem.contract;
      const assignmentUserId = workItem.assignmentUserId
        ? String(workItem.assignmentUserId)
        : userId;
      return {
        cycleKey: String(workItem.cycleKey),
        contractId: String(contract.id),
        contractNo: String(contract.contractNo),
        ...(contract.customerName ? { customerName: contract.customerName } : {}),
        ...(contract.description ? { description: contract.description } : {}),
        ...savedContractContactNames(workItem),
        ...(contract.eventTitle ? { eventTitle: contract.eventTitle } : {}),
        ...(contract.eventDate ? { eventDate: contract.eventDate } : {}),
        ...(contract.location ? { location: contract.location } : {}),
        kind: workItem.kind as "scheduleA" | "unknown",
        lotCount:
          workItem.snapshot?.lots?.length ||
          workItem.snapshot?.tasks?.length ||
          0,
        pendingLotCount: 0,
        status: publicIncomingStatus(workItem),
        assignedUser: {
          id: assignmentUserId,
          ...(claimedBy?.name ? { name: claimedBy.name } : {}),
        },
        assignedToCurrentUser: userIdsMatch(assignmentUserId, userId),
        ...(claimedBy ? { claimedBy } : {}),
        workItemId: String(workItem._id),
        selectedReportType: workItem.selectedReportType as AuctioneerReportType,
      };
    });
  // Completed-contract visibility follows Auctioneer's includeCompleted feed
  // (seven days). Historical local reports never extend this listing window.
  const completedRows = contracts.filter(contract => {
    const state = stateByContract.get(contract.id);
    return (Boolean(state) || userIdsMatch(String(contract.assignedUserId || ""), userId)) &&
      state?.status !== "open" && (Boolean(state) || contract.raw.assetInsightTaskCompleted === true ||
      ["completed", "closed"].includes(String(contract.raw.userStatus || contract.raw.assignmentStatus || "").toLowerCase()));
  }).map(contract => {
    const own = (workItems as any[]).find(w => w.contract.id === contract.id && String(w.claimedBy?._id || w.claimedBy) === userId && isSentWorkItem(w));
    return { cycleKey: `completed-${stableHash(`${contract.id}:${userId}`)}`, contractId: contract.id, contractNo: contract.contractNo,
      customerName: contract.customerName || "", ...contractContactNames(contract, contract.id), description: contract.description || "",
      eventTitle: contract.eventTitle || "", eventDate: contract.eventDate, eventTime: contract.eventTime, eventClosed: contract.eventClosed,
      reopenUntil: contract.reopenUntil, location: contract.location || "", kind: "unknown" as const, lotCount: 0, pendingLotCount: 0,
      status: "sent" as const, assignedToCurrentUser: true, assignedUser: { id: userId },
      ...(own ? { claimedBy: publicClaimedBy(own.claimedBy), workItemId: String(own._id), selectedReportType: own.selectedReportType as AuctioneerReportType } : {}) };
  });
  const completedIds = new Set(completedRows.map(row => row.contractId));
  return [...liveRows.filter(row => !completedIds.has(row.contractId)), ...frozenRows, ...completedRows];
}

export async function getAuctioneerIncomingSummary(userId: string) {
  const incoming = await listAuctioneerIncoming(false, userId);
  return {
    availableCount: incoming.reduce(
      (count, item) => count + (item.status === "available" ? 1 : 0),
      0
    ),
  };
}

function findIncomingCycle(
  source: IncomingSource,
  requestedCycleKey: string
): {
  contract: NormalizedContract;
  tasks: NormalizedTask[];
  kind: "scheduleA" | "unknown";
  source: "proposalContract" | "task";
} | null {
  for (const cycle of buildIncomingCycles(source)) {
    if (cycle.cycleKey !== requestedCycleKey) continue;
    return {
      contract: cycle.contract,
      tasks: cycle.tasks,
      kind: cycle.kind,
      source: cycle.source,
    };
  }
  return null;
}

// Capture the provider data used to create the report. Delivery later re-reads remote
// state, but setup must remain reproducible even if the incoming task disappears.
async function hydrateSourceLots(
  contract: NormalizedContract,
  tasks: NormalizedTask[]
): Promise<IAuctioneerSourceLot[]> {
  let contractLots: Auctioneer2Record[] = [];
  if (!tasks.length) {
    // A genuine empty response represents an unknown-lot contract. A provider
    // failure is different: abort the claim instead of freezing a fabricated
    // blank lot into the immutable work-item snapshot.
    contractLots = await getContractLots(contract.id);
  }
  const detailedLots = new Map<string, Auctioneer2Record>();
  const contractLotIds = contractLots
    .map((raw) =>
      textValue(raw, [
        "rowGuid",
        "row_guid",
        "lotRowGuid",
        "lot_row_guid",
        "id",
        "lotId",
        "lot_id",
      ])
    )
    .filter((id): id is string => Boolean(id));
  await Promise.all(
    [
      ...tasks
        .filter(
          (task): task is NormalizedTask & { lotId: string } =>
            Boolean(task.lotId)
        )
        .map((task) => task.lotId),
      ...contractLotIds,
    ].map(async (lotId) => {
        try {
          detailedLots.set(lotId, await getLot(lotId));
        } catch {
          // The immutable task snapshot is still sufficient to start the form;
          // delivery will re-read authoritative lot state.
        }
      })
  );

  // Check each original response before merging: a correct detail must not hide
  // a foreign summary (or vice versa) when it supplies the missing event.
  for (const raw of [...tasks.map((task) => task.raw), ...contractLots, ...detailedLots.values()]) {
    assertEventContractContext(raw, contract.id);
  }

  const sources: Array<{
    raw: Auctioneer2Record;
    lotId?: string;
    submissionId?: string;
    discriminator: string;
  }> = tasks.length
    ? tasks.map((task, index) => ({
        raw: {
          ...task.raw,
          ...(task.embeddedLot || {}),
          ...(task.lotId ? detailedLots.get(task.lotId) || {} : {}),
          ...(Array.isArray((task.raw as any)?.services)
            ? { services: (task.raw as any).services }
            : {}),
          ...(Array.isArray((task.raw as any)?.submission?.selectedServices)
            ? {
                selectedServices: (task.raw as any).submission.selectedServices,
              }
            : {}),
        },
        lotId: task.lotId,
        submissionId: task.submissionId,
        discriminator: task.submissionId || task.lotId || task.id || String(index),
      }))
    : contractLots.map((raw, index) => {
        const lotId = textValue(raw, [
          "rowGuid",
          "row_guid",
          "lotRowGuid",
          "lot_row_guid",
          "id",
          "lotId",
          "lot_id",
        ]);
        const detail = lotId ? detailedLots.get(lotId) : undefined;
        const eventId = reconcileEventIdentity([raw, detail]);
        return {
          raw: { ...(detail || raw), ...(eventId !== undefined ? { eventId } : {}) },
          lotId,
          submissionId: textValue(raw, [
            "submissionId",
            "submission_id",
            "submissionGuid",
            "submission_guid",
          ]),
          discriminator: lotId || String(index),
        };
      });

  if (!sources.length) {
    sources.push({ raw: {}, discriminator: "unknown-0" });
  }
  return sources.map((source) => {
    const sourceKey = stableHash(
      `${contract.id}:${source.submissionId || ""}:${source.lotId || ""}:${source.discriminator}`
    ).slice(0, 24);
    return normalizeAuctioneer2Lot(source.raw, {
      sourceKey,
      lotId: source.lotId,
      submissionId: source.submissionId,
    });
  });
}

function claimPayload(workItem: IAuctioneerWorkItem) {
  return {
    workItemId: String(workItem._id),
    cycleKey: workItem.cycleKey,
    kind: workItem.kind,
    reportType: workItem.selectedReportType,
    clientSubmissionId: workItem.clientSubmissionId,
    status: "claimed" as const,
  };
}

async function findBlockingAuctioneerWorkItem(
  contractId: string,
  canonicalCycleKey: string,
  contractLevel: boolean
) {
  const candidates = await AuctioneerWorkItem.find({
    "contract.id": contractId,
    $or: [
      { status: { $in: ["claimed", "report_created", "sent"] } },
      { "delivery.status": "sent" },
    ],
  }).lean();
  if (contractLevel) return candidates[0];
  return candidates.find(
    (workItem: any) =>
      String(workItem.cycleKey) === canonicalCycleKey ||
      snapshotTaskCycleKeys(workItem).includes(canonicalCycleKey)
  );
}

// `cycleKey` and `activeContractKey` are uniqueness guards in MongoDB. The pre-read gives
// friendly errors; duplicate-key recovery below is the authoritative race resolution.
export async function claimAuctioneerIncoming(
  cycleKey: string,
  userId: string,
  reportType: AuctioneerReportType
) {
  if (!["asset", "lotListing"].includes(reportType)) {
    throw new Auctioneer2ServiceError(
      "Report type must be asset or lotListing.",
      400,
      "invalid_report_type"
    );
  }
  if (!Types.ObjectId.isValid(userId)) {
    throw new Auctioneer2ServiceError("The authenticated user is invalid.", 401, "invalid_user");
  }
  const assignableUser = await User.exists({
    _id: userId,
    role: "user",
    isVerified: true,
    isBlocked: { $ne: true },
  });
  if (!assignableUser) {
    throw new Auctioneer2ServiceError(
      "The assigned Asset Insight user is no longer available.",
      409,
      "auctioneer_assignee_unavailable"
    );
  }

  const existing = await AuctioneerWorkItem.findOne({ cycleKey });
  if (existing && String(existing.claimedBy) === userId) {
    if (existing.contractAccessRevision !== undefined) await assertAuctioneerContractSendOpen(existing.contract.id, userId, existing.contractAccessRevision);
    if (
      !["claimed", "report_created"].includes(existing.status) ||
      existing.delivery?.status === "sent" ||
      !existing.activeContractKey
    ) {
      throw new Auctioneer2ServiceError(
        "This Auctioneer work item has already been sent and cannot be claimed again.",
        409,
        "auctioneer_work_item_closed"
      );
    }
    if (existing.selectedReportType !== reportType) {
      throw new Auctioneer2ServiceError(
        "The report type is already locked for this incoming contract.",
        409,
        "auctioneer_report_type_locked"
      );
    }
    return claimPayload(existing);
  }

  const source = await loadIncomingSource(userId, true);
  const reopenState = await AuctioneerContractClose.findOne({ user: userId, status: "open", reopenCycleKey: cycleKey }).lean();
  if (reopenState) return withAuctioneerContractOperation(reopenState.contractId, userId, async lease => {
    await assertAuctioneerContractSendOpen(reopenState.contractId, userId, reopenState.accessRevision);
    const currentContracts = validateAssignedContracts(await listIncomingContracts(userId, true), userId);
    const contract = currentContracts.map(normalizeAuctioneer2Contract).find(c => c && c.id === reopenState.contractId &&
      userIdsMatch(String(c.assignedUserId || ""), userId));
    if (!contract) throw new Auctioneer2ServiceError("This contract is no longer assigned to you. Refresh Incoming.", 409, "auctioneer_continuation_assignment_unavailable");
    assertEventContractContext(contract.raw, contract.id, true);
    await lease.assertOwned();
    const saved = await AuctioneerWorkItem.findOne({ cycleKey });
    if (saved) {
      if (String(saved.claimedBy) !== userId || saved.selectedReportType !== reportType || saved.contractAccessRevision !== reopenState.accessRevision ||
          saved.status !== "claimed" || saved.linkedReportId) throw new Auctioneer2ServiceError("This capture has already started. Refresh Incoming to open its current report.", 409, "auctioneer_work_item_closed");
      return claimPayload(saved);
    }
    const created = await AuctioneerWorkItem.create({ source: "auctioneer2", cycleKey,
      activeContractKey: auctioneer2ActiveContractKey(contract.id, userId, cycleKey), assignmentUserId: userId,
      contractAccessRevision: reopenState.accessRevision, contract, kind: "unknown",
      snapshot: { contract: contract.raw, event: { id: contract.eventId, title: contract.eventTitle, date: contract.eventDate },
        customer: { name: contract.customerName }, tasks: [], lots: [], capturedAt: new Date() },
      claimedBy: userId, claimedAt: new Date(), selectedReportType: reportType,
      clientSubmissionId: `auctioneer2-${stableHash(`${cycleKey}:${reportType}`).slice(0, 40)}`, status: "claimed",
      delivery: { status: "not_ready", completeContract: false, attempts: 0, lots: [], reconciliation: { required: false } } });
    return claimPayload(created);
  });
  const cycle = findIncomingCycle(source, cycleKey);
  if (!cycle) {
    throw new Auctioneer2ServiceError(
      "This incoming contract is no longer available.",
      404,
      "auctioneer_incoming_not_found"
    );
  }
  if (existing) {
    throw new Auctioneer2ServiceError(
      "This incoming contract is already claimed.",
      409,
      "auctioneer_already_claimed"
    );
  }
  return withAuctioneerContractOperation(cycle.contract.id, userId, async lease => {
  // An old cycle cannot hydrate the original lots after its report was deleted
  // or its user's part was closed/reopened. Serialize this admission with close.
  await assertAuctioneerContractSendOpen(cycle.contract.id, userId);
  const blockingWorkItem = await findBlockingAuctioneerWorkItem(
    cycle.contract.id,
    cycleKey,
    cycle.source === "proposalContract"
  );
  if (blockingWorkItem) {
    if (String(blockingWorkItem.cycleKey) === cycleKey && String(blockingWorkItem.claimedBy) === userId &&
        blockingWorkItem.activeContractKey && ["claimed", "report_created"].includes(blockingWorkItem.status) &&
        blockingWorkItem.delivery?.status !== "sent") {
      if (blockingWorkItem.selectedReportType !== reportType) throw new Auctioneer2ServiceError(
        "The report type is already locked for this incoming contract.", 409, "auctioneer_report_type_locked");
      return claimPayload(blockingWorkItem as IAuctioneerWorkItem);
    }
    const closed =
      blockingWorkItem.status === "sent" ||
      blockingWorkItem.delivery?.status === "sent";
    throw new Auctioneer2ServiceError(
      closed
        ? "This Auctioneer work item has already been sent and cannot be claimed again."
        : cycle.source === "proposalContract"
          ? "This incoming contract is already covered by an existing Auctioneer work item."
          : "This incoming lot is already covered by an existing Auctioneer work item.",
      409,
      closed ? "auctioneer_work_item_closed" : "auctioneer_already_claimed"
    );
  }
  assertEventContractContext(cycle.contract.raw, cycle.contract.id, true);
  const lots = await hydrateSourceLots(cycle.contract, cycle.tasks);
  const eventId = reconcileEventIdentity([
    cycle.contract.raw,
    { eventId: cycle.contract.eventId },
    ...cycle.tasks.map((task) => task.raw),
    ...lots.map((lot) => lot.raw),
  ]);
  const clientSubmissionId = `auctioneer2-${stableHash(`${cycleKey}:${reportType}`).slice(0, 40)}`;
  const activeContractKey = auctioneer2ActiveContractKey(
    cycle.contract.id,
    userId,
    cycleKey
  );
  try {
    await lease.assertOwned();
    const created = await AuctioneerWorkItem.create({
      source: "auctioneer2",
      cycleKey,
      activeContractKey,
      assignmentUserId: new Types.ObjectId(userId),
      contract: {
        id: cycle.contract.id,
        contractNo: cycle.contract.contractNo,
        customerName: cycle.contract.customerName,
        description: cycle.contract.description,
        ...contractContactNames(cycle.contract, cycle.contract.id),
        eventId,
        eventTitle: cycle.contract.eventTitle,
        eventDate: cycle.contract.eventDate,
        location: cycle.contract.location,
        categories: cycle.contract.categories,
        hasScheduleA: cycle.contract.hasScheduleA,
        hasUnknownLots: cycle.contract.hasUnknownLots,
      },
      kind: cycle.kind,
      snapshot: {
        contract: cycle.contract.raw,
        event:
          {
            ...(nestedRecord(cycle.contract.raw, ["event"]) || {}),
            ...(eventId !== undefined ? { id: eventId } : {}),
            ...(cycle.contract.eventTitle
              ? { title: cycle.contract.eventTitle }
              : {}),
            ...(cycle.contract.eventDate
              ? { date: cycle.contract.eventDate }
              : {}),
            ...(cycle.contract.location
              ? { location: cycle.contract.location }
              : {}),
          },
        customer:
          nestedRecord(cycle.contract.raw, ["customer", "client", "owner"]) ||
          {
            ...(cycle.contract.customerName
              ? { name: cycle.contract.customerName }
              : {}),
          },
        tasks: cycle.tasks.map((task) => task.raw),
        lots,
        capturedAt: new Date(),
      },
      claimedBy: new Types.ObjectId(userId),
      claimedAt: new Date(),
      selectedReportType: reportType,
      clientSubmissionId,
      status: "claimed",
      delivery: {
        status: "not_ready",
        completeContract: false,
        attempts: 0,
        lots: lots.map((lot) => ({
          sourceKey: lot.sourceKey,
          sourceLotId: lot.lotId,
          sourceSubmissionId: lot.submissionId,
          status: "pending",
        })),
        reconciliation: { required: false },
      },
    });
    return claimPayload(created);
  } catch (error: any) {
    if (error?.code !== 11000) throw error;
    const winner = await AuctioneerWorkItem.findOne({
      $or: [{ cycleKey }, { activeContractKey }],
    });
    if (winner && winner.cycleKey === cycleKey && String(winner.claimedBy) === userId) {
      if (winner.selectedReportType !== reportType) {
        throw new Auctioneer2ServiceError(
          "The report type is already locked for this incoming contract.",
          409,
          "auctioneer_report_type_locked"
        );
      }
      return claimPayload(winner);
    }
    throw new Auctioneer2ServiceError(
      "This incoming contract is already claimed.",
      409,
      "auctioneer_already_claimed"
    );
  }
  });
}

type AuctioneerReportRef = Pick<IAuctioneerWorkItem, "_id" | "linkedReportId" | "selectedReportType" | "clientSubmissionId" | "claimedBy">;

async function loadAuctioneerAcceptanceReport(work: AuctioneerReportRef) {
  // Read only receipt fields, never image arrays or the queued provider payload.
  const projection = {
    status: 1, job_status: 1, job_id: 1, adminArchivedAt: 1, user: 1,
    auctioneerWorkItem: 1, client_submission_id: 1, processing_started_at: 1,
    "report_job_outbox.token": 1, "report_job_outbox.idempotencyKey": 1,
    "report_job_outbox.type": 1, "report_job_outbox.reportId": 1, "report_job_outbox.progressId": 1,
  };
  const report = work.selectedReportType === "asset"
    ? await AssetReport.findById(work.linkedReportId).select(projection).lean()
    : await LotListing.findById(work.linkedReportId).select(projection).lean();
  return report && String(report.user) === String(work.claimedBy) &&
    String(report.auctioneerWorkItem) === String(work._id) &&
    report.client_submission_id === work.clientSubmissionId ? report : null;
}

function hasContinuationAcceptedState(report: { job_id?: unknown; status?: unknown; job_status?: unknown }): boolean {
  return Boolean(report.job_id)
    && ["processing", "preview", "pending_approval", "approved", "declined", "completed", "error"].includes(String(report.status))
    && ["queued", "processing", "done", "error"].includes(String(report.job_status));
}

async function hasAcceptedAuctioneerJob(
  report: { job_id?: unknown; report_job_outbox?: unknown },
  work: AuctioneerReportRef,
) {
  const jobTypes = work.selectedReportType === "asset"
    ? ["asset-preview", "asset-preview-files", "asset-excel-cr-files"]
    : ["lot-listing-preview", "lot-listing-files", "lot-listing-excel-cr-files"];
  const outbox = report.report_job_outbox;
  if (isRecord(outbox) && Boolean(outbox.token && outbox.idempotencyKey) &&
      outbox.reportId === String(work.linkedReportId) && outbox.progressId === report.job_id &&
      jobTypes.includes(String(outbox.type))) return true;
  return Boolean(await ReportJob.exists({
    type: { $in: jobTypes }, reportId: String(work.linkedReportId), progressId: String(report.job_id || ""),
  }));
}

async function canResumeAuctioneerUpload(work: AuctioneerReportRef) {
  const report = await loadAuctioneerAcceptanceReport(work);
  if (!report || report.adminArchivedAt || report.processing_started_at || !report.job_id ||
      !["processing", "error"].includes(report.status) ||
      !["uploading", "error"].includes(String(report.job_status)) ||
      await hasAcceptedAuctioneerJob(report, work)) return false;
  // A legacy worker may have lost its job receipt, but a saved preview must
  // still open for review, never resume capture as an unaccepted placeholder.
  const filter = { _id: work.linkedReportId, "preview_data.lots.0": { $exists: true } };
  const hasPreview = work.selectedReportType === "asset"
    ? await AssetReport.exists(filter) : await LotListing.exists(filter);
  return !hasPreview;
}

/**
 * Explicitly continue an assigned contract AFTER upload/analysis acceptance.
 * One deterministic successor per work item/report retains exact retry identity;
 * it never resubmits, modifies or waits for the preceding report's paid analysis.
 */
export async function continueAuctioneerWorkItem(
  workItemId: string,
  userId: string,
  input: unknown
) {
  const owner = Types.ObjectId.isValid(workItemId) ? await AuctioneerWorkItem.findOne({ _id: workItemId, claimedBy: userId }).select("contract.id").lean() : null;
  if (!owner) throw new Auctioneer2ServiceError("Work item not found.", 404, "work_item_not_found");
  return withAuctioneerContractOperation(owner.contract.id, userId, lease => continueAuctioneerWorkItemLocked(workItemId, userId, input, lease));
}

async function continueAuctioneerWorkItemLocked(workItemId: string, userId: string, input: unknown, lease: ReportSubmissionAdmissionLease) {
  if (!isRecord(input) || Object.keys(input).some((key) => key !== "reportId") ||
      typeof input.reportId !== "string" || !Types.ObjectId.isValid(input.reportId)) {
    throw new Auctioneer2ServiceError(
      "Provide the accepted reportId only.", 400, "invalid_continuation_request"
    );
  }
  if (!Types.ObjectId.isValid(workItemId) || !Types.ObjectId.isValid(userId)) {
    throw new Auctioneer2ServiceError("Work item not found.", 404, "work_item_not_found");
  }
  const parent = await AuctioneerWorkItem.findOne({ _id: workItemId, claimedBy: userId }).select("+queuedContinuation").lean();
  if (!parent) {
    throw new Auctioneer2ServiceError("Work item not found.", 404, "work_item_not_found");
  }
  if (!["report_created", "sent"].includes(parent.status) ||
      String(parent.linkedReportId || "") !== input.reportId ||
      String(parent.assignmentUserId || "") !== userId) {
    throw new Auctioneer2ServiceError(
      "Submit this assigned contract's current report before starting new lots.",
      409, "auctioneer_continuation_not_ready"
    );
  }
  const report = await loadAuctioneerAcceptanceReport(parent);
  if (!report || report.adminArchivedAt) {
    throw new Auctioneer2ServiceError("The accepted report is unavailable for continuation.", 409, "auctioneer_continuation_not_ready");
  }
  if (parent.queuedContinuation) {
    // A reserved successor is not acceptance evidence for this legacy route.
    if (!hasContinuationAcceptedState(report) || ((report.status === "error" || report.job_status === "error") && !await hasAcceptedAuctioneerJob(report, parent))) {
      throw new Auctioneer2ServiceError("Wait for this upload's confirmed acceptance before using report continuation.", 409, "auctioneer_continuation_not_ready");
    }
    const result = await materializeQueuedContinuation(parent, userId, lease);
    return { created: result.created, setup: result.setup };
  }
  const cycleKey = stableHash(`continuation:${String(parent._id)}:${input.reportId}`);
  const existing = await AuctioneerWorkItem.findOne({ cycleKey, claimedBy: userId }).lean();
  // The successor itself is a durable receipt of prior acceptance. Replaying
  // this read must still work after that accepted job fails or is pruned.
  if (existing) {
    return { created: false, setup: await getAuctioneerWorkItemSetup(String(existing._id), userId) };
  }
  // Upload-session placeholders link early with job_status=uploading. A link by
  // itself is NOT server acceptance and must never clear the current capture.
  if (!hasContinuationAcceptedState(report)) {
    throw new Auctioneer2ServiceError(
      "Wait until the current upload has been accepted before starting new lots.",
      409, "auctioneer_continuation_not_ready"
    );
  }
  if (report.status === "error" || report.job_status === "error") {
    // Queue insertion can fail after a placeholder was linked and assigned a
    // job_id. Generic error/error is not acceptance. A matching durable intent
    // or job proves this report entered the workflow, even if analysis failed.
    if (!await hasAcceptedAuctioneerJob(report, parent)) {
      throw new Auctioneer2ServiceError(
        "The upload has no accepted processing receipt. Retry its original submission before starting new lots.",
        409, "auctioneer_continuation_not_ready"
      );
    }
  }

  const contract = await freshContinuationContract(parent, userId);
  await assertAuctioneerContractSendOpen(parent.contract.id, userId, parent.contractAccessRevision);
  await lease.assertOwned();
  // Provider reads can take time. Recheck local authority immediately before a
  // new child is persisted, without fencing ordinary worker progress/updatedAt.
  const [currentParent, currentReport, currentUser] = await Promise.all([
    AuctioneerWorkItem.exists({
      _id: parent._id, source: parent.source, claimedBy: userId, assignmentUserId: userId,
      linkedReportId: parent.linkedReportId, linkedReportModel: parent.linkedReportModel,
      selectedReportType: parent.selectedReportType, clientSubmissionId: parent.clientSubmissionId,
      "contract.id": parent.contract.id, status: { $in: ["report_created", "sent"] },
    }),
    loadAuctioneerAcceptanceReport(parent),
    User.exists({ _id: userId, role: "user", isVerified: true, isBlocked: { $ne: true } }),
  ]);
  if (!currentUser) throw new Auctioneer2ServiceError("The assigned user is no longer available.", 409, "auctioneer_assignee_unavailable");
  if (!currentParent || !currentReport || currentReport.adminArchivedAt || !hasContinuationAcceptedState(currentReport)
      || ((currentReport.status === "error" || currentReport.job_status === "error") && !await hasAcceptedAuctioneerJob(currentReport, parent))) {
    throw new Auctioneer2ServiceError("The accepted report is unavailable for continuation.", 409, "auctioneer_continuation_not_ready");
  }
  return createContinuationChild(parent, contract, cycleKey, userId);
}

async function freshContinuationContract(parent: any, userId: string) {
  const assignableUser = await User.exists({ _id: userId, role: "user", isVerified: true, isBlocked: { $ne: true } });
  if (!assignableUser) {
    throw new Auctioneer2ServiceError("The assigned user is no longer available.", 409, "auctioneer_assignee_unavailable");
  }
  // A frozen lot-level assignment must not grant perpetual permission to create
  // other lots. New work requires a freshly confirmed Incoming assignment.
  // Do not join an Incoming read that began before this accepted handoff: even a
  // forced shared read can contain an assignment that was since removed/restored.
  const currentContracts = validateAssignedContracts(await listIncomingContracts(userId), userId);
  let live = currentContracts.map(normalizeAuctioneer2Contract).find(
    (contract) => contract && isIncomingProposalContract(contract) && contract.id === parent.contract.id &&
      userIdsMatch(String(contract.assignedUserId || ""), userId)
  );
  if (!live) {
    // Incoming also admits assigned Operations tasks, not only Proposals.
    // Check that same live authority using an independent, contract-scoped read.
    // Do not authorize from the old snapshot or from contract-number coincidence.
    const tasks = validateAssignedTasks(await listIncomingTasks(userId, parent.contract.id), userId)
      .map(normalizeTask)
      .filter((task) => task.contractId === parent.contract.id &&
        userIdsMatch(String(task.assignedUserId || ""), userId));
    if (tasks.length) {
      const eventId = reconcileEventIdentity(tasks.map((task) => task.raw));
      live = { ...parent.contract, assignedUserId: userId, eventId, raw: { id: parent.contract.id } };
    }
  }
  if (!live) {
    throw new Auctioneer2ServiceError(
      "This contract is no longer assigned to you in Incoming. Your accepted report is unchanged.",
      409, "auctioneer_continuation_assignment_unavailable"
    );
  }
  const canonicalParentEventId = normalizeAuctioneerEventId(parent.contract.eventId);
  let parentEventId = canonicalParentEventId;
  if (parentEventId === undefined) {
    // Legacy imports can have a saved event without the canonical projection.
    // Reconcile that frozen evidence before accepting fresh metadata for a new
    // child; never rewrite the accepted parent or an already-created successor.
    const savedSources = [
      parent.snapshot?.contract, parent.snapshot?.event,
      ...(parent.snapshot?.tasks || []),
      ...(parent.snapshot?.lots?.map((lot: IAuctioneerSourceLot) => lot.raw) || []),
    ];
    assertEventContractContext(live.raw, parent.contract.id, true);
    assertEventContractContext(parent.snapshot?.contract, parent.contract.id, true);
    for (const source of savedSources) assertEventContractContext(source, parent.contract.id);
    parentEventId = reconcileEventIdentity(savedSources, [parent.snapshot?.event]);
  }
  if (live.eventId !== undefined && parentEventId !== undefined && live.eventId !== parentEventId) {
    throw new Auctioneer2ServiceError(
      "The auction event changed. Refresh Incoming before starting more lots.",
      409, "auctioneer_continuation_event_changed"
    );
  }
  const contract = { ...parent.contract, ...savedContractContactNames(parent) };
  if (canonicalParentEventId === undefined && (parentEventId ?? live.eventId) !== undefined) {
    contract.eventId = parentEventId ?? live.eventId;
  }
  return contract;
}

async function createContinuationChild(parent: any, contract: any, cycleKey: string, userId: string) {
  let created = true;
  let successor;
  try {
    successor = await AuctioneerWorkItem.create({
      // An unused claim can be released. Retrying this exact continuation must
      // still recover its original identity, including any saved local draft.
      _id: new Types.ObjectId(stableHash(`continuation-work-item:${cycleKey}`).slice(0, 24)),
      source: "auctioneer2", cycleKey,
      activeContractKey: auctioneer2ActiveContractKey(contract.id, userId, cycleKey),
      assignmentUserId: parent.assignmentUserId,
      contractAccessRevision: parent.contractAccessRevision,
      continuationOfWorkItemId: parent._id,
      contract, kind: "unknown",
      snapshot: {
        contract,
        event: { id: contract.eventId, title: contract.eventTitle, date: contract.eventDate, location: contract.location },
        customer: { name: contract.customerName },
        tasks: [], lots: [], capturedAt: new Date(),
      },
      claimedBy: parent.claimedBy, claimedAt: new Date(),
      selectedReportType: parent.selectedReportType,
      clientSubmissionId: `auctioneer2-${stableHash(`${cycleKey}:${parent.selectedReportType}`).slice(0, 40)}`,
      status: "claimed",
      delivery: { status: "not_ready", completeContract: false, attempts: 0, lots: [], reconciliation: { required: false } },
    });
  } catch (error: any) {
    if (error?.code !== 11000) throw error;
    successor = await AuctioneerWorkItem.findOne({ cycleKey, claimedBy: userId });
    if (!successor) throw error;
    created = false;
  }
  clearAuctioneer2IncomingCache(userId);
  return { created, setup: await getAuctioneerWorkItemSetup(String(successor._id), userId) };
}

function continuationUnavailable(message = "This saved upload cannot reserve more lots. Keep it and retry the same continuation."): never {
  throw new Auctioneer2ServiceError(message, 409, "auctioneer_upload_continuation_unavailable");
}

async function continuationSession(parent: any, userId: string, sessionId: string) {
  const session = await ReportUploadSession.findOne({ _id: sessionId, user: userId, type: parent.selectedReportType }).lean();
  if (!session || session.smartUpload || session.cleanupStartedAt || session.details?.draft_preview ||
      session.clientSubmissionId !== parent.clientSubmissionId || session.details?.auctioneer_work_item_id !== String(parent._id) ||
      !session.manifestHash || !session.capture_id ||
      (parent.linkedReportId && String(parent.linkedReportId) !== String(session.reportId || ""))) continuationUnavailable();
  if (session.reportId) {
    const report = await loadAuctioneerAcceptanceReport({ ...parent, linkedReportId: session.reportId });
    if (!report || report.adminArchivedAt) continuationUnavailable("The original report is unavailable. Its saved upload and continuation are retained.");
  }
  return session;
}

/** The parent intent is the singleton reservation authority; the session CAS
 * freezes edits without altering the native grant's details/manifest hash.
 * Interrupted writes recover forward using these same identities, never expire. */
async function materializeQueuedContinuation(parent: any, userId: string, lease: ReportSubmissionAdmissionLease,
  checked?: { contract: any; req: AuthRequest }) {
  const intent = parent.queuedContinuation;
  if (!intent?.id || !Types.ObjectId.isValid(intent.sessionId)) continuationUnavailable();
  let session = await continuationSession(parent, userId, intent.sessionId);
  if (reportTransferSnapshotHash(session) !== intent.snapshotHash) continuationUnavailable("The queued upload snapshot changed. Keep the original queued capture; no new lots were created.");
  let existing = await AuctioneerWorkItem.findOne({ cycleKey: intent.cycleKey, claimedBy: userId }).lean();
  if (existing && (String(existing._id) !== intent.successorWorkItemId || String(existing.continuationOfWorkItemId) !== String(parent._id) || existing.selectedReportType !== parent.selectedReportType)) continuationUnavailable();
  // Used successor is a navigation receipt, never permission for a blank form.
  // An editable/recreated successor needs fresh assignment and an open contract.
  if (!existing || (existing.status === "claimed" && !existing.linkedReportId)) {
    await assertAuctioneerContractSendOpen(parent.contract.id, userId, parent.contractAccessRevision);
    const currentContract = checked?.contract || await freshContinuationContract(parent, userId);
    if (intent.contract.eventId && currentContract.eventId && intent.contract.eventId !== currentContract.eventId) {
      throw new Auctioneer2ServiceError("The auction event changed. The queued capture is unchanged.", 409, "auctioneer_continuation_event_changed");
    }
  }
  if (checked) await verifyForegroundTransferDevice(checked.req);
  const currentParent = await AuctioneerWorkItem.exists({ _id: parent._id, claimedBy: userId, assignmentUserId: userId,
    selectedReportType: parent.selectedReportType, clientSubmissionId: parent.clientSubmissionId, "contract.id": parent.contract.id,
    "queuedContinuation.id": intent.id, status: { $in: ["claimed", "report_created", "sent"] } });
  if (!currentParent || !await User.exists({ _id: userId, role: "user", isVerified: true, isBlocked: { $ne: true } })) continuationUnavailable();
  // Re-read after the provider/device calls; normal upload progress is allowed.
  session = await continuationSession(await AuctioneerWorkItem.findById(parent._id).select("+queuedContinuation").lean(), userId, intent.sessionId);
  if (reportTransferSnapshotHash(session) !== intent.snapshotHash) continuationUnavailable();
  if (session.continuationFreeze) {
    if (session.continuationFreeze.reservationId !== intent.id || session.continuationFreeze.snapshotHash !== intent.snapshotHash) continuationUnavailable();
  } else {
    await lease.assertOwned();
    const frozen = await ReportUploadSession.updateOne({ _id: session._id, user: userId, updatedAt: (session as any).updatedAt,
      cleanupStartedAt: { $exists: false }, continuationFreeze: { $exists: false } },
    { $set: { continuationFreeze: { reservationId: intent.id, workItemId: String(parent._id), snapshotHash: intent.snapshotHash } } });
    if (frozen.matchedCount !== 1) throw new Auctioneer2ServiceError("Upload progress changed while reserving. Retry this same next-lot request.", 409, "auctioneer_upload_continuation_pending");
  }
  await lease.assertOwned();
  const result = existing ? { created: false, setup: await getAuctioneerWorkItemSetup(String(existing._id), userId) }
    : await createContinuationChild(parent, intent.contract, intent.cycleKey, userId);
  await AuctioneerWorkItem.updateOne({ _id: parent._id, "queuedContinuation.id": intent.id }, { $set: { "queuedContinuation.state": "reserved" } });
  return { ...result, reservation: { id: intent.id, status: "reserved" as const, ownerId: userId,
    parentWorkItemId: String(parent._id), parentSessionId: intent.sessionId, parentClientSubmissionId: parent.clientSubmissionId,
    parentCaptureId: intent.captureId, successorWorkItemId: intent.successorWorkItemId } };
}

export async function continueQueuedAuctioneerUpload(workItemId: string, req: AuthRequest) {
  const userId = String(req.userId || ""), input = req.body;
  if (!isRecord(input) || Object.keys(input).some(key => key !== "sessionId") || typeof input.sessionId !== "string" || !Types.ObjectId.isValid(input.sessionId)) {
    throw new Auctioneer2ServiceError("Provide the exact queued upload sessionId only.", 400, "invalid_upload_continuation_request");
  }
  const sessionId = input.sessionId;
  const device = await verifyForegroundTransferDevice(req);
  const parent = Types.ObjectId.isValid(workItemId) ? await AuctioneerWorkItem.findOne({ _id: workItemId, claimedBy: userId }).lean() : null;
  if (!parent) throw new Auctioneer2ServiceError("Work item not found.", 404, "work_item_not_found");
  return withAuctioneerContractOperation(parent.contract.id, userId, async lease => {
    const current = await AuctioneerWorkItem.findOne({ _id: workItemId, claimedBy: userId, assignmentUserId: userId,
      status: { $in: ["claimed", "report_created", "sent"] } }).select("+queuedContinuation").lean();
    if (!current) continuationUnavailable();
    if (current.queuedContinuation) {
      if (current.queuedContinuation.sessionId !== sessionId) continuationUnavailable("This parent already reserved its next capture using another upload identity.");
      // Durable receipt recovery uses current bearer/device authority, never the
      // old raw grant; pause, rotation and expiry do not invent another child.
      return materializeQueuedContinuation(current, userId, lease, { req, contract: undefined });
    }
    let session = await continuationSession(current, userId, sessionId);
    if (!await hasCurrentTransferGrant(session, device, userId)) throw new Auctioneer2ServiceError(
      "Queue this exact capture on the approved device before starting more lots.", 409, "auctioneer_upload_transfer_required");
    await assertAuctioneerContractSendOpen(current.contract.id, userId, current.contractAccessRevision);
    const contract = await freshContinuationContract(current, userId);
    const refreshedDevice = await verifyForegroundTransferDevice(req);
    const latest = await AuctioneerWorkItem.findOne({ _id: current._id, claimedBy: userId, assignmentUserId: userId,
      selectedReportType: current.selectedReportType, clientSubmissionId: current.clientSubmissionId,
      "contract.id": current.contract.id, status: { $in: ["claimed", "report_created", "sent"] } }).lean();
    if (!latest) continuationUnavailable();
    session = await continuationSession(latest, userId, sessionId);
    if (!await hasCurrentTransferGrant(session, refreshedDevice, userId)) continuationUnavailable("Upload authorization changed. Reopen the queued capture before retrying next lot.");
    const children = await AuctioneerWorkItem.find({ continuationOfWorkItemId: current._id, claimedBy: userId }).limit(2).lean();
    if (children.length > 1) continuationUnavailable("This parent has conflicting continuation history. Keep the queued capture and ask support to review it.");
    // Preserve old accepted-continuation identities even after an unused child
    // was released. A pending upload has no reportId and uses its frozen submit ID.
    const cycleKey = children[0]?.cycleKey || stableHash(session.reportId ? `continuation:${current._id}:${session.reportId}` : `upload-continuation:${current._id}:${current.clientSubmissionId}`);
    const intent = { id: stableHash(`continuation-reservation:${current._id}:${current.clientSubmissionId}`), state: "pending",
      sessionId: String(session._id), snapshotHash: reportTransferSnapshotHash(session), captureId: session.capture_id,
      deviceId: String(refreshedDevice._id), cycleKey, contract: children[0]?.contract || contract,
      successorWorkItemId: String(children[0]?._id || new Types.ObjectId(stableHash(`continuation-work-item:${cycleKey}`).slice(0, 24))), reservedAt: new Date() };
    await lease.assertOwned();
    const pinned = await AuctioneerWorkItem.findOneAndUpdate({ _id: current._id, claimedBy: userId, assignmentUserId: userId,
      clientSubmissionId: current.clientSubmissionId, queuedContinuation: { $exists: false }, status: { $in: ["claimed", "report_created", "sent"] } },
    { $set: { queuedContinuation: intent } }, { returnDocument: "after" }).select("+queuedContinuation").lean();
    if (!pinned) throw new Auctioneer2ServiceError("Another continuation is being reserved. Retry this same request.", 409, "auctioneer_upload_continuation_pending");
    return materializeQueuedContinuation(pinned, userId, lease, { req, contract });
  });
}

export async function getAuctioneerWorkItemSetup(workItemId: string, userId: string) {
  if (!Types.ObjectId.isValid(workItemId)) {
    throw new Auctioneer2ServiceError("Work item not found.", 404, "work_item_not_found");
  }
  const workItem = await AuctioneerWorkItem.findOne({
    _id: workItemId,
    claimedBy: userId,
  }).lean();
  if (!workItem) {
    throw new Auctioneer2ServiceError("Work item not found.", 404, "work_item_not_found");
  }
  return {
    workItemId: String(workItem._id),
    cycleKey: workItem.cycleKey,
    kind: workItem.kind,
    reportType: workItem.selectedReportType,
    clientSubmissionId: workItem.clientSubmissionId,
    status: workItem.status,
    reportId: workItem.linkedReportId ? String(workItem.linkedReportId) : null,
    canResumeUpload: workItem.status === "report_created" && Boolean(workItem.linkedReportId)
      ? await canResumeAuctioneerUpload(workItem) : false,
    ...(workItem.continuationOfWorkItemId
      ? { continuationOfWorkItemId: String(workItem.continuationOfWorkItemId) }
      : {}),
    contract: {
      id: workItem.contract.id,
      contractNo: workItem.contract.contractNo,
      ...(workItem.contract.customerName
        ? { customerName: workItem.contract.customerName }
        : {}),
      ...(workItem.contract.description ? { description: workItem.contract.description } : {}),
      ...savedContractContactNames(workItem),
      ...(workItem.contract.eventId ? { eventId: workItem.contract.eventId } : {}),
      ...(workItem.contract.eventTitle ? { eventTitle: workItem.contract.eventTitle } : {}),
      ...(workItem.contract.eventDate ? { eventDate: workItem.contract.eventDate } : {}),
      ...(workItem.contract.location ? { location: workItem.contract.location } : {}),
      ...(workItem.contract.categories
        ? { categories: workItem.contract.categories }
        : {}),
    },
    lots: workItem.snapshot.lots.map((lot) => ({
      sourceKey: lot.sourceKey,
      ...(lot.lotId ? { lotId: lot.lotId } : {}),
      ...(lot.submissionId ? { submissionId: lot.submissionId } : {}),
      ...(lot.lotNumber !== undefined ? { lotNumber: lot.lotNumber } : {}),
      ...(lot.title ? { title: lot.title } : {}),
      ...(lot.description ? { description: lot.description } : {}),
      ...(lot.details ? { details: lot.details } : {}),
      ...(lot.categories ? { categories: lot.categories } : {}),
      ...(lot.serialNumber ? { serialNumber: lot.serialNumber } : {}),
      ...(lot.make ? { make: lot.make } : {}),
      ...(lot.model ? { model: lot.model } : {}),
      ...(lot.year !== undefined ? { year: lot.year } : {}),
      ...(lot.conditionReport ? { conditionReport: lot.conditionReport } : {}),
      ...(lot.services?.length
        ? {
            services: lot.services
              .map((service) =>
                textValue(service, [
                  "name",
                  "title",
                  "serviceName",
                  "service_name",
                  "code",
                ])
              )
              .filter((service): service is string => Boolean(service)),
          }
        : {}),
      ...(lot.sourcePhotos?.length
        ? { sourcePhotoCount: lot.sourcePhotos.length }
        : {}),
    })),
  };
}

export async function releaseAuctioneerClaim(workItemId: string, userId: string) {
  if (!Types.ObjectId.isValid(workItemId)) {
    throw new Auctioneer2ServiceError("Work item not found.", 404, "work_item_not_found");
  }
  const released = await AuctioneerWorkItem.findOneAndDelete({
    _id: workItemId,
    claimedBy: userId,
    status: "claimed",
    linkedReportId: { $exists: false },
    queuedContinuation: { $exists: false },
  });
  if (!released) {
    const exists = await AuctioneerWorkItem.exists({ _id: workItemId, claimedBy: userId });
    throw new Auctioneer2ServiceError(
      exists
        ? "A claim cannot be released after its report has been created."
        : "Work item not found.",
      exists ? 409 : 404,
      exists ? "auctioneer_claim_locked" : "work_item_not_found"
    );
  }
  clearAuctioneer2IncomingCache(userId);
  return { released: true as const, workItemId };
}

export async function resolveAuctioneerWorkItemForSubmission(input: {
  workItemId: string;
  userId: string;
  reportType: AuctioneerReportType;
}) {
  if (!Types.ObjectId.isValid(input.workItemId)) {
    throw new Auctioneer2ServiceError("Work item not found.", 404, "work_item_not_found");
  }
  const workItem = await AuctioneerWorkItem.findOne({
    _id: input.workItemId,
    claimedBy: input.userId,
  });
  if (!workItem) {
    throw new Auctioneer2ServiceError("Work item not found.", 404, "work_item_not_found");
  }
  if (workItem.selectedReportType !== input.reportType) {
    throw new Auctioneer2ServiceError(
      "This work item is linked to a different report type.",
      409,
      "auctioneer_report_type_mismatch"
    );
  }
  if (workItem.status !== "claimed" && workItem.status !== "report_created") {
    throw new Auctioneer2ServiceError(
      "This work item is no longer available for report creation.",
      409,
      "auctioneer_work_item_closed"
    );
  }
  return workItem;
}

export async function linkAuctioneerWorkItemToReport(input: {
  workItemId: string;
  userId: string;
  reportType: AuctioneerReportType;
  reportId: string;
}) {
  if (!Types.ObjectId.isValid(input.reportId)) {
    throw new Auctioneer2ServiceError("The linked report is invalid.", 400, "invalid_report_id");
  }
  const workItem = await resolveAuctioneerWorkItemForSubmission(input);
  if (workItem.linkedReportId) {
    if (String(workItem.linkedReportId) !== input.reportId) {
      throw new Auctioneer2ServiceError(
        "This incoming contract already has a report.",
        409,
        "auctioneer_report_already_linked"
      );
    }
    return workItem;
  }
  // Linking is compare-and-set: only the still-claimed, unlinked row can transition.
  // Reading the winner makes an exact client retry idempotent after a lost response.
  const linked = await AuctioneerWorkItem.findOneAndUpdate(
    {
      _id: workItem._id,
      claimedBy: input.userId,
      selectedReportType: input.reportType,
      linkedReportId: { $exists: false },
      status: "claimed",
    },
    {
      $set: {
        linkedReportId: new Types.ObjectId(input.reportId),
        linkedReportModel: input.reportType === "asset" ? "AssetReport" : "LotListing",
        status: "report_created",
      },
    },
    { returnDocument: "after" }
  );
  if (linked) return linked;
  const winner = await AuctioneerWorkItem.findById(workItem._id);
  if (winner?.linkedReportId && String(winner.linkedReportId) === input.reportId) return winner;
  throw new Auctioneer2ServiceError(
    "This incoming contract already has a report.",
    409,
    "auctioneer_report_already_linked"
  );
}

async function loadLinkedReport(workItem: {
  linkedReportId?: Types.ObjectId;
  selectedReportType: AuctioneerReportType;
}) {
  if (!workItem.linkedReportId) return null;
  return workItem.selectedReportType === "asset"
    ? AssetReport.findById(workItem.linkedReportId).select("+youtube_submission").lean()
    : LotListing.findById(workItem.linkedReportId).select("+youtube_submission").lean();
}

function linkedReportEligibility(
  reportType: AuctioneerReportType,
  report: Record<string, any> | null
) {
  if (!report) {
    return {
      eligible: false,
      reportStatus: null,
      releaseStatus: null,
      filesReady: false,
    };
  }
  const profile = reportType === "asset" ? "asset" : "lotListing";
  const generation = resolveReportGenerationStateForProfile(
    profile,
    report,
    report.preview_files,
    report.files
  );
  // Older artifact URLs can remain during a failed or active regeneration.
  // They must not admit a delivery the worker's current-generation guard rejects.
  const filesReady = generation.files_ready && generation.generation_state === "ready";
  const reportStatus = String(report.status || "");
  const releaseStatus = String(report.release_status || "");
  const hasRequiredAssetApproval =
    reportStatus === "approved" && releaseStatus === "released";
  return {
    eligible:
      filesReady &&
      (reportType === "lotListing" || hasRequiredAssetApproval),
    reportStatus,
    releaseStatus,
    filesReady,
  };
}

function effectiveDeliveryState(
  workItem: Pick<IAuctioneerWorkItem, "delivery">,
  eligible: boolean
) {
  const stored = workItem.delivery?.status || "not_ready";
  if (stored === "not_ready" || stored === "ready") return eligible ? "ready" : "not_ready";
  return stored;
}

function publicDeliverySummary(
  workItem: IAuctioneerWorkItem | any,
  report: Record<string, any> | null
) {
  const readiness = linkedReportEligibility(workItem.selectedReportType, report);
  const state = effectiveDeliveryState(workItem, readiness.eligible);
  /*
     What "complete the contract" means for this delivery. Assigned work closes
     the user's OWN part — Auctioneer completes the contract once every
     assigned user has closed theirs — so the client words the choice that way.
     Only older, unassigned work still closes the contract itself.
  */
  const contractCompletionScope: "user" | "contract" = workItem.assignmentUserId
    ? "user"
    : "contract";
  const contractClose = workItem.delivery?.contractClose;
  return {
    workItemId: String(workItem._id),
    reportId: workItem.linkedReportId ? String(workItem.linkedReportId) : null,
    reportModel: workItem.linkedReportModel || null,
    reportType: workItem.selectedReportType,
    // Needed by "Close my part of this contract", which is contract-scoped.
    contractId: workItem.contract.id,
    ...(workItem.contractAccessRevision !== undefined ? { accessRevision: workItem.contractAccessRevision } : {}),
    contractNo: workItem.contract.contractNo,
    state,
    canSend:
      readiness.eligible && (state === "ready" || state === "failed"),
    reportStatus: readiness.reportStatus,
    releaseStatus: readiness.releaseStatus,
    filesReady: readiness.filesReady,
    destination: workItem.delivery?.destination || null,
    opTaskDescription: workItem.delivery?.opTaskDescription || null,
    canCompleteContract: true,
    contractCompletionScope,
    completeContract: Boolean(workItem.delivery?.completeContract),
    // Set once Auctioneer confirmed the close: this user's part for assigned
    // work, the contract itself for unassigned work.
    contractClosedAt:
      contractClose?.closedAt || workItem.delivery?.contractCompletedAt || null,
    // Whether the WHOLE contract was complete at that moment. Unknown (null)
    // until a close is confirmed; always true for an unassigned close.
    contractTaskCompleted: contractClose
      ? contractClose.taskCompleted
      : workItem.delivery?.contractCompletedAt && contractCompletionScope === "contract"
        ? true
        : null,
    contractCloseUserStatus: contractClose?.userStatus || null,
    attempts: Number(workItem.delivery?.attempts || 0),
    queuedAt: workItem.delivery?.queuedAt || null,
    completedAt: workItem.delivery?.completedAt || null,
    sentAt: workItem.delivery?.completedAt || null,
    updatedAt: workItem.updatedAt || null,
    error:
      state === "failed" || state === "needs_reconciliation"
        ? workItem.delivery?.lastError || null
        : null,
    reconciliation:
      state === "needs_reconciliation"
        ? {
            sourceKey: workItem.delivery?.reconciliation?.sourceKey || null,
            reason: workItem.delivery?.reconciliation?.reason || null,
          }
        : null,
  };
}

export async function listAuctioneerDeliveries(userId: string) {
  const workItems = await AuctioneerWorkItem.find({
    claimedBy: userId,
    linkedReportId: { $exists: true },
  })
    .sort({ updatedAt: -1 })
    .lean();
  const reports = await Promise.all(workItems.map((workItem) => loadLinkedReport(workItem)));
  return workItems.map((workItem, index) =>
    publicDeliverySummary(workItem, reports[index] as Record<string, any> | null)
  );
}

export async function getAuctioneerDeliverySummary(workItemId: string, userId: string) {
  if (!Types.ObjectId.isValid(workItemId)) {
    throw new Auctioneer2ServiceError("Delivery not found.", 404, "delivery_not_found");
  }
  const workItem = await AuctioneerWorkItem.findOne({
    _id: workItemId,
    claimedBy: userId,
  });
  if (!workItem || !workItem.linkedReportId) {
    throw new Auctioneer2ServiceError("Delivery not found.", 404, "delivery_not_found");
  }
  const report = (await loadLinkedReport(workItem)) as Record<string, any> | null;
  return publicDeliverySummary(workItem, report);
}

function validateDestination(
  destination: unknown,
  opTaskDescription: unknown
): { destination: AuctioneerDeliveryDestination; opTaskDescription?: string } {
  if (destination !== "LottingBoard" && destination !== "OpToDoBoard") {
    throw new Auctioneer2ServiceError(
      "Destination must be LottingBoard or OpToDoBoard.",
      400,
      "invalid_destination"
    );
  }
  const note = typeof opTaskDescription === "string" ? opTaskDescription.trim() : "";
  if (destination === "OpToDoBoard" && !note) {
    throw new Auctioneer2ServiceError(
      "A note is required for OpToDoBoard.",
      400,
      "op_task_description_required"
    );
  }
  if (note.length > 2_000) {
    throw new Auctioneer2ServiceError(
      "The OpToDoBoard note cannot exceed 2,000 characters.",
      400,
      "op_task_description_too_long"
    );
  }
  return {
    destination,
    ...(note ? { opTaskDescription: note } : {}),
  };
}

export async function queueAuctioneerDelivery(
  workItemId: string,
  userId: string,
  input: {
    destination: unknown;
    opTaskDescription?: unknown;
    completeContract?: unknown;
  }
) {
  if (!Types.ObjectId.isValid(workItemId)) {
    throw new Auctioneer2ServiceError("Delivery not found.", 404, "delivery_not_found");
  }
  const work = await AuctioneerWorkItem.findOne({ _id: workItemId, claimedBy: userId }).select("contract.id").lean();
  if (!work) throw new Auctioneer2ServiceError("Delivery not found.", 404, "delivery_not_found");
  return withAuctioneerContractOperation(work.contract.id, userId, (lease) =>
    queueAuctioneerDeliveryLocked(workItemId, userId, input, lease));
}

async function queueAuctioneerDeliveryLocked(
  workItemId: string,
  userId: string,
  input: { destination: unknown; opTaskDescription?: unknown; completeContract?: unknown },
  lease: ReportSubmissionAdmissionLease,
) {
  const requested = validateDestination(input.destination, input.opTaskDescription);
  if (!Types.ObjectId.isValid(workItemId)) {
    throw new Auctioneer2ServiceError("Delivery not found.", 404, "delivery_not_found");
  }
  const initial = await AuctioneerWorkItem.findOne({
    _id: workItemId,
    claimedBy: userId,
  });
  if (!initial || !initial.linkedReportId) {
    throw new Auctioneer2ServiceError("Delivery not found.", 404, "delivery_not_found");
  }
  /*
     Assigned work may now ask to close the contract: the worker closes only
     the assigned user's own part, by name, and Auctioneer completes the
     contract once every assigned user has closed theirs. What is still refused
     is closing on somebody else's behalf — work whose assignment names a user
     other than the one sending it.
  */
  if (
    input.completeContract === true &&
    initial.assignmentUserId &&
    String(initial.assignmentUserId) !== userId
  ) {
    throw new Auctioneer2ServiceError(
      "Only the user assigned to this work can close their part of the contract.",
      409,
      "auctioneer_contract_completion_not_allowed"
    );
  }
  if (["queued", "sending", "sent"].includes(initial.delivery.status)) {
    const existingReport = (await loadLinkedReport(initial)) as Record<string, any> | null;
    return publicDeliverySummary(initial, existingReport);
  }
  if (initial.delivery.status === "needs_reconciliation") {
    throw new Auctioneer2ServiceError(
      "This delivery must be reconciled before it can be retried.",
      409,
      "delivery_needs_reconciliation"
    );
  }
  const retryingCloseOnly = initial.delivery.status === "failed" &&
    initial.delivery.completeContract === true && initial.delivery.lots.length > 0 &&
    initial.delivery.lots.every((lot) => lot.status === "sent");
  await assertAuctioneerContractCaptureRevision(initial.contract.id, userId, initial.contractAccessRevision);
  if (!retryingCloseOnly) await assertAuctioneerContractSendOpen(initial.contract.id, userId, initial.contractAccessRevision);
  const report = (await loadLinkedReport(initial)) as Record<string, any> | null;
  const readiness = linkedReportEligibility(initial.selectedReportType, report);
  if (!readiness.eligible) {
    throw new Auctioneer2ServiceError(
      initial.selectedReportType === "asset"
        ? "The Asset Listing must be approved, released, and have all required files before sending."
        : "The Lot Listing must have all required generated files before sending.",
      409,
      "delivery_not_ready"
    );
  }

  // A failed delivery resumes against its original immutable manifest. Rebuilding from
  // a newly edited report would invalidate already-persisted upstream checkpoints.
  const savedManifest = isRecord(initial.delivery.manifest)
    ? initial.delivery.manifest
    : null;
  const resumesCheckpoints =
    initial.delivery.status === "failed" && Boolean(savedManifest);
  const validated = resumesCheckpoints
    ? validateDestination(
        savedManifest?.destination || initial.delivery.destination,
        savedManifest?.opTaskDescription ||
          initial.delivery.opTaskDescription
      )
    : requested;
  const completeContract = resumesCheckpoints
    ? savedManifest?.completeContract === true ||
      initial.delivery.completeContract === true
    : input.completeContract === true;
  if (
    resumesCheckpoints &&
    (requested.destination !== validated.destination ||
      (requested.opTaskDescription || "") !==
        (validated.opTaskDescription || "") ||
      input.completeContract === true !== completeContract)
  ) {
    throw new Auctioneer2ServiceError(
      "A retry must use the original delivery settings so completed lot checkpoints remain consistent.",
      409,
      "delivery_retry_settings_locked"
    );
  }
  const previewData = report?.preview_data || {
    lots: Array.isArray(report?.lots) ? report.lots : [],
    contract_no: report?.contract_no,
    location: report?.location,
  };
  const imageUrls = firstReportImageManifest(previewData.imageUrls, previewData.image_urls, report?.imageUrls, report?.image_urls);
  const resolvePhotos = createLotPhotoResolver(imageUrls, previewData.deleted_image_indexes, previewData.deleted_image_urls);
  const manifest = resumesCheckpoints
    ? {
        ...savedManifest!,
        completeContract,
      }
    : {
        workItemId,
        reportId: String(initial.linkedReportId),
        reportType: initial.selectedReportType,
        reportUpdatedAt: report?.updatedAt || null,
        previewData,
        photoOrderVersion: 2,
        photoUrlsByLot: (Array.isArray(previewData.lots) ? previewData.lots : []).map((lot: any) => resolvePhotos(lot).map((photo) => photo.url)),
        videoOrderVersion: 1,
        ...await buildAuctioneerVideoManifest(report, initial.selectedReportType, Array.isArray(previewData.lots) ? previewData.lots : []),
        destination: validated.destination,
        opTaskDescription: validated.opTaskDescription || "",
        completeContract,
      };
  const payloadHash =
    (resumesCheckpoints && initial.delivery.payloadHash) ||
    stableHash(JSON.stringify(manifest));
  const queuedAt = new Date();
  // Persist queued intent before publishing the durable job. This prevents a worker from
  // observing an old manifest and gives queue failure a state that can be safely retried.
  await lease.assertOwned();
  const queued = await AuctioneerWorkItem.findOneAndUpdate(
    {
      _id: initial._id,
      claimedBy: userId,
      "delivery.status": { $in: ["not_ready", "ready", "failed"] },
    },
    {
      $set: {
        "delivery.status": "queued",
        "delivery.destination": validated.destination,
        "delivery.opTaskDescription": validated.opTaskDescription,
        "delivery.completeContract": completeContract,
        "delivery.payloadHash": payloadHash,
        "delivery.manifest": manifest,
        "delivery.queuedAt": queuedAt,
        "delivery.lastError": null,
        "delivery.reconciliation.required": false,
      },
      $unset: {
        "delivery.failedAt": 1,
        "delivery.startedAt": 1,
        "delivery.completedAt": 1,
      },
      $inc: { "delivery.attempts": 1 },
    },
    { returnDocument: "after" }
  );
  if (!queued) {
    const winner = await AuctioneerWorkItem.findById(initial._id);
    if (!winner) {
      throw new Auctioneer2ServiceError("Delivery not found.", 404, "delivery_not_found");
    }
    return publicDeliverySummary(
      winner,
      (await loadLinkedReport(winner)) as Record<string, any> | null
    );
  }

  try {
    // The payload hash is part of the idempotency key: identical retries converge, while
    // a genuinely new manifest produces a distinct job identity.
    await createMongoReportJob({
      type: "auctioneer-delivery" as any,
      reportId: String(queued.linkedReportId),
      payload: { workItemId: String(queued._id) },
      idempotencyKey: `auctioneer-delivery:${queued._id}:${payloadHash}`,
      maxAttempts: 1,
      priority: 5,
    });
  } catch {
    await AuctioneerWorkItem.updateOne(
      { _id: queued._id, "delivery.status": "queued", "delivery.payloadHash": payloadHash },
      {
        $set: {
          "delivery.status": "failed",
          "delivery.failedAt": new Date(),
          "delivery.lastError": "The delivery could not be queued. Please retry.",
        },
      }
    );
    throw new Auctioneer2ServiceError(
      "The delivery could not be queued. Please retry.",
      503,
      "delivery_queue_failed"
    );
  }
  return publicDeliverySummary(queued, report);
}

export async function reconcileAuctioneerDelivery(
  workItemId: string,
  userId: string,
  input: {
    sourceKey?: unknown;
    existingLotId?: unknown;
    externalLotId?: unknown;
    confirmNoLot?: unknown;
    confirmNotCreated?: unknown;
  }
) {
  // Unknown-lot creation is the one provider action whose timeout cannot prove whether a
  // side effect occurred. Human reconciliation resolves that ambiguity before retry.
  if (!Types.ObjectId.isValid(workItemId)) {
    throw new Auctioneer2ServiceError("Delivery not found.", 404, "delivery_not_found");
  }
  const workItem = await AuctioneerWorkItem.findOne({
    _id: workItemId,
    claimedBy: userId,
  });
  if (!workItem || workItem.delivery.status !== "needs_reconciliation") {
    throw new Auctioneer2ServiceError(
      "This delivery does not require reconciliation.",
      409,
      "delivery_reconciliation_not_required"
    );
  }
  const sourceKey =
    (typeof input.sourceKey === "string" && input.sourceKey.trim()) ||
    workItem.delivery.reconciliation?.sourceKey;
  if (!sourceKey) {
    throw new Auctioneer2ServiceError(
      "A source lot is required.",
      400,
      "reconciliation_source_required"
    );
  }
  const checkpoint = workItem.delivery.lots.find((lot) => lot.sourceKey === sourceKey);
  if (!checkpoint) {
    throw new Auctioneer2ServiceError("Source lot not found.", 404, "source_lot_not_found");
  }
  const existingLotValue =
    typeof input.existingLotId === "string"
      ? input.existingLotId
      : typeof input.externalLotId === "string"
        ? input.externalLotId
        : "";
  const existingLotId = existingLotValue.trim();
  const confirmNoLot =
    input.confirmNoLot === true || input.confirmNotCreated === true;
  if (Boolean(existingLotId) === confirmNoLot) {
    throw new Auctioneer2ServiceError(
      "Provide an existing lot ID or confirm that no lot was created.",
      400,
      "invalid_reconciliation_choice"
    );
  }

  if (existingLotId) {
    const existingLot = await getLot(existingLotId);
    const contractId = textValue(existingLot, [
      "contractId",
      "contract_id",
      "contract.id",
    ]);
    if (contractId !== workItem.contract.id) {
      throw new Auctioneer2ServiceError(
        "The supplied lot does not belong to this contract.",
        400,
        "reconciliation_contract_mismatch"
      );
    }
    checkpoint.createdLotId = existingLotId;
    checkpoint.createdSubmissionId = textValue(existingLot, [
      "submissionId",
      "submission_id",
      "submissionGuid",
      "submission_guid",
    ]);
    checkpoint.status = "pending";
    checkpoint.step = "submitted";
    checkpoint.lastError = undefined;
  } else {
    checkpoint.createdLotId = undefined;
    checkpoint.createdSubmissionId = undefined;
    checkpoint.status = "pending";
    checkpoint.step = "pending";
    checkpoint.lastError = undefined;
  }
  workItem.delivery.status = "failed";
  workItem.delivery.lastError = "Reconciliation completed. Retry the delivery when ready.";
  workItem.delivery.reconciliation = {
    required: false,
    sourceKey,
    ...(existingLotId ? { existingLotId } : { confirmedNoLot: true }),
    requestedAt: workItem.delivery.reconciliation?.requestedAt,
    resolvedAt: new Date(),
  };
  workItem.markModified("delivery");
  await workItem.save();
  return publicDeliverySummary(
    workItem,
    (await loadLinkedReport(workItem)) as Record<string, any> | null
  );
}

/*
   ── CLOSE MY PART OF THIS CONTRACT, WITHOUT SENDING ANYTHING ──────────────

   A delivery can close the user's part once its lots land, but a person may
   have nothing left to send — their lots went in earlier deliveries, or
   another assigned person covered them. This closes their part directly.

   Scope: only the signed-in user, and only on a contract where they hold their
   OWN Auctioneer work (a work item claimed by them and assigned to them). The
   close always names that user, so it can never finish somebody else's part,
   and a contract they have no work on is refused before Auctioneer is asked —
   on a contract nobody was assigned per user, Auctioneer treats any close as
   closing the whole contract, so the local proof of assignment matters.

   Refused while one of their deliveries for the contract is still moving or
   stopped part-way (queued, sending, failed, awaiting reconciliation): closing
   then would mark the contract finished before those lots arrive. Finish or
   retry that delivery first — with the close box ticked, it closes the part
   itself.

   Idempotent: Auctioneer answers a repeat with the first outcome and changes
   nothing, so a double click or a retry after a lost response is harmless. The
   outcome is recorded on each of the user's work items for the contract, the
   same record a delivery's close writes, so the delivery summaries My Reports
   reads can show it.
*/
const CLOSE_BLOCKING_DELIVERY_STATES = ["queued", "sending", "failed", "needs_reconciliation"];
const CLOSE_ELIGIBLE_WORK_STATES = ["claimed", "report_created", "sent"];

export async function closeAuctioneerContractPart(contractId: unknown, userId: string, accessRevision?: unknown) {
  if (!userId || !Types.ObjectId.isValid(userId)) {
    throw new Auctioneer2ServiceError("The authenticated user is invalid.", 401, "invalid_user");
  }
  const normalizedContractId = typeof contractId === "string" ? contractId.trim() : "";
  if (!normalizedContractId || normalizedContractId.length > 200) {
    throw new Auctioneer2ServiceError(
      "You have no Auctioneer work on this contract to close.",
      404,
      "auctioneer_contract_assignment_not_found"
    );
  }
  return withAuctioneerContractOperation(normalizedContractId, userId, (lease) =>
    closeAuctioneerContractPartLocked(normalizedContractId, userId, lease, accessRevision));
}

async function closeAuctioneerContractPartLocked(normalizedContractId: string, userId: string, lease: ReportSubmissionAdmissionLease, accessRevision?: unknown) {
  const captureState = await getAuctioneerContractCaptureState(normalizedContractId, userId);
  if (captureState?.status === "reopen_pending") throw new Auctioneer2ServiceError(
    "Re-Open is awaiting confirmation. Check the same Re-Open request before closing your part.", 409, "auctioneer_contract_reopen_pending");
  if (captureState?.accessRevision !== undefined && captureState.accessRevision !== accessRevision) throw new Auctioneer2ServiceError(
    "This contract was reopened after the close action was prepared. Refresh Incoming before closing its current capture.", 409, "auctioneer_contract_capture_changed");
  await assertNoQueuedContinuationUpload(normalizedContractId, userId);
  const ownWorkFilter = {
    "contract.id": normalizedContractId,
    claimedBy: new Types.ObjectId(userId),
    assignmentUserId: new Types.ObjectId(userId),
    status: { $in: CLOSE_ELIGIBLE_WORK_STATES },
  };
  const ownWork = await AuctioneerWorkItem.find(ownWorkFilter)
    .select({ "contract.contractNo": 1, "delivery.status": 1, contractAccessRevision: 1 })
    .lean();
  if (!ownWork.length) {
    // The same answer whether the contract exists, belongs to somebody else
    // or was never assigned: none of those is this user's to close.
    throw new Auctioneer2ServiceError(
      "You have no Auctioneer work on this contract to close.",
      404,
      "auctioneer_contract_assignment_not_found"
    );
  }
  if (ownWork.some((item: any) => (captureState?.accessRevision === undefined || item.contractAccessRevision === captureState.accessRevision) &&
      CLOSE_BLOCKING_DELIVERY_STATES.includes(String(item.delivery?.status)))) {
    throw new Auctioneer2ServiceError(
      "One of your deliveries for this contract has not finished. Let it finish, or retry it, before closing your part.",
      409,
      "auctioneer_contract_delivery_unfinished"
    );
  }

  const user = await User.findById(userId).select("username email").lean();
  const completedBy =
    String((user as any)?.username || "").trim() ||
    String((user as any)?.email || "").trim() ||
    `Asset Insight user ${userId}`;
  let outcome: Awaited<ReturnType<typeof closeContractPartForUser>>;
  await lease.assertOwned();
  await beginAuctioneerContractClose(normalizedContractId, userId);
  try {
    outcome = await closeContractPartForUser(normalizedContractId, {
      completedBy,
      completedByUserId: userId,
    });
  } catch (error) {
    if (error instanceof Auctioneer2ClientError && error.upstreamStatus === 404) {
      throw new Auctioneer2ServiceError(
        "Auctioneer no longer recognises this contract. Ask the auction team to check it.",
        404,
        "auctioneer_contract_not_found"
      );
    }
    throw error;
  }

  const closedAt = new Date();
  await lease.assertOwned();
  await confirmAuctioneerContractClose(normalizedContractId, userId, outcome, closedAt);
  // Never touch a delivery that started moving after the check above: a write
  // to it would collide with the worker's own checkpoint saves.
  await AuctioneerWorkItem.updateMany(
    { ...ownWorkFilter, "delivery.status": { $nin: ["queued", "sending"] },
      ...(captureState?.accessRevision !== undefined ? { contractAccessRevision: captureState.accessRevision } : {}) },
    {
      $set: {
        "delivery.contractClose": {
          userId,
          closedAt,
          taskCompleted: outcome.taskCompleted,
          ...(outcome.userStatus ? { userStatus: outcome.userStatus } : {}),
          via: "manual",
        },
      },
    }
  );
  clearAuctioneer2IncomingCache(userId);
  return {
    contractId: normalizedContractId,
    contractNo: String((ownWork[0] as any)?.contract?.contractNo || ""),
    closedAt,
    // The whole contract is complete: every assigned person has closed theirs.
    taskCompleted: outcome.taskCompleted,
    alreadyCompleted: outcome.alreadyCompleted,
    // "completed" for a closed part; "revoked" when Auctioneer shows the user
    // was taken off the contract, so there was nothing of theirs to close.
    userStatus: outcome.userStatus,
  };
}

export async function refreshAuctioneerDeliveryReadinessForReport(
  reportId: string
): Promise<void> {
  if (!Types.ObjectId.isValid(reportId)) return;
  const workItem = await AuctioneerWorkItem.findOne({ linkedReportId: reportId });
  if (!workItem || !["not_ready", "ready"].includes(workItem.delivery.status)) return;
  const report = (await loadLinkedReport(workItem)) as Record<string, any> | null;
  const readiness = linkedReportEligibility(workItem.selectedReportType, report);
  await AuctioneerWorkItem.updateOne(
    { _id: workItem._id, "delivery.status": { $in: ["not_ready", "ready"] } },
    { $set: { "delivery.status": readiness.eligible ? "ready" : "not_ready" } }
  );
}
