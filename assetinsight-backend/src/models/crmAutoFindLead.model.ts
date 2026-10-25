import mongoose from "mongoose";

const crmAutoFindLeadSchema = new mongoose.Schema(
  {
    fingerprint: { type: String, required: true, trim: true, unique: true, index: true },
    identityKey: { type: String, trim: true, index: true },
    status: {
      type: String,
      enum: ["previewed", "imported", "skipped"],
      default: "previewed",
      index: true,
    },
    country: { type: String, trim: true, index: true },
    regions: [{ type: String, trim: true }],
    categories: [{ type: String, trim: true }],
    keywords: { type: String, trim: true },
    lead: { type: mongoose.Schema.Types.Mixed, required: true },
    sourceUrl: { type: String, trim: true },
    sourceTitle: { type: String, trim: true },
    sourcePlatform: { type: String, trim: true },
    confidence: { type: Number, default: 0 },
    searchQuery: { type: String, trim: true },
    importedLeadId: { type: mongoose.Schema.Types.ObjectId, ref: "CrmLead", index: true },
    foundBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    importedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true },
    importedAt: { type: Date },
  },
  { timestamps: true }
);

crmAutoFindLeadSchema.index({ country: 1, createdAt: -1 });
crmAutoFindLeadSchema.index({ sourceUrl: 1 });

const CrmAutoFindLead = mongoose.model("CrmAutoFindLead", crmAutoFindLeadSchema);

export default CrmAutoFindLead;
