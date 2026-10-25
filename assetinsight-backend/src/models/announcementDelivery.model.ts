import mongoose, { Schema } from "mongoose";

export const ANNOUNCEMENT_DELIVERY_STATUSES = [
  "pending",
  "sending",
  "sent",
  "failed",
] as const;

const announcementDeliverySchema = new Schema(
  {
    announcement: {
      type: Schema.Types.ObjectId,
      ref: "Announcement",
      required: true,
      index: true,
    },
    user: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    recipientName: { type: String, required: true, trim: true, maxlength: 200 },
    status: {
      type: String,
      enum: ANNOUNCEMENT_DELIVERY_STATUSES,
      default: "pending",
      required: true,
      index: true,
    },
    attemptCount: { type: Number, default: 0, min: 0 },
    leaseToken: { type: String, default: null },
    leaseUntil: { type: Date, default: null, index: true },
    sentAt: { type: Date, default: null },
    providerMessageId: { type: String, default: null },
    error: { type: String, default: null, maxlength: 1000 },
  },
  { timestamps: true }
);

announcementDeliverySchema.index(
  { announcement: 1, user: 1 },
  { unique: true }
);
announcementDeliverySchema.index({ announcement: 1, status: 1, createdAt: 1 });

const AnnouncementDelivery = mongoose.model(
  "AnnouncementDelivery",
  announcementDeliverySchema
);

export default AnnouncementDelivery;
