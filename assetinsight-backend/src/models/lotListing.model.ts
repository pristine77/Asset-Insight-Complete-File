import { DEFAULT_WATERMARK_IMAGES } from "../utils/photoWatermarkPolicy.js";
import mongoose, { Schema, Document } from "mongoose";
import { attachReportImageDeletionHooks } from "../utils/reportImageDeletionPlugin.js";
import { normalizeReportContractKey } from "../utils/reportContractIdentity.js";

export type LotListingMode = "single_lot" | "per_item" | "per_photo";
export type LotListingValuationMethod = "FML" | "TKV" | "OLV" | "FLV";

export interface ILotListingLot {
  lot_id: string;
  auctioneer_source_key?: string;
  auctioneer_source_parent_key?: string;
  lot_number: string | number;
  title?: string;
  description?: string;
  details?: string;
  damage_analysis?: string;
  condition_report_specs?: Record<string, string>;
  condition_report_specs_reviewed?: boolean;
  condition_report_specs_manual_overrides?: Record<string, string>;
  condition_report_specs_deleted?: string[];
  condition_report_specs_custom_order?: string[];
  analysis_metadata?: Record<string, unknown>;
  lotted_by?: string;
  condition_report_selections?: {
    condition?: string;
    completeness?: string;
    legal?: string;
  };
  estimated_value?: string; // FMV as string
  quantity?: number;
  must_take?: boolean;
  categories?: string;
  serial_number?: string; // VIN/SN
  show_on_website?: boolean;
  close_date?: string;
  bid_increment?: number;
  location?: string;
  opening_bid?: number;
  latitude?: number;
  longitude?: number;
  item_condition?: string;
  image_indexes: number[];
  image_urls?: string[];
  extra_image_indexes?: number[];
  extra_image_urls?: string[];
  video_urls?: string[];
  cover_index?: number;
  sub_mode?: LotListingMode;
  tags?: string[];
}

export interface ILotListing extends Document {
  user: mongoose.Schema.Types.ObjectId;
  contract_no: string;
  contract_key?: string;
  sales_date: Date;
  location: string;
  latitude?: number;
  longitude?: number;
  imageUrls: string[];
  videoUrls: string[];
  lots: ILotListingLot[];
  mixed_lots?: Array<{
    count: number;
    extra_count?: number;
    video_count?: number;
    cover_index?: number;
    mode: LotListingMode;
  }>;
  status: 'processing' | 'preview' | 'pending_approval' | 'approved' | 'declined' | 'completed' | 'error';
  preview_data?: {
    contract_no?: string;
    sales_date?: string;
    location?: string;
    latitude?: number;
    longitude?: number;
    inspector_name?: string;
    currency?: string;
    total_value?: number;
    include_damage_analysis?: boolean;
    bank_photos_enabled?: boolean;
    watermark_images?: boolean;
    valuation_methods?: LotListingValuationMethod[];
    cr_disclaimers?: Record<string, any>;
    cr_disclaimers_by_lot?: Record<string, any>;
    deleted_image_indexes?: number[];
    deleted_image_urls?: string[];
    lots?: ILotListingLot[];
    videoUrls?: string[];
  };
  preview_files?: {
    spec_pdf?: string;
    schedule_a_pdf?: string;
    cr_docx?: string;
    excel?: string;
    images?: string;
  };
  files?: {
    spec_pdf?: string;
    schedule_a_pdf?: string;
    cr_docx?: string;
    excel?: string;
    images?: string;
  };
  decline_reason?: string;
  analysis?: any;
  total_value?: number;
  include_damage_analysis?: boolean;
  bank_photos_enabled?: boolean;
  watermark_images?: boolean;
  valuation_methods?: LotListingValuationMethod[];
  language?: string;
  currency?: string;
  error_message?: string;
  job_id?: string;
  client_submission_id?: string;
  capture_id?: string;
  /** Crash-safe unique lease for one active initial submission per contract. */
  submission_contract_claim?: string;
  /** Explicit duplicate override; distinguishes intentional force-new rows from legacy claimless rows. */
  submission_contract_claim_bypassed?: boolean;
  is_draft_preview?: boolean;
  source_draft_id?: mongoose.Schema.Types.ObjectId;
  source_draft_revision?: number;
  job_status?: 'queued' | 'processing' | 'done' | 'error';
  /** Per-claim durable-worker owner; distinct from the logical job_id. */
  job_execution_token?: string;
  /** Pending atomic handoff to the durable ReportJob collection. */
  report_job_outbox?: Record<string, unknown>;
  youtube_videos_enabled?: boolean;
  youtube_submission?: Record<string, unknown>;
  report_recovery?: Record<string, unknown>;
  report_recovery_history?: Array<Record<string, unknown>>;
  job_error?: string;
  queued_at?: Date;
  processing_started_at?: Date;
  processing_completed_at?: Date;
  generation_target_status?: 'preview' | 'pending_approval' | 'approved';
  generation_progress?: Record<string, any>;
  artifact_publish_token?: string;
  artifact_publish_generation_token?: string;
  artifact_publish_expires_at?: Date;
  cr_artifact_source_fingerprint?: string;
  artifact_repair_required?: boolean;
  files_generating?: boolean;
  files_regenerating?: boolean;
  excel_regenerating?: boolean;
  excel_cr_regeneration_claim_token?: string;
  excel_cr_regeneration_claimed_at?: Date;
  excel_regenerated_at?: Date;
  excel_regeneration_error?: string;
  preview_submitted_at?: Date;
  preview_transferred_from?: mongoose.Schema.Types.ObjectId | null;
  preview_transferred_to?: mongoose.Schema.Types.ObjectId | null;
  preview_transferred_by?: mongoose.Schema.Types.ObjectId | null;
  preview_transferred_at?: Date | null;
  preview_reminder_sent_at?: Date | null;
  preview_reminder_sent_by?: mongoose.Schema.Types.ObjectId | null;
  preview_reminder_message?: string;
  preview_reminder_delivery_id?: string;
  preview_reminder_claimed_at?: Date | null;
  preview_reminder_error?: string;
  preview_reminder_recipient_ids?: mongoose.Schema.Types.ObjectId[];
  preview_transfer_history?: Array<{
    fromUser: mongoose.Schema.Types.ObjectId;
    toUser: mongoose.Schema.Types.ObjectId;
    transferredBy: mongoose.Schema.Types.ObjectId;
    transferredAt: Date;
  }>;
  approval_requested_at?: Date;
  approval_processed_at?: Date;
  approval_assigned_to?: mongoose.Schema.Types.ObjectId | null;
  approval_assigned_at?: Date | null;
  approval_assigned_source?: string;
  approval_assignment_email_sent_at?: Date | null;
  approval_assignment_email_claim_token?: string | null;
  auctioneerWorkItem?: mongoose.Schema.Types.ObjectId | null;
  release_status?: 'pending_release' | 'released';
  release_assigned_to?: mongoose.Schema.Types.ObjectId | null;
  release_assigned_at?: Date | null;
  release_assigned_source?: string;
  release_assignment_email_sent_at?: Date | null;
  release_assignment_email_claim_token?: string | null;
  released_by?: mongoose.Schema.Types.ObjectId | null;
  released_at?: Date | null;
  adminArchivedAt?: Date | null;
  adminArchivedBy?: mongoose.Schema.Types.ObjectId | null;
  auctionsoft?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const LotListingLotSchema: Schema<ILotListingLot> = new Schema(
  {
    lot_id: { type: String, required: true },
    auctioneer_source_key: { type: String },
    auctioneer_source_parent_key: { type: String },
    lot_number: { type: Schema.Types.Mixed, required: true },
    title: { type: String },
    description: { type: String },
    details: { type: String },
    damage_analysis: { type: String },
    condition_report_specs: { type: Schema.Types.Mixed, default: undefined },
    condition_report_specs_reviewed: { type: Boolean },
    condition_report_specs_manual_overrides: { type: Schema.Types.Mixed, default: undefined },
    condition_report_specs_deleted: [{ type: String }],
    condition_report_specs_custom_order: [{ type: String }],
    analysis_metadata: { type: Schema.Types.Mixed, default: undefined },
    lotted_by: { type: String },
    condition_report_selections: {
      condition: { type: String },
      completeness: { type: String },
      legal: { type: String },
    },
    estimated_value: { type: String }, // FMV as string
    quantity: { type: Number, default: 1 },
    must_take: { type: Boolean },
    categories: { type: String },
    serial_number: { type: String }, // VIN/SN
    show_on_website: { type: Boolean, default: true },
    close_date: { type: String },
    bid_increment: { type: Number },
    location: { type: String },
    opening_bid: { type: Number },
    latitude: { type: Number, min: -90, max: 90 },
    longitude: { type: Number, min: -180, max: 180 },
    item_condition: { type: String, default: "Unverified Working Condition" },
    image_indexes: [{ type: Number, required: true }],
    image_urls: [{ type: String }],
    extra_image_indexes: [{ type: Number }],
    extra_image_urls: [{ type: String }],
    video_urls: [{ type: String }],
    cover_index: { type: Number },
    sub_mode: { type: String, enum: ["single_lot", "per_item", "per_photo"] },
    tags: [{ type: String }],
  },
  { _id: false }
);

const MixedLotMappingSchema = new Schema(
  {
    count: { type: Number, required: true },
    extra_count: { type: Number, default: 0 },
    video_count: { type: Number, default: 0 },
    cover_index: { type: Number, default: 0 },
    mode: { type: String, enum: ["single_lot", "per_item", "per_photo"], required: true },
  },
  { _id: false }
);

const LotListingSchema: Schema<ILotListing> = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    contract_no: { type: String, required: true },
    contract_key: { type: String, index: true },
    sales_date: { type: Date, required: true },
    location: { type: String, required: true },
    latitude: { type: Number, min: -90, max: 90 },
    longitude: { type: Number, min: -180, max: 180 },
    imageUrls: [{ type: String, required: true }],
    videoUrls: [{ type: String }],
    lots: { type: [LotListingLotSchema], default: [] },
    mixed_lots: { type: [MixedLotMappingSchema], default: [] },
    status: {
      type: String,
      enum: ['processing', 'preview', 'pending_approval', 'approved', 'declined', 'completed', 'error'],
      default: 'processing',
      required: true,
    },
    preview_data: {
      contract_no: { type: String },
      sales_date: { type: String },
      location: { type: String },
      latitude: { type: Number, min: -90, max: 90 },
      longitude: { type: Number, min: -180, max: 180 },
      inspector_name: { type: String },
      currency: { type: String },
      total_value: { type: Number },
      include_damage_analysis: { type: Boolean, default: true },
      bank_photos_enabled: { type: Boolean, default: false },
      // Omitted preview preferences inherit the root report choice. A nested
      // default would silently override that choice when hydrating older reports.
      watermark_images: { type: Boolean },
      valuation_methods: {
        type: [String],
        enum: ["FML", "TKV", "OLV", "FLV"],
        default: ["FML"],
      },
      cr_disclaimers: { type: Schema.Types.Mixed },
      cr_disclaimers_by_lot: { type: Schema.Types.Mixed },
      deleted_image_indexes: [{ type: Number }],
      deleted_image_urls: [{ type: String }],
      lots: { type: [LotListingLotSchema], default: [] },
      videoUrls: [{ type: String }],
    },
    preview_files: {
      spec_pdf: { type: String },
      schedule_a_pdf: { type: String },
      cr_docx: { type: String },
      excel: { type: String },
      images: { type: String },
    },
    files: {
      spec_pdf: { type: String },
      schedule_a_pdf: { type: String },
      cr_docx: { type: String },
      excel: { type: String },
      images: { type: String },
    },
    decline_reason: { type: String },
    analysis: { type: Schema.Types.Mixed },
    total_value: { type: Number },
    include_damage_analysis: { type: Boolean, default: true },
    bank_photos_enabled: { type: Boolean, default: false },
    watermark_images: { type: Boolean, default: DEFAULT_WATERMARK_IMAGES },
    valuation_methods: {
      type: [String],
      enum: ["FML", "TKV", "OLV", "FLV"],
      default: ["FML"],
    },
    language: { type: String, default: "en" },
    currency: { type: String, default: "CAD" },
    error_message: { type: String },
    job_id: { type: String },
    client_submission_id: { type: String },
    capture_id: { type: String },
    submission_contract_claim: { type: String, select: false },
    submission_contract_claim_bypassed: { type: Boolean, select: false },
    // Internal analysis snapshot for a saved draft. It is deliberately hidden
    // from submitted previews and approved report lists.
    is_draft_preview: { type: Boolean, default: false, index: true },
    source_draft_id: { type: Schema.Types.ObjectId, ref: "ReportDraft", index: true },
    source_draft_revision: { type: Number },
    job_status: { type: String, enum: ['queued', 'processing', 'done', 'error'] },
    job_execution_token: { type: String, select: false },
    report_job_outbox: { type: Schema.Types.Mixed, select: false },
    youtube_videos_enabled: { type: Boolean },
    youtube_submission: { type: Schema.Types.Mixed, select: false },
    report_recovery: { type: Schema.Types.Mixed, select: false },
    report_recovery_history: { type: [Schema.Types.Mixed], select: false, default: undefined },
    job_error: { type: String },
    queued_at: { type: Date },
    processing_started_at: { type: Date },
    processing_completed_at: { type: Date },
    generation_target_status: { type: String, enum: ['preview', 'pending_approval', 'approved'] },
    generation_progress: { type: Schema.Types.Mixed },
    artifact_publish_token: { type: String },
    artifact_publish_generation_token: { type: String },
    artifact_publish_expires_at: { type: Date },
    cr_artifact_source_fingerprint: { type: String },
    artifact_repair_required: { type: Boolean, default: false },
    files_generating: { type: Boolean, default: false },
    files_regenerating: { type: Boolean, default: false },
    excel_regenerating: { type: Boolean, default: false },
    excel_cr_regeneration_claim_token: { type: String },
    excel_cr_regeneration_claimed_at: { type: Date },
    excel_regenerated_at: { type: Date },
    excel_regeneration_error: { type: String },
    preview_submitted_at: { type: Date },
    preview_transferred_from: { type: Schema.Types.ObjectId, ref: "User", default: null },
    preview_transferred_to: { type: Schema.Types.ObjectId, ref: "User", default: null },
    preview_transferred_by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    preview_transferred_at: { type: Date, default: null },
    preview_reminder_sent_at: { type: Date, default: null },
    preview_reminder_sent_by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    preview_reminder_message: { type: String },
    preview_reminder_delivery_id: { type: String, select: false },
    preview_reminder_claimed_at: { type: Date, default: null },
    preview_reminder_error: { type: String },
    preview_reminder_recipient_ids: {
      type: [Schema.Types.ObjectId],
      ref: "User",
      default: [],
    },
    preview_transfer_history: {
      type: [
        {
          fromUser: { type: Schema.Types.ObjectId, ref: "User", required: true },
          toUser: { type: Schema.Types.ObjectId, ref: "User", required: true },
          transferredBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
          transferredAt: { type: Date, required: true },
        },
      ],
      default: [],
    },
    approval_requested_at: { type: Date },
    approval_processed_at: { type: Date },
    approval_assigned_to: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    approval_assigned_at: { type: Date, default: null },
    approval_assigned_source: { type: String },
    approval_assignment_email_sent_at: { type: Date, default: null },
    approval_assignment_email_claim_token: { type: String, select: false },
    auctioneerWorkItem: {
      type: Schema.Types.ObjectId,
      ref: "AuctioneerWorkItem",
      default: null,
    },
    release_status: { type: String, enum: ['pending_release', 'released'], default: undefined, index: true },
    release_assigned_to: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    release_assigned_at: { type: Date, default: null },
    release_assigned_source: { type: String },
    release_assignment_email_sent_at: { type: Date, default: null },
    release_assignment_email_claim_token: { type: String, select: false },
    released_by: { type: Schema.Types.ObjectId, ref: "User", default: null },
    released_at: { type: Date, default: null },
    adminArchivedAt: { type: Date, default: null },
    adminArchivedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    auctionsoft: { type: Schema.Types.Mixed, default: undefined },
  },
  { timestamps: true }
);

LotListingSchema.pre("validate", function normalizeContractKey() {
  const listing = this as ILotListing;
  const contract = normalizeReportContractKey(
    listing.contract_no || listing.preview_data?.contract_no || ""
  );
  listing.contract_key = contract || undefined;
});

attachReportImageDeletionHooks(LotListingSchema, "lotListing");

LotListingSchema.index({ status: 1, createdAt: -1 });
LotListingSchema.index({ user: 1, createdAt: -1 });
LotListingSchema.index({ is_draft_preview: 1, user: 1, updatedAt: -1 });
LotListingSchema.index({ status: 1, updatedAt: -1 });
LotListingSchema.index({
  preview_reminder_sent_at: 1,
  preview_reminder_claimed_at: 1,
  status: 1,
  processing_completed_at: 1,
  updatedAt: 1,
});
LotListingSchema.index({ job_status: 1, updatedAt: -1 });
LotListingSchema.index({ status: 1, contract_no: 1 });
LotListingSchema.index({ user: 1, contract_key: 1, createdAt: -1 });
LotListingSchema.index({ status: 1, adminArchivedAt: 1, createdAt: -1 });
LotListingSchema.index({ status: 1, release_status: 1, release_assigned_to: 1, createdAt: -1 });
LotListingSchema.index({ auctioneerWorkItem: 1, createdAt: -1 });
LotListingSchema.index({ "auctionsoft.taskId": 1 });
LotListingSchema.index(
  { "report_job_outbox.type": 1, "report_job_outbox.createdAt": 1 },
  {
    name: "lot_listing_report_job_outbox_dispatch",
    partialFilterExpression: { "report_job_outbox.token": { $type: "string" } },
  }
);
LotListingSchema.index(
  { user: 1, client_submission_id: 1 },
  {
    unique: true,
    partialFilterExpression: { client_submission_id: { $type: "string" } },
  }
);
LotListingSchema.plugin(reportActivityPlugin, { model: "LotListing" });
const LotListing = mongoose.model<ILotListing>("LotListing", LotListingSchema);
export default LotListing;
import { reportActivityPlugin } from "../utils/reportActivityPlugin.js";
