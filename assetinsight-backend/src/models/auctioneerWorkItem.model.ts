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
  services?: Array<Record<string, unknown>>;
  sourcePhotos?: Array<Record<string, unknown>>;
  raw?: Record<string, unknown>;
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
    services: { type: [Schema.Types.Mixed], default: undefined },
    sourcePhotos: { type: [Schema.Types.Mixed], default: undefined },
    raw: { type: Schema.Types.Mixed },
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
    contractAccessRevision: { type: Schema.Types.Mixed, immutable: true },
    continuationOfWorkItemId: {
      type: Schema.Types.ObjectId,
      ref: "AuctioneerWorkItem",
      immutable: true,
      index: true,
    },
    queuedContinuation: { type: Schema.Types.Mixed, select: false },
    linkedReportModel: { type: String, enum: ["AssetReport", "LotListing"] },
    linkedReportId: { type: Schema.Types.ObjectId },
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
