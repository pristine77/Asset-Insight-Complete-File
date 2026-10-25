import mongoose from "mongoose";

const crmAutoFindRunSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ["queued", "running", "stopping", "cancelled", "completed", "failed"],
      default: "queued",
      index: true,
    },
    criteria: { type: mongoose.Schema.Types.Mixed, default: {} },
    totalBatches: { type: Number, default: 10 },
    completedBatches: { type: Number, default: 0 },
    failedBatches: { type: Number, default: 0 },
    progress: { type: Number, default: 0 },
    message: { type: String, default: "Queued" },
    items: { type: [mongoose.Schema.Types.Mixed], default: [] },
    rawJson: { type: mongoose.Schema.Types.Mixed, default: {} },
    searched: { type: Number, default: 0 },
    duplicateCount: { type: Number, default: 0 },
    error: { type: String },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    cancelRequestedAt: { type: Date },
    cancelledAt: { type: Date },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    startedAt: { type: Date },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

crmAutoFindRunSchema.index({ createdBy: 1, createdAt: -1 });
crmAutoFindRunSchema.index({ status: 1, updatedAt: -1 });

const CrmAutoFindRun = mongoose.model("CrmAutoFindRun", crmAutoFindRunSchema);

export default CrmAutoFindRun;
