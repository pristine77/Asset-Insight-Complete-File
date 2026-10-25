import mongoose, { Document, Schema } from "mongoose";

export const DEVICE_STATUSES = [
  "pending",
  "rerequest_pending",
  "approved",
  "rejected",
  "revoked",
] as const;

export type DeviceStatus = (typeof DEVICE_STATUSES)[number];

export interface IDeviceRegistration extends Document {
  user: mongoose.Types.ObjectId;
  installationKeyHash: string;
  reinstallIdentityHash?: string;
  platform: "web" | "android" | "ios";
  formFactor: "desktop" | "mobile" | "tablet";
  displayName: string;
  metadata: Record<string, unknown>;
  status: DeviceStatus;
  requestCount: number;
  requestHistory: Date[];
  lastRequestAt?: Date;
  lastRerequestAt?: Date;
  sessionVersion: number;
  decidedBy?: mongoose.Types.ObjectId;
  decidedAt?: Date;
  decisionReason?: string;
  approvedVia?: "device" | "all_devices";
  lastSeenAt?: Date;
  lastIp?: string;
  createdAt: Date;
  updatedAt: Date;
}

const deviceRegistrationSchema = new Schema<IDeviceRegistration>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    installationKeyHash: { type: String, required: true, select: false },
    reinstallIdentityHash: { type: String, maxlength: 64, select: false },
    platform: {
      type: String,
      enum: ["web", "android", "ios"],
      required: true,
      index: true,
    },
    formFactor: {
      type: String,
      enum: ["desktop", "mobile", "tablet"],
      required: true,
    },
    displayName: { type: String, required: true, maxlength: 160 },
    metadata: { type: Schema.Types.Mixed, default: {} },
    status: {
      type: String,
      enum: DEVICE_STATUSES,
      default: "pending",
      required: true,
      index: true,
    },
    requestCount: { type: Number, default: 1, min: 1 },
    requestHistory: { type: [Date], default: [] },
    lastRequestAt: { type: Date, index: true },
    lastRerequestAt: Date,
    sessionVersion: { type: Number, default: 0, min: 0 },
    decidedBy: { type: Schema.Types.ObjectId, ref: "User" },
    decidedAt: Date,
    decisionReason: { type: String, maxlength: 1000 },
    approvedVia: { type: String, enum: ["device", "all_devices"] },
    lastSeenAt: Date,
    lastIp: { type: String, maxlength: 64 },
  },
  { timestamps: true }
);

deviceRegistrationSchema.index(
  { user: 1, installationKeyHash: 1 },
  { unique: true, name: "unique_user_installation" }
);
deviceRegistrationSchema.index(
  { user: 1, platform: 1, reinstallIdentityHash: 1 },
  {
    unique: true,
    name: "unique_user_native_reinstall_identity",
    partialFilterExpression: { reinstallIdentityHash: { $type: "string" } },
  }
);
deviceRegistrationSchema.index({ status: 1, createdAt: -1 });
deviceRegistrationSchema.index({ user: 1, status: 1, updatedAt: -1 });

export default mongoose.models.DeviceRegistration ||
  mongoose.model<IDeviceRegistration>("DeviceRegistration", deviceRegistrationSchema);
