import mongoose from "mongoose";

export const CRM_TRANSFER_STATUSES = ["pending", "accepted", "rejected", "cancelled"] as const;
export type CrmTransferStatus = (typeof CRM_TRANSFER_STATUSES)[number];

const crmTaskTransferSchema = new mongoose.Schema(
  {
    isReviewData: { type: Boolean, default: false, immutable: true },
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CrmLead",
      required: true,
      index: true,
    },
    fromUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    toUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: CRM_TRANSFER_STATUSES,
      default: "pending",
      index: true,
    },
    note: { type: String, trim: true },
    respondedAt: { type: Date },
    respondedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

crmTaskTransferSchema.index({ toUserId: 1, status: 1, createdAt: -1 });
crmTaskTransferSchema.index({ fromUserId: 1, status: 1, createdAt: -1 });

const CrmTaskTransferRequest = mongoose.model("CrmTaskTransferRequest", crmTaskTransferSchema);

export default CrmTaskTransferRequest;
