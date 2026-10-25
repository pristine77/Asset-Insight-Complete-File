import mongoose, { Schema } from "mongoose";

// Independent of work-item lifetime: deleting a local report cannot undo an
// uncertain or confirmed remote close. No TTL may resurrect delivery permission.
const schema = new Schema({
  _id: { type: String, required: true },
  user: { type: Schema.Types.ObjectId, required: true },
  contractId: { type: String, required: true },
  status: { type: String, enum: ["pending", "confirmed", "reopen_pending", "open"], required: true },
  closedAt: Date,
  taskCompleted: Boolean,
  userStatus: String,
  accessRevision: Schema.Types.Mixed,
  reopenCycleKey: String,
  reopenAttemptId: String,
  reopenedAt: Date,
}, { timestamps: true });

export default mongoose.models.AuctioneerContractClose ||
  mongoose.model("AuctioneerContractClose", schema);
