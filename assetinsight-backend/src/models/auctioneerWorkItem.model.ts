import mongoose, { Document, Schema, Types } from "mongoose";
import { reportActivityPlugin } from "../utils/reportActivityPlugin.js";

export type AuctioneerReportType = "asset" | "lotListing";
export type AuctioneerWorkItemKind = "scheduleA" | "unknown";
export type AuctioneerWorkItemStatus =
  | "claimed"
  | "report_created"
  | "abandoned"
  | "sent";
export type AuctioneerDeliveryStatus =
  | "not_ready"
  | "ready"
  | "queued"
  | "sending"
  | "failed"
  | "needs_reconciliation"
  | "sent";
export type AuctioneerDeliveryDestination = "LottingBoard" | "OpToDoBoard";
export type AuctioneerDeliveryLotStatus =
  | "pending"
  | "processing"
  | "needs_reconciliation"
  | "failed"
  | "sent";

export interface IAuctioneerContractSnapshot {
  id: string;
  contractNo: string;
  customerName?: string;
  consignorName?: string;
  salespersonName?: string;
  description?: string;
  eventId?: string;
  eventTitle?: string;
  eventDate?: string;
  location?: string;
  categories?: string;
  hasScheduleA?: boolean;
  hasUnknownLots?: boolean;
}

export interface IAuctioneerSourceLot {
  sourceKey: string;
  lotId?: string;
  submissionId?: string;
  lotNumber?: string | number;
  title?: string;
  description?: string;
  details?: string;
  categories?: string;
  serialNumber?: string;
  make?: string;
  model?: string;
  year?: string | number;
  conditionReport?: string;
  /** The Auctioneer Schedule A line this lot was created for, when it has one. */
  scheduleALineId?: string;
  /**
   * That line's Schedule A item is ticked "Several lots" in Auctioneer: it may
   * come back as more than one lot (owner 2026-10-28). Missing on older
   * snapshots; read it as false.
   */
  severalLots?: boolean;
  scheduleAItemTitle?: string;
  services?: Array<Record<string, unknown>>;
  sourcePhotos?: Array<Record<string, unknown>>;
  raw?: Record<string, unknown>;
}

/**
 * A Schedule A item a lot on this contract may be linked to (owner
 * 2026-10-28): ticked "Several lots" and already holding an Auctioneer lot,
 * which is named as scheduleAParentRef when the extra lot is created.
 */
export interface IAuctioneerScheduleAChoice {
  lineId: string;
  title: string;
  parentLotId: string;
}

/**
 * One item of a Proposal's list that the office pushed to this work item's
 * user (owner 2026-10-28). The user works each item and returns it to
 * Auctioneer against its lineId; nothing here becomes an Auctioneer lot.
 */
export interface IAuctioneerProposalItem {
  lineId: string;
  title: string;
  lotNumber?: string;
  serialNumber?: string;
  year?: string;
  make?: string;
  model?: string;
  description?: string;
  /** Auctioneer already holds a return for it (captured, or not found). */
  returned: boolean;
}

/** A listed item this user returned to Auctioneer as not found. */
export interface IAuctioneerProposalNotFound {
  lineId: string;
  returnedAt: Date;
}

export interface IAuctioneerDeliveryLotCheckpoint {
  sourceKey: string;
  sourceLotId?: string;
  sourceSubmissionId?: string;
  createdLotId?: string;
  createdSubmissionId?: string;
  status: AuctioneerDeliveryLotStatus;
  step?: string;
  patchedAt?: Date;
  photosUploadedAt?: Date;
  videoUploadedAt?: Date;
  conditionReportCompletedAt?: Date;
  /** The lot's own condition-report PDF was stored in Auctioneer (2026-10-29). */
  conditionReportPdfStoredAt?: Date;
  arrivedAt?: Date;
  pushedAt?: Date;
  lastError?: string;
}

/**
 * One user's part of a contract, closed in Auctioneer.
 *
 * Several Asset Insight users can be assigned to one contract; Auctioneer
 * completes the contract only once every one of them has closed theirs. This
 * records that THIS work item's user closed theirs, and what Auctioneer said
 * about the contract as a whole at that moment.
 */
export interface IAuctioneerContractClose {
  /** The Asset Insight user whose part was closed (their assignmentUserId). */
  userId: string;
  /** When Auctioneer confirmed the close. */
  closedAt: Date;
  /** Auctioneer reported every assigned user closed: the contract is complete. */
  taskCompleted: boolean;
  /** The user's assignment status Auctioneer reported back, when it named one. */
  userStatus?: string;
  /** Closed after this work item's delivery, or by the user directly. */
  via: "delivery" | "manual";
}

export interface IAuctioneerDelivery {
  status: AuctioneerDeliveryStatus;
  destination?: AuctioneerDeliveryDestination;
  opTaskDescription?: string;
  /**
   * Close the contract once every lot of this delivery has landed. For work
   * assigned to a user this closes THAT user's part only (see contractClose);
   * for older unassigned work it closes the contract itself.
   */
  completeContract: boolean;
  payloadHash?: string;
  manifest?: Record<string, unknown>;
  attempts: number;
  queuedAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  lastError?: string;
  lots: IAuctioneerDeliveryLotCheckpoint[];
  /**
   * The delivery's contract close was confirmed by Auctioneer. This is the
   * worker's checkpoint: once set, a retry of the same delivery never calls
   * task-completed again.
   */
  contractCompletedAt?: Date;
  /** Whose part that close was, and Auctioneer's answer (assigned work only). */
  contractClose?: IAuctioneerContractClose;
  /**
   * A Proposal list's items went back to Auctioneer in one review-items call
   * (owner 2026-10-28), and whether the Proposal stayed in the Asset Insight
   * queue afterwards: it leaves only once every listed item is back.
   */
  proposalReturn?: { returnedAt: Date; itemCount: number; remainsInAssetInsight: boolean };
  reconciliation?: {
    required: boolean;
    sourceKey?: string;
    reason?: string;
    existingLotId?: string;
    confirmedNoLot?: boolean;
    requestedAt?: Date;
    resolvedAt?: Date;
  };
}

export interface IAuctioneerWorkItem extends Document {
  source: "auctioneer2";
  cycleKey: string;
  activeContractKey?: string;
  assignmentUserId?: Types.ObjectId;
  contractAccessRevision?: string | number;
  /**
   * A capture made before its contract was re-opened, never sent, and carried
   * into the current opening when it was sent (owner 2026-10-29; see
   * carryUnsentCaptureIntoCurrentOpening). The opening it was made in — null
   * when that was before openings were numbered — and when it moved.
   */
  carriedFromAccessRevision?: string | number | null;
  carriedIntoOpeningAt?: Date;
  contract: IAuctioneerContractSnapshot;
  kind: AuctioneerWorkItemKind;
  snapshot: {
    contract?: Record<string, unknown>;
    event?: Record<string, unknown>;
    customer?: Record<string, unknown>;
    tasks: Array<Record<string, unknown>>;
    lots: IAuctioneerSourceLot[];
    capturedAt: Date;
  };
  claimedBy: Types.ObjectId;
  claimedAt: Date;
  selectedReportType: AuctioneerReportType;
  clientSubmissionId: string;
  continuationOfWorkItemId?: Types.ObjectId;
  queuedContinuation?: Record<string, any>;
  linkedReportModel?: "AssetReport" | "LotListing";
  linkedReportId?: Types.ObjectId;
  eventIdentityRecovery?: { eventId: string; source: "saved_snapshot" | "assigned_contract" | "contract_lots"; resolvedAt: Date };
  /**
   * The contract's choosable Schedule A items, for a work item whose lots must
   * name one (see auctioneerScheduleAItemLink). Unlike the snapshot this is
   * refreshed from Auctioneer, because the office may tick "Several lots"
   * after the work item was created.
   */
  scheduleAChoices?: IAuctioneerScheduleAChoice[];
  /**
   * Present only on a Proposal worked item by item (owner 2026-10-28): the
   * list's items pushed to this user. Its presence is what makes the work
   * item return its lots through review-items instead of creating lots.
   * Refreshed from Auctioneer, like scheduleAChoices, because the office can
   * push more items after the claim.
   */
  proposalList?: { items: IAuctioneerProposalItem[]; refreshedAt: Date };
  /**
   * The listed items this work item's last submitted report captured, so a
   * "Create Lot & Continue" successor does not offer them a second time
   * while that report is still on its way to Auctioneer.
   */
  proposalCapturedLineIds?: string[];
  /** Listed items this work item returned to Auctioneer as not found. */
  proposalNotFound?: IAuctioneerProposalNotFound[];
  status: AuctioneerWorkItemStatus;
  delivery: IAuctioneerDelivery;
  createdAt: Date;
  updatedAt: Date;
}

const ContractSnapshotSchema = new Schema<IAuctioneerContractSnapshot>(
  {
    id: { type: String, required: true },
    contractNo: { type: String, required: true },
    customerName: { type: String },
    consignorName: { type: String },
    salespersonName: { type: String },
    description: { type: String },
    eventId: { type: String },
    eventTitle: { type: String },
    eventDate: { type: String },
    location: { type: String },
    categories: { type: String },
    hasScheduleA: { type: Boolean },
    hasUnknownLots: { type: Boolean },
  },
  { _id: false }
);

const SourceLotSchema = new Schema<IAuctioneerSourceLot>(
  {
    sourceKey: { type: String, required: true },
    lotId: { type: String },
    submissionId: { type: String },
    lotNumber: { type: Schema.Types.Mixed },
    title: { type: String },
    description: { type: String },
    details: { type: String },
    categories: { type: String },
    serialNumber: { type: String },
    make: { type: String },
    model: { type: String },
    year: { type: Schema.Types.Mixed },
    conditionReport: { type: String },
    scheduleALineId: { type: String },
    // No schema default: snapshot.lots is immutable, and a default applied
    // when an older snapshot is loaded must never become a write to it.
    // normalizeAuctioneer2Lot always stores a boolean for new snapshots.
    severalLots: { type: Boolean },
    scheduleAItemTitle: { type: String },
    services: { type: [Schema.Types.Mixed], default: undefined },
    sourcePhotos: { type: [Schema.Types.Mixed], default: undefined },
    raw: { type: Schema.Types.Mixed },
  },
  { _id: false }
);

const ScheduleAChoiceSchema = new Schema<IAuctioneerScheduleAChoice>(
  {
    lineId: { type: String, required: true },
    title: { type: String, required: true },
    parentLotId: { type: String, required: true },
  },
  { _id: false }
);

const ProposalItemSchema = new Schema<IAuctioneerProposalItem>(
  {
    lineId: { type: String, required: true },
    title: { type: String, required: true },
    lotNumber: { type: String },
    serialNumber: { type: String },
    year: { type: String },
    make: { type: String },
    model: { type: String },
    description: { type: String },
    returned: { type: Boolean, required: true },
  },
  { _id: false }
);

const ProposalListSchema = new Schema(
  {
    items: { type: [ProposalItemSchema], default: [] },
    refreshedAt: { type: Date, required: true },
  },
  { _id: false }
);

const ProposalNotFoundSchema = new Schema<IAuctioneerProposalNotFound>(
  {
    lineId: { type: String, required: true },
    returnedAt: { type: Date, required: true },
  },
  { _id: false }
);

const DeliveryLotCheckpointSchema = new Schema<IAuctioneerDeliveryLotCheckpoint>(
  {
    sourceKey: { type: String, required: true },
    sourceLotId: { type: String },
    sourceSubmissionId: { type: String },
    createdLotId: { type: String },
    createdSubmissionId: { type: String },
    status: {
      type: String,
      enum: ["pending", "processing", "needs_reconciliation", "failed", "sent"],
      default: "pending",
      required: true,
    },
    step: { type: String },
    patchedAt: { type: Date },
    photosUploadedAt: { type: Date },
    videoUploadedAt: { type: Date },
    conditionReportCompletedAt: { type: Date },
    conditionReportPdfStoredAt: { type: Date },
    arrivedAt: { type: Date },
    pushedAt: { type: Date },
    lastError: { type: String },
  },
  { _id: false }
);

const ReconciliationSchema = new Schema(
  {
    required: { type: Boolean, default: false },
    sourceKey: { type: String },
    reason: { type: String },
    existingLotId: { type: String },
    confirmedNoLot: { type: Boolean },
    requestedAt: { type: Date },
    resolvedAt: { type: Date },
  },
  { _id: false }
);

const ContractCloseSchema = new Schema<IAuctioneerContractClose>(
  {
    userId: { type: String, required: true },
    closedAt: { type: Date, required: true },
    taskCompleted: { type: Boolean, required: true },
    userStatus: { type: String },
    via: { type: String, enum: ["delivery", "manual"], required: true },
  },
  { _id: false }
);

const AuctioneerWorkItemSchema = new Schema<IAuctioneerWorkItem>(
  {
    source: {
      type: String,
      enum: ["auctioneer2"],
      default: "auctioneer2",
      immutable: true,
      required: true,
    },
    cycleKey: { type: String, required: true, immutable: true },
    activeContractKey: { type: String },
    assignmentUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      immutable: true,
    },
    contract: { type: ContractSnapshotSchema, required: true, immutable: true },
    eventIdentityRecovery: {
      type: new Schema({ eventId: { type: String, required: true }, source: { type: String, enum: ["saved_snapshot", "assigned_contract", "contract_lots"], required: true }, resolvedAt: { type: Date, required: true } }, { _id: false }),
      default: undefined,
    },
    kind: {
      type: String,
      enum: ["scheduleA", "unknown"],
      required: true,
      immutable: true,
    },
    snapshot: {
      contract: { type: Schema.Types.Mixed, immutable: true },
      event: { type: Schema.Types.Mixed, immutable: true },
      customer: { type: Schema.Types.Mixed, immutable: true },
      tasks: { type: [Schema.Types.Mixed], default: [], immutable: true },
      lots: { type: [SourceLotSchema], default: [], immutable: true },
      capturedAt: {
        type: Date,
        required: true,
        default: Date.now,
        immutable: true,
      },
    },
    claimedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
      immutable: true,
    },
    claimedAt: {
      type: Date,
      required: true,
      default: Date.now,
      immutable: true,
    },
    selectedReportType: {
      type: String,
      enum: ["asset", "lotListing"],
      required: true,
      immutable: true,
    },
    clientSubmissionId: { type: String, required: true, immutable: true },
    // Immutable except for one deliberate move: a never-sent capture carried
    // into the current opening (auctioneerContractCloseService.ts).
    contractAccessRevision: { type: Schema.Types.Mixed, immutable: true },
    carriedFromAccessRevision: { type: Schema.Types.Mixed },
    carriedIntoOpeningAt: { type: Date },
    continuationOfWorkItemId: {
      type: Schema.Types.ObjectId,
      ref: "AuctioneerWorkItem",
      immutable: true,
      index: true,
    },
    queuedContinuation: { type: Schema.Types.Mixed, select: false },
    linkedReportModel: { type: String, enum: ["AssetReport", "LotListing"] },
    linkedReportId: { type: Schema.Types.ObjectId },
    scheduleAChoices: { type: [ScheduleAChoiceSchema], default: undefined },
    // No defaults: absence is what marks an ordinary (non-list) work item.
    proposalList: { type: ProposalListSchema, default: undefined },
    proposalCapturedLineIds: { type: [String], default: undefined },
    proposalNotFound: { type: [ProposalNotFoundSchema], default: undefined },
    status: {
      type: String,
      enum: ["claimed", "report_created", "abandoned", "sent"],
      default: "claimed",
      required: true,
      index: true,
    },
    delivery: {
      status: {
        type: String,
        enum: [
          "not_ready",
          "ready",
          "queued",
          "sending",
          "failed",
          "needs_reconciliation",
          "sent",
        ],
        default: "not_ready",
        required: true,
      },
      destination: { type: String, enum: ["LottingBoard", "OpToDoBoard"] },
      opTaskDescription: { type: String },
      completeContract: { type: Boolean, default: false },
      payloadHash: { type: String },
      manifest: { type: Schema.Types.Mixed },
      attempts: { type: Number, default: 0 },
      queuedAt: { type: Date },
      startedAt: { type: Date },
      completedAt: { type: Date },
      failedAt: { type: Date },
      lastError: { type: String },
      lots: { type: [DeliveryLotCheckpointSchema], default: [] },
      contractCompletedAt: { type: Date },
      contractClose: { type: ContractCloseSchema, default: undefined },
      proposalReturn: {
        type: new Schema({
          returnedAt: { type: Date, required: true },
          itemCount: { type: Number, required: true },
          remainsInAssetInsight: { type: Boolean, required: true },
        }, { _id: false }),
        default: undefined,
      },
      reconciliation: { type: ReconciliationSchema, default: { required: false } },
    },
  },
  {
    timestamps: true,
    minimize: false,
  }
);

AuctioneerWorkItemSchema.index({ cycleKey: 1 }, { unique: true });
AuctioneerWorkItemSchema.index(
  { activeContractKey: 1 },
  {
    unique: true,
    partialFilterExpression: { activeContractKey: { $type: "string" } },
  }
);
AuctioneerWorkItemSchema.index(
  { linkedReportId: 1 },
  {
    unique: true,
    partialFilterExpression: { linkedReportId: { $type: "objectId" } },
  }
);
AuctioneerWorkItemSchema.index({ claimedBy: 1, updatedAt: -1 });
AuctioneerWorkItemSchema.index({ assignmentUserId: 1, updatedAt: -1 });
AuctioneerWorkItemSchema.index({ "contract.id": 1, status: 1 });
AuctioneerWorkItemSchema.index({ "delivery.status": 1, "delivery.queuedAt": 1 });

AuctioneerWorkItemSchema.plugin(reportActivityPlugin, { model: "AuctioneerWorkItem" });
const AuctioneerWorkItem = mongoose.model<IAuctioneerWorkItem>(
  "AuctioneerWorkItem",
  AuctioneerWorkItemSchema
);

export default AuctioneerWorkItem;
