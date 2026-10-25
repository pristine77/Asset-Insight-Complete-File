import mongoose from "mongoose";

export const CRM_LEAD_STATUSES = [
  "new_lead",
  "contacted",
  "inspection_required",
  "inspection_complete",
  "proposal_submitted",
  "decision_pending",
  "won",
  "lost",
] as const;

export type CrmLeadStatus = (typeof CRM_LEAD_STATUSES)[number];

export const CRM_LOST_REASONS = [
  "not_interested",
  "timing",
  "competitor",
  "no_assets",
] as const;

export type CrmLostReason = (typeof CRM_LOST_REASONS)[number];

// Persist before provider I/O. An unresolved operation is retained even when the
// desired follow-up changes, so its receipt cannot be orphaned by a newer save.
const crmFollowUpOutlookOperationSchema = new mongoose.Schema({
  id: { type: String, required: true },
  kind: { type: String, enum: ["create", "update", "delete"], required: true },
  state: { type: String, enum: ["prepared", "sending", "uncertain"], required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  eventId: String,
  transactionId: String,
  payload: mongoose.Schema.Types.Mixed,
  desired: mongoose.Schema.Types.Mixed,
  attemptToken: String,
  startedAt: Date,
  attempts: { type: Number, default: 0 },
}, { _id: false });

const crmLeadUpdateSchema = new mongoose.Schema(
  {
    comment: { type: String, trim: true },
    status: { type: String, enum: CRM_LEAD_STATUSES, default: "new_lead" },
    lostReason: { type: String, enum: CRM_LOST_REASONS },
    reminderDate: { type: Date },
    attachmentUrls: [{ type: String }],
    recordingUrl: { type: String },
    editedAt: { type: Date },
    isDeleted: { type: Boolean, default: false },
    deletedAt: { type: Date },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const crmLeadSchema = new mongoose.Schema(
  {
    // Only the authenticated review quick-add path can originate synthetic data.
    isReviewData: { type: Boolean, default: false, immutable: true },
    title: { type: String, trim: true, default: "CRM Follow-up" },
    clientName: { type: String, required: true, trim: true, index: true },
    companyName: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true, index: true },
    phoneRaw: { type: String, trim: true },
    phoneFormatted: { type: String, trim: true, index: true },
    contactPhones: [{ type: String, trim: true }],
    companyPhones: [{ type: String, trim: true }],
    contactMobilePhones: [{ type: String, trim: true }],
    notes: { type: String, trim: true },
    contactSocials: { type: String, trim: true },
    contactLocation: { type: String, trim: true },
    contactLinkedinUrl: { type: String, trim: true },
    companyLinkedinUrl: { type: String, trim: true },
    companyLocation: { type: String, trim: true },
    quadrant: { type: String, trim: true, index: true },
    quadrantPending: { type: Boolean, default: false, index: true },
    specialization: { type: String, trim: true, index: true },
    category: { type: String, trim: true, index: true },
    industry: { type: String, trim: true },
    website: { type: String, trim: true },
    companyWebsiteDomain: { type: String, trim: true },
    researchDate: { type: Date },
    department: { type: String, trim: true },
    seniority: { type: String, trim: true },
    companyDescription: { type: String, trim: true },
    companyAnnualRevenue: { type: Number },
    companyRevenueRange: { type: String, trim: true },
    companyStaffCount: { type: Number },
    companyStaffCountRange: { type: String, trim: true },
    companyFoundedDate: { type: Date },
    companyPostCode: { type: String, trim: true },
    leadGeo: { type: mongoose.Schema.Types.Mixed },
    assignedUserGeo: { type: mongoose.Schema.Types.Mixed },
    assignmentMethod: { type: String, trim: true, index: true },
    assignmentDistanceKm: { type: Number },
    assignmentMatchedRegion: { type: String, trim: true, index: true },
    assignmentReason: { type: String, trim: true },
    sicCode: { type: String, trim: true },
    naicsCode: { type: String, trim: true },
    importData: { type: mongoose.Schema.Types.Mixed },
    listItems: [{ type: String, trim: true }],
    listItemsNormalized: [{ type: String, trim: true }],
    identityKey: { type: String, trim: true, index: true },
    dedupeFingerprints: [{ type: String, trim: true }],
    sourceBatchId: { type: String, index: true },
    sourceFileName: { type: String, trim: true },
    sourceFileUrl: { type: String, trim: true },
    sourceFileKey: { type: String, trim: true, index: true },
    sourceFileBucket: { type: String, trim: true },
    sourceFilePublicBaseUrl: { type: String, trim: true },
    sourceSheetName: { type: String, trim: true },
    sourceRowNumber: { type: Number },
    leadSource: {
      type: String,
      enum: ["generic", "organic"],
      default: "generic",
      index: true,
    },

    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: CRM_LEAD_STATUSES,
      default: "new_lead",
      index: true,
    },
    lostReason: {
      type: String,
      enum: CRM_LOST_REASONS,
      index: true,
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium",
      index: true,
    },

    statusChangedAt: { type: Date, default: Date.now, index: true },
    taskStartDate: { type: Date, index: true },
    dueDate: { type: Date, index: true },
    dueSoonPushSentAt: { type: Date },
    overduePushSentAt: { type: Date },

    // Follow-up date the agent picked in Task Update (owner decision 2026-10-11;
    // rules in service/crmFollowUpService.ts). While one is set, dueDate follows
    // it and the automatic 7/2/30-day cadence is paused for this lead.
    followUpDate: { type: String }, // "YYYY-MM-DD" in followUpTimeZone
    followUpTime: { type: String }, // "HH:mm", absent for a date-only follow-up
    followUpTimeZone: { type: String }, // IANA zone of the phone that set it
    followUpAt: { type: Date }, // the time, or 00:00 that day when date-only
    followUpRemindAt: { type: Date }, // 08:00 that day, or 1 hour before the time
    followUpReminderSentAt: { type: Date },
    followUpOverdueRemindedAt: { type: Date }, // last daily overdue reminder
    followUpSetAt: { type: Date },
    followUpSetBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    // The follow-up's event in the assignee's Outlook calendar, kept in step by
    // the follow-up job (service/crmFollowUpOutlookService.ts).
    followUpOutlook: {
      eventId: { type: String },
      userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      syncPending: { type: Boolean },
      version: { type: Number },
      changeId: { type: String },
      attempts: { type: Number },
      nextAttemptAt: { type: Date },
      lastError: { type: String },
      syncedAt: { type: Date },
    },
    followUpOutlookOperation: { type: crmFollowUpOutlookOperationSchema, select: false },
    crmDeletionToken: { type: String, select: false },

    callAttempts: { type: Number, default: 0 },
    lastCalledAt: { type: Date },
    latestComment: { type: String, trim: true },

    latestAttachmentUrls: [{ type: String }],
    latestRecordingUrl: { type: String },

    updates: [crmLeadUpdateSchema],
  },
  { timestamps: true }
);

// Existing document saves cannot revive a follow-up after admin deletion has
// reserved its row and begun media cleanup. Provider admission uses the same gate.
crmLeadSchema.pre("save", function () {
  if (!this.isNew) this.$where = { ...this.$where, crmDeletionToken: { $exists: false } };
});

crmLeadSchema.index({ assignedTo: 1, status: 1, dueDate: 1, createdAt: -1 });
// Follow-up calendar and job: only leads with a follow-up date are indexed.
crmLeadSchema.index({ assignedTo: 1, followUpAt: 1 }, { partialFilterExpression: { followUpAt: { $exists: true } } });
crmLeadSchema.index({ followUpRemindAt: 1 }, { partialFilterExpression: { followUpRemindAt: { $exists: true } } });
crmLeadSchema.index(
  { "followUpOutlook.nextAttemptAt": 1 },
  { partialFilterExpression: { "followUpOutlook.syncPending": true } }
);
crmLeadSchema.index({ clientName: "text", email: "text", phoneFormatted: "text", notes: "text", category: "text" });
crmLeadSchema.index({ dedupeFingerprints: 1 });
crmLeadSchema.index({ assignedTo: 1, leadSource: 1, createdAt: -1 });
// Durable import retries can find rows already committed by the same source job.
crmLeadSchema.index({ sourceBatchId: 1, sourceRowNumber: 1 });

const CrmLead = mongoose.model("CrmLead", crmLeadSchema);

export default CrmLead;
