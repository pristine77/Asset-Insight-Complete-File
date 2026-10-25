import mongoose, { Document, Schema } from "mongoose";

export interface IDeviceAccessChallenge extends Document {
  tokenHash: string;
  purpose: "enrollment" | "status";
  user: mongoose.Types.ObjectId;
  device?: mongoose.Types.ObjectId;
  installationKeyHash?: string;
  reinstallIdentityHash?: string;
  expiresAt: Date;
  consumedAt?: Date;
  createdIp?: string;
  createdAt: Date;
  updatedAt: Date;
}

const deviceAccessChallengeSchema = new Schema<IDeviceAccessChallenge>(
  {
    tokenHash: { type: String, required: true, unique: true, select: false },
    purpose: { type: String, enum: ["enrollment", "status"], required: true },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    device: { type: Schema.Types.ObjectId, ref: "DeviceRegistration", index: true },
    installationKeyHash: { type: String, maxlength: 64, select: false },
    reinstallIdentityHash: { type: String, maxlength: 64, select: false },
    expiresAt: { type: Date, required: true, index: true },
    consumedAt: Date,
    createdIp: { type: String, maxlength: 64 },
  },
  { timestamps: true }
);

deviceAccessChallengeSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: "expire_device_challenges" }
);
deviceAccessChallengeSchema.index({ user: 1, purpose: 1, createdAt: -1 });

export default mongoose.models.DeviceAccessChallenge ||
  mongoose.model<IDeviceAccessChallenge>(
    "DeviceAccessChallenge",
    deviceAccessChallengeSchema
  );
