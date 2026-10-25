import mongoose, { Schema } from "mongoose";

/** Minimal permanent realm marker. Account/security deletion intentionally must
 * not promote retained review reports into customer-facing feeds. No contact,
 * credential, device or report contents are stored here. */
const schema = new Schema({
  _id: { type: Schema.Types.ObjectId, required: true },
  enrollmentAudit: { type: Schema.Types.ObjectId, required: true, immutable: true },
}, { timestamps: { createdAt: true, updatedAt: false } });

export default mongoose.models.ReviewAccountBoundary || mongoose.model("ReviewAccountBoundary", schema);
