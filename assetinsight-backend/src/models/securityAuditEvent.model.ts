import mongoose, { Document, Schema } from "mongoose";

export interface ISecurityAuditEvent extends Document {
  action: string;
  actorType: "admin" | "user" | "system";
  actor?: mongoose.Types.ObjectId;
  targetUser?: mongoose.Types.ObjectId;
  device?: mongoose.Types.ObjectId;
  ipObservation?: mongoose.Types.ObjectId;
  reason?: string;
  before?: unknown;
  after?: unknown;
  requestIp?: string;
  userAgent?: string;
  createdAt: Date;
}

const securityAuditEventSchema = new Schema<ISecurityAuditEvent>(
  {
    action: { type: String, required: true, index: true, immutable: true },
    actorType: {
      type: String,
      enum: ["admin", "user", "system"],
      required: true,
      immutable: true,
    },
    actor: { type: Schema.Types.ObjectId, ref: "User", immutable: true },
    targetUser: {
      type: Schema.Types.ObjectId,
      ref: "User",
      index: true,
      immutable: true,
    },
    device: {
      type: Schema.Types.ObjectId,
      ref: "DeviceRegistration",
      index: true,
      immutable: true,
    },
    ipObservation: {
      type: Schema.Types.ObjectId,
      ref: "UserIpObservation",
      immutable: true,
    },
    reason: { type: String, maxlength: 1000, immutable: true },
    before: { type: Schema.Types.Mixed, immutable: true },
    after: { type: Schema.Types.Mixed, immutable: true },
    requestIp: { type: String, maxlength: 64, immutable: true },
    userAgent: { type: String, maxlength: 500, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

securityAuditEventSchema.index({ targetUser: 1, createdAt: -1 });
securityAuditEventSchema.index({ device: 1, createdAt: -1 });

export default mongoose.models.SecurityAuditEvent ||
  mongoose.model<ISecurityAuditEvent>("SecurityAuditEvent", securityAuditEventSchema);
