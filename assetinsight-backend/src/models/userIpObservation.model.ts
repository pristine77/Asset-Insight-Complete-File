import mongoose, { Document, Schema } from "mongoose";

export interface IUserIpObservation extends Document {
  user: mongoose.Types.ObjectId;
  ip: string;
  devices: mongoose.Types.ObjectId[];
  firstSeenAt: Date;
  lastSeenAt: Date;
  count: number;
  source: "observed" | "admin";
  blocked: boolean;
  blockReason?: string;
  blockedAt?: Date;
  blockedBy?: mongoose.Types.ObjectId;
  unblockedAt?: Date;
  unblockedBy?: mongoose.Types.ObjectId;
}

const userIpObservationSchema = new Schema<IUserIpObservation>(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    ip: { type: String, required: true, maxlength: 64 },
    devices: [{ type: Schema.Types.ObjectId, ref: "DeviceRegistration" }],
    firstSeenAt: { type: Date, default: Date.now, required: true },
    lastSeenAt: { type: Date, default: Date.now, required: true, index: true },
    count: { type: Number, default: 1, min: 0 },
    source: { type: String, enum: ["observed", "admin"], default: "observed" },
    blocked: { type: Boolean, default: false, index: true },
    blockReason: { type: String, maxlength: 1000 },
    blockedAt: Date,
    blockedBy: { type: Schema.Types.ObjectId, ref: "User" },
    unblockedAt: Date,
    unblockedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

userIpObservationSchema.index(
  { user: 1, ip: 1 },
  { unique: true, name: "unique_user_ip" }
);
userIpObservationSchema.index({ blocked: 1, lastSeenAt: -1 });

export default mongoose.models.UserIpObservation ||
  mongoose.model<IUserIpObservation>("UserIpObservation", userIpObservationSchema);
