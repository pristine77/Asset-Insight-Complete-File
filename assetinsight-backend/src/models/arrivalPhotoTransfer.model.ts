import mongoose from "mongoose";

// The built-in unique _id fences one actor/request transfer across API workers.
// Retain receipts after completion so a lost HTTP reply never resends photos.
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  userId: { type: String, required: true },
  requestId: { type: String, required: true },
  manifest: { type: String, required: true },
  state: { type: String, enum: ["ready", "sending", "uncertain", "complete"], required: true },
  attempt: String,
  nextIndex: { type: Number, default: 0 },
  stored: { type: Number, default: 0 },
  skipped: { type: Number, default: 0 },
  photoCount: { type: Number, default: 0 },
}, { timestamps: true, versionKey: false });
export default mongoose.model("ArrivalPhotoTransfer", schema);
