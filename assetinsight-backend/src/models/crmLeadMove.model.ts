/**
 * One admin bulk move of CRM leads from one owner to another (owner,
 * 2026-11-20: "Tanner has 15,000 leads from Winnipeg but he is now the sales
 * person in Edmonton"). Leads keep no history of their owners, so every move
 * is recorded here: who moved how many and which leads, from whom to whom,
 * under which filters. Written once, never changed.
 */
import mongoose, { Document, Schema } from "mongoose";

export interface ICrmLeadMove extends Document {
  fromUserId: mongoose.Types.ObjectId;
  toUserId: mongoose.Types.ObjectId;
  fromLabel: string;
  toLabel: string;
  movedBy: mongoose.Types.ObjectId;
  filters: Record<string, unknown>;
  leadIds: mongoose.Types.ObjectId[];
  count: number;
  createdAt: Date;
}

const crmLeadMoveSchema = new Schema<ICrmLeadMove>(
  {
    fromUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true, index: true },
    toUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true, index: true },
    fromLabel: { type: String, required: true, immutable: true },
    toLabel: { type: String, required: true, immutable: true },
    movedBy: { type: Schema.Types.ObjectId, ref: "User", required: true, immutable: true },
    filters: { type: Schema.Types.Mixed, default: {}, immutable: true },
    leadIds: { type: [Schema.Types.ObjectId], default: [], immutable: true },
    count: { type: Number, required: true, immutable: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

crmLeadMoveSchema.index({ createdAt: -1 });

export default mongoose.model<ICrmLeadMove>("CrmLeadMove", crmLeadMoveSchema);
