import mongoose, { Schema, Document } from "mongoose";

export interface IApiKey extends Document {
  name: string;
  keyId: string;
  secretHash: string;
  last4: string;
  createdBy: mongoose.Schema.Types.ObjectId;
  lastUsedAt?: Date;
  revokedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ApiKeySchema: Schema<IApiKey> = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    keyId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    secretHash: {
      type: String,
      required: true,
      select: false,
    },
    last4: {
      type: String,
      required: true,
      maxlength: 4,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    lastUsedAt: {
      type: Date,
    },
    revokedAt: {
      type: Date,
      index: true,
    },
  },
  { timestamps: true }
);

ApiKeySchema.index({ revokedAt: 1, createdAt: -1 });

const ApiKey = mongoose.model<IApiKey>("ApiKey", ApiKeySchema);

export default ApiKey;
