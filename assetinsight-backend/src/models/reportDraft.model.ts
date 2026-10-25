import mongoose from "mongoose";

const reportDraftMediaSchema = new mongoose.Schema(
  {
    // clientFileId is stable across autosaves and devices. Never use an array
    // index as media identity because inserting/deleting a photo would shift
    // every following image into the wrong lot on restore.
    clientFileId: { type: String, trim: true },
    localKey: { type: String, trim: true },
    mediaId: { type: String, trim: true },
    lotId: { type: String, trim: true },
    slot: { type: String, enum: ["main", "extra", "video"] },
    index: Number,
    captureOrder: Number,
    originalOrder: Number,
    name: { type: String, trim: true },
    mimeType: { type: String, trim: true },
    size: Number,
    verifiedSize: Number,
    lastModified: Number,
    r2Key: { type: String, trim: true },
    // Media in one draft may span storage generations. Missing metadata marks
    // pre-cutover media and resolves to the legacy, read-only target.
    r2Bucket: { type: String, trim: true },
    r2PublicBaseUrl: { type: String, trim: true },
    uploadedAt: Date,
  },
  { _id: false }
);

const reportDraftSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    // Contract numbers are editable and may be blank early in a draft. This
    // stable client id is the only identity used for autosave/idempotency.
    clientDraftId: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: ["asset", "lotListing"],
      required: true,
      index: true,
    },
    storageMode: {
      type: String,
      enum: ["local_media", "r2_media", "smart_upload"],
      default: "r2_media",
      required: true,
    },
    smartUploadSession: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ReportUploadSession",
    },
    revision: { type: Number, default: 0, min: 0 },
    // Independent CAS fence for the server-owned R2 media manifest. Draft
    // metadata revisions and upload/confirm/delete requests can advance on
    // different HTTP connections, so neither may replace a stale manifest.
    mediaRevision: { type: Number, default: 0, min: 0, select: false },
    // Canonical hash of the metadata owned by this revision. It makes an exact
    // network retry idempotent while rejecting a different payload that reuses
    // the same revision number from another tab/device.
    contentHash: { type: String, trim: true },
    deviceId: { type: String, trim: true, default: "" },
    contractNo: { type: String, trim: true, default: "" },
    normalizedContractNo: { type: String, trim: true, lowercase: true, default: "" },
    title: { type: String, trim: true, default: "" },
    formData: { type: mongoose.Schema.Types.Mixed, default: {} },
    lots: { type: mongoose.Schema.Types.Mixed, default: [] },
    activeLotIdx: { type: Number, default: 0 },
    // Mongo stores the ordered manifest; original bytes live in R2. Smart
    // Upload media continues to live in its durable upload session.
    media: { type: [reportDraftMediaSchema], default: [] },
    // Draft previews are revision-bound. A stale worker may finish after the
    // user saves a newer revision, so lifecycle writes are revision-guarded.
    previewStatus: {
      type: String,
      enum: ["idle", "queued", "processing", "ready", "error"],
      default: "idle",
      index: true,
    },
    previewReportId: { type: mongoose.Schema.Types.ObjectId },
    previewJobId: { type: String, trim: true },
    previewRequestedRevision: { type: Number, min: 0 },
    previewProcessedRevision: { type: Number, min: 0 },
    previewError: { type: String, trim: true },
    previewRequestedAt: Date,
    previewReadyAt: Date,
    // A promoted draft is retained as a small idempotency/audit record. Its
    // media manifest must not be physically deleted here because generated
    // reports (especially unwatermarked Lot Listing media and videos) may
    // still reference those objects.
    promotedReportId: { type: mongoose.Schema.Types.ObjectId },
    promotedAt: Date,
    promotedSubmitted: { type: Boolean },
    promotionToken: { type: String, trim: true },
    promotionClaimedAt: Date,
    // Autosave remains non-destructive: conflicts are persisted for immediate
    // client feedback, while preview processing enforces the uniqueness rule.
    duplicateLotConflicts: { type: [mongoose.Schema.Types.Mixed], default: [] },
    reviewReminderSentAt: Date,
    reviewReminderClaimedAt: Date,
    reviewReminderError: { type: String, trim: true },
    reviewReminderRecipientIds: {
      type: [mongoose.Schema.Types.ObjectId],
      ref: "User",
      default: [],
    },
  },
  { timestamps: true }
);

reportDraftSchema.index(
  { user: 1, type: 1, clientDraftId: 1 },
  {
    unique: true,
    name: "report_draft_client_identity",
    // Deployments may briefly contain legacy rows while the backfill script
    // runs. Excluding missing ids keeps index creation safe during rollout.
    partialFilterExpression: { clientDraftId: { $type: "string" } },
  }
);
reportDraftSchema.index({ user: 1, updatedAt: -1 });
reportDraftSchema.index({ user: 1, type: 1, normalizedContractNo: 1, updatedAt: -1 });
reportDraftSchema.index({ previewStatus: 1, updatedAt: -1 });
reportDraftSchema.index({ user: 1, promotedAt: 1, updatedAt: -1 });
reportDraftSchema.index({ reviewReminderSentAt: 1, reviewReminderClaimedAt: 1, updatedAt: 1 });

reportDraftSchema.plugin(reportActivityPlugin, { model: "ReportDraft" });
const ReportDraft = mongoose.model("ReportDraft", reportDraftSchema);

export default ReportDraft;
import { reportActivityPlugin } from "../utils/reportActivityPlugin.js";
