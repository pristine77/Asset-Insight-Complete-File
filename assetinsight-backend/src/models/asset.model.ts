import { DEFAULT_WATERMARK_IMAGES } from "../utils/photoWatermarkPolicy.js";
import mongoose, { Schema, Document } from "mongoose";
import { attachReportImageDeletionHooks } from "../utils/reportImageDeletionPlugin.js";
import { normalizeReportContractKey } from "../utils/reportContractIdentity.js";

export type AssetGroupingMode =
  | "single_lot"
  | "per_item"
  | "per_photo"
  | "catalogue"
  | "combined"
  | "mixed";

export interface ICatalogueItem {
  title: string;
  sn_vin?: string; // "not found" when missing
  description?: string;
  condition?: string;
  details?: string;
  estimated_value?: string; // CA$...
  damage_analysis?: string;
  lotted_by?: string;
  condition_report_specs?: Record<string, string>;
  condition_report_specs_reviewed?: boolean;
  condition_report_specs_manual_overrides?: Record<string, string>;
  condition_report_specs_deleted?: string[];
  condition_report_specs_custom_order?: string[];
  // Excel-related optional fields (persist AI outputs for XLSX)
  categories?: string;
  lot_number?: string | number;
  quantity?: number;
  must_take?: boolean;
  show_on_website?: boolean;
  close_date?: string;
  bid_increment?: number;
  location?: string;
  opening_bid?: number;
  latitude?: number;
  longitude?: number;
  item_condition?: string;
  serial_number?: string;
  // Optional per-item image reference (global index resolved by job)
  image_local_index?: number; // preferred local best image index within this lot's image set
  image_index?: number; // 0-based index into report-level imageUrls
  image_url?: string; // resolved URL for convenience in templates
}

export interface IAssetLot {
  lot_id: string;
  auctioneer_source_key?: string;
  auctioneer_source_parent_key?: string;
  title: string;
  description: string;
  condition?: string;
  condition_report_selections?: {
    condition?: string;
    completeness?: string;
    legal?: string;
  };
  estimated_value?: string;
  damage_analysis?: string;
  tags?: string[];
  lotted_by?: string;
  condition_report_specs?: Record<string, string>;
  condition_report_specs_reviewed?: boolean;
  condition_report_specs_manual_overrides?: Record<string, string>;
  condition_report_specs_deleted?: string[];
  condition_report_specs_custom_order?: string[];
  analysis_metadata?: Record<string, unknown>;
  // Excel-related fields (persist AI outputs for XLSX)
  lot_number?: string | number;
  quantity?: number;
  must_take?: boolean;
  categories?: string;
  serial_number?: string;
  show_on_website?: boolean;
  close_date?: string;
  bid_increment?: number;
  location?: string;
  opening_bid?: number;
  latitude?: number;
  longitude?: number;
  item_condition?: string;
  serial_no_or_label?: string | null;
  details?: string;
  image_url?: string | null;
  image_indexes: number[]; // 0-based indexes of images that belong to this lot
  image_urls?: string[]; // resolved URLs for the images in this lot
  extra_image_indexes?: number[];
  extra_image_urls?: string[];
  video_urls?: string[]; // Original clips, separate from analyzed photo indexes.
  items?: ICatalogueItem[]; // catalogue-specific nested items
  // Mixed mode metadata (optional)
  mixed_group_index?: number;
  sub_mode?: 'single_lot' | 'per_item' | 'per_photo';
  merge_source_report_id?: string;
  merge_source_lot_id?: string;
  merge_source_lot_number?: string;
}

export interface IAssetMergeConflict {
  type: 'duplicate_lot_number';
  lotNumber: string;
  lotIds: string[];
  sourceReportIds: string[];
}

export interface IProposalValuationEvaluator {
  user: mongoose.Schema.Types.ObjectId;
  column_id: string;
  added_by: mongoose.Schema.Types.ObjectId;
  added_at: Date;
}

export interface IProposalValuationMutation {
  id: string;
  user: mongoose.Schema.Types.ObjectId;
  kind?: "draft" | "evaluators" | "regenerate" | "admin";
  revision: number;
  created_at: Date;
}

export type ReportStatus = 'draft' | 'processing' | 'preview' | 'pending_approval' | 'approved' | 'declined' | 'error';

export interface IAssetReport extends Document {
  user: mongoose.Schema.Types.ObjectId;
  grouping_mode: AssetGroupingMode;
  imageUrls: string[];
  videoUrls: string[];
  lots: IAssetLot[];
  analysis?: Record<string, any>; // raw AI output for reference
  // Workflow status
  status: ReportStatus;
  preview_data?: Record<string, any>; // Editable data shown in preview modal
  proposal_valuation_revision?: number;
  proposal_valuation_evaluators?: IProposalValuationEvaluator[];
  proposal_valuation_recent_mutations?: IProposalValuationMutation[];
  proposal_valuation_updated_by?: mongoose.Schema.Types.ObjectId | null;
  proposal_valuation_updated_at?: Date | null;
  proposal_valuation_generation_revision?: number;
  proposal_valuation_regeneration_claim_token?: string;
  proposal_valuation_regeneration_claimed_at?: Date;
  proposal_valuation_artifact_publish_token?: string;
  proposal_valuation_artifact_publish_revision?: number;
  proposal_valuation_artifact_publish_expires_at?: Date;
  cr_artifact_source_fingerprint?: string;
  proposal_valuation_artifact_repair_required?: boolean;
  proposal_valuation_artifact_repair_revision?: number;
  proposal_valuation_published_revision?: number;
  proposal_valuation_artifacts_published_at?: Date;
  preview_files?: {
    pdf?: string;
    spec_pdf?: string;
    schedule_a_pdf?: string;
    cr_docx?: string;
    docx?: string;
    excel?: string;
    images?: string;
  }; // Preview file URLs for admin review
  files?: {
    pdf?: string;
    spec_pdf?: string;
    schedule_a_pdf?: string;
    cr_docx?: string;
    docx?: string;
    excel?: string;
    images?: string;
  };
  files_generating?: boolean;
  files_regenerating?: boolean;
  files_regeneration_pending?: boolean;
  excel_regenerating?: boolean;
  excel_cr_regeneration_claim_token?: string;
  excel_cr_regeneration_claimed_at?: Date;
  excel_regeneration_token?: string;
  excel_regeneration_expires_at?: Date;
  excel_regenerated_at?: Date;
  excel_regeneration_error?: string;
  files_regenerated_at?: Date;
  job_id?: string;
  /** Current durable ReportJob execution attempt; distinct from logical job_id. */
  job_execution_token?: string;
  /** Pending atomic handoff to the durable ReportJob collection. */
  report_job_outbox?: Record<string, unknown>;
  youtube_videos_enabled?: boolean;
  youtube_submission?: Record<string, unknown>;
  report_recovery?: Record<string, unknown>;
  report_recovery_history?: Array<Record<string, unknown>>;
  client_submission_id?: string;
  capture_id?: string;
  /** Crash-safe unique lease for one active initial submission per contract. */
  submission_contract_claim?: string;
  /** Explicit duplicate override; distinguishes intentional force-new rows from legacy claimless rows. */
  submission_contract_claim_bypassed?: boolean;
  is_draft_preview?: boolean;
  source_draft_id?: mongoose.Schema.Types.ObjectId;
  source_draft_revision?: number;
  contract_key?: string;
  is_merged_report?: boolean;
  merged_from_report_ids?: mongoose.Schema.Types.ObjectId[];
  merge_primary_report_id?: mongoose.Schema.Types.ObjectId | null;
  merge_request_id?: string;
  merge_created_at?: Date;
  merge_conflicts?: IAssetMergeConflict[];
  job_status?: 'queued' | 'processing' | 'done' | 'error';
  job_error?: string;
  queued_at?: Date;
  processing_started_at?: Date;
  processing_completed_at?: Date;
  generation_target_status?: 'preview' | 'pending_approval' | 'approved';
  generation_progress?: Record<string, any>;
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
  decline_reason?: string;
  adminArchivedAt?: Date | null;
  adminArchivedBy?: mongoose.Schema.Types.ObjectId | null;
  // Added metadata fields
  client_name?: string;
  effective_date?: Date;
  appraisal_purpose?: string;
  owner_name?: string;
  appraiser?: string;
  appraisal_company?: string;
  industry?: string;
  inspection_date?: Date;
  contract_no?: string;
  language?: 'en' | 'fr' | 'es';
  currency?: string; // ISO currency code, e.g., CAD, USD, INR
  // Optional appraiser CV metadata
  user_cv_url?: string;
  user_cv_filename?: string;
  // New report fields
  prepared_for?: string;
  factors_age_condition?: string;
  factors_quality?: string;
  factors_analysis?: string;
  include_damage_analysis?: boolean;
  damage_analysis?: string;
  bank_photos_enabled?: boolean;
  watermark_images?: boolean;
  total_value?: number;
  total_appraised_value?: number;
  // Valuation comparison table
  include_valuation_table?: boolean;
  valuation_methods?: Array<'FML' | 'TKV' | 'OLV' | 'FLV'>;
  valuation_data?: {
    baseFMV: number;
    methods: Array<{
      method: string;
      fullName: string;
      description: string;
      percentage: number;
      value: number;
      saleConditions: string;
      timeline: string;
      useCase: string;
    }>;
  };
}

const CatalogueItemSchema: Schema<ICatalogueItem> = new Schema(
  {
    title: { type: String, required: true },
    sn_vin: { type: String },
    description: { type: String },
    condition: { type: String },
    details: { type: String },
    estimated_value: { type: String },
    damage_analysis: { type: String },
    lotted_by: { type: String },
    condition_report_specs: { type: Schema.Types.Mixed },
    condition_report_specs_reviewed: { type: Boolean },
    condition_report_specs_manual_overrides: { type: Schema.Types.Mixed },
    condition_report_specs_deleted: [{ type: String }],
    condition_report_specs_custom_order: [{ type: String }],
    // Excel-related optional fields
    categories: { type: String },
    lot_number: { type: Schema.Types.Mixed },
    quantity: { type: Number },
    must_take: { type: Boolean },
    show_on_website: { type: Boolean },
    close_date: { type: String },
    bid_increment: { type: Number },
    location: { type: String },
    opening_bid: { type: Number },
    latitude: { type: Number, min: -90, max: 90 },
    longitude: { type: Number, min: -180, max: 180 },
    item_condition: { type: String },
    serial_number: { type: String },
    image_local_index: { type: Number },
    image_index: { type: Number },
    image_url: { type: String },
  },
  { _id: false }
);

const AssetLotSchema: Schema<IAssetLot> = new Schema(
  {
    lot_id: { type: String, required: true },
    auctioneer_source_key: { type: String },
    auctioneer_source_parent_key: { type: String },
    title: { type: String, required: true },
    // Reviewed descriptions may be explicitly blank; exporters then use Title.
    description: { type: String },
    condition: { type: String },
    condition_report_selections: {
      condition: { type: String },
      completeness: { type: String },
      legal: { type: String },
    },
    estimated_value: { type: String },
    damage_analysis: { type: String },
    tags: [{ type: String }],
    lotted_by: { type: String },
    condition_report_specs: { type: Schema.Types.Mixed },
    condition_report_specs_reviewed: { type: Boolean },
    condition_report_specs_manual_overrides: { type: Schema.Types.Mixed },
    condition_report_specs_deleted: [{ type: String }],
    condition_report_specs_custom_order: [{ type: String }],
    analysis_metadata: { type: Schema.Types.Mixed, default: undefined },
    // Excel-related optional fields
    lot_number: { type: Schema.Types.Mixed },
    quantity: { type: Number },
    must_take: { type: Boolean },
    categories: { type: String },
    serial_number: { type: String },
    show_on_website: { type: Boolean },
    close_date: { type: String },
    bid_increment: { type: Number },
    location: { type: String },
    opening_bid: { type: Number },
    latitude: { type: Number, min: -90, max: 90 },
    longitude: { type: Number, min: -180, max: 180 },
    item_condition: { type: String },
    serial_no_or_label: { type: String },
    details: { type: String },
    image_url: { type: String },
    image_indexes: [{ type: Number, required: true }],
    image_urls: [{ type: String }],
    extra_image_indexes: [{ type: Number }],
    extra_image_urls: [{ type: String }],
    video_urls: [{ type: String }],
    items: { type: [CatalogueItemSchema], default: undefined },
    mixed_group_index: { type: Number },
    sub_mode: { type: String, enum: ['single_lot', 'per_item', 'per_photo'] },
    merge_source_report_id: { type: String },
    merge_source_lot_id: { type: String },
    merge_source_lot_number: { type: String },
  },
  { _id: false }
);

const AssetReportSchema: Schema<IAssetReport> = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    grouping_mode: {
      type: String,
      enum: [
        "single_lot",
        "per_item",
        "per_photo",
        "catalogue",
        "combined",
        "mixed",
      ],
      required: true,
    },
    imageUrls: [{ type: String, required: true }],
    videoUrls: [{ type: String }],
    lots: { type: [AssetLotSchema], default: [] },
    // Workflow status fields
    status: {
      type: String,
      enum: ['draft', 'processing', 'preview', 'pending_approval', 'approved', 'declined', 'error'],
      default: 'draft',
      required: true,
    },
    preview_data: { type: Schema.Types.Mixed },
    proposal_valuation_revision: { type: Number, default: 0 },
    proposal_valuation_evaluators: {
      type: [
        {
          user: { type: Schema.Types.ObjectId, ref: "User", required: true },
          column_id: { type: String, required: true },
          added_by: { type: Schema.Types.ObjectId, ref: "User", required: true },
          added_at: { type: Date, required: true },
        },
      ],
      default: [],
    },
    proposal_valuation_recent_mutations: {
      type: [
        {
          id: { type: String, required: true },
          user: { type: Schema.Types.ObjectId, ref: "User", required: true },
          kind: {
            type: String,
            enum: ["draft", "evaluators", "regenerate", "admin"],
          },
          revision: { type: Number, required: true },
          created_at: { type: Date, required: true },
        },
      ],
      default: [],
    },
    proposal_valuation_updated_by: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    proposal_valuation_updated_at: { type: Date, default: null },
    proposal_valuation_generation_revision: { type: Number },
    proposal_valuation_regeneration_claim_token: { type: String },
    proposal_valuation_regeneration_claimed_at: { type: Date },
    proposal_valuation_artifact_publish_token: { type: String },
    proposal_valuation_artifact_publish_revision: { type: Number },
    proposal_valuation_artifact_publish_expires_at: { type: Date },
    cr_artifact_source_fingerprint: { type: String },
    proposal_valuation_artifact_repair_required: {
      type: Boolean,
      default: false,
    },
    proposal_valuation_artifact_repair_revision: { type: Number },
    proposal_valuation_published_revision: { type: Number },
    proposal_valuation_artifacts_published_at: { type: Date },
    preview_files: {
      pdf: { type: String },
      spec_pdf: { type: String },
      schedule_a_pdf: { type: String },
      cr_docx: { type: String },
      docx: { type: String },
      excel: { type: String },
      images: { type: String },
    },
    files: {
      pdf: { type: String },
      spec_pdf: { type: String },
      schedule_a_pdf: { type: String },
      cr_docx: { type: String },
      docx: { type: String },
      excel: { type: String },
      images: { type: String },
    },
    files_generating: { type: Boolean, default: false },
    files_regenerating: { type: Boolean, default: false },
    files_regeneration_pending: { type: Boolean, default: false },
    excel_regenerating: { type: Boolean, default: false },
    excel_cr_regeneration_claim_token: { type: String },
    excel_cr_regeneration_claimed_at: { type: Date },
    excel_regeneration_token: { type: String },
    excel_regeneration_expires_at: { type: Date },
    excel_regenerated_at: { type: Date },
    excel_regeneration_error: { type: String },
    files_regenerated_at: { type: Date },
    job_id: { type: String },
    job_execution_token: { type: String },
    report_job_outbox: { type: Schema.Types.Mixed, select: false },
    youtube_videos_enabled: { type: Boolean },
    youtube_submission: { type: Schema.Types.Mixed, select: false },
    report_recovery: { type: Schema.Types.Mixed, select: false },
    report_recovery_history: { type: [Schema.Types.Mixed], select: false, default: undefined },
    client_submission_id: { type: String },
    capture_id: { type: String },
    submission_contract_claim: { type: String, select: false },
    submission_contract_claim_bypassed: { type: Boolean, select: false },
    // Internal analysis snapshot for a saved draft. Normal report queues must
    // exclude these records until the user submits the original draft.
    is_draft_preview: { type: Boolean, default: false, index: true },
    source_draft_id: { type: Schema.Types.ObjectId, ref: "ReportDraft", index: true },
    source_draft_revision: { type: Number },
    contract_key: { type: String, index: true },
    is_merged_report: { type: Boolean, default: false },
    merged_from_report_ids: [{ type: Schema.Types.ObjectId, ref: "AssetReport" }],
    merge_primary_report_id: { type: Schema.Types.ObjectId, ref: "AssetReport", default: null },
    merge_request_id: { type: String },
    merge_created_at: { type: Date },
    merge_conflicts: { type: [Schema.Types.Mixed], default: undefined },
    job_status: { type: String, enum: ['queued', 'processing', 'done', 'error'] },
    job_error: { type: String },
    queued_at: { type: Date },
    processing_started_at: { type: Date },
    processing_completed_at: { type: Date },
    generation_target_status: { type: String, enum: ['preview', 'pending_approval', 'approved'] },
    generation_progress: { type: Schema.Types.Mixed },
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
    decline_reason: { type: String },
    adminArchivedAt: { type: Date, default: null },
    adminArchivedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    // New optional report-level fields
    client_name: { type: String },
    effective_date: { type: Date },
    appraisal_purpose: { type: String },
    owner_name: { type: String },
    appraiser: { type: String },
    appraisal_company: { type: String },
    industry: { type: String },
    inspection_date: { type: Date },
    contract_no: { type: String },
    language: { type: String, enum: ['en', 'fr', 'es'], default: 'en' },
    currency: { type: String, default: 'CAD' },
    user_cv_url: { type: String },
    user_cv_filename: { type: String },
    prepared_for: { type: String },
    factors_age_condition: { type: String },
    factors_quality: { type: String },
    factors_analysis: { type: String },
    include_damage_analysis: { type: Boolean, default: true },
    damage_analysis: { type: String },
    bank_photos_enabled: { type: Boolean, default: false },
    watermark_images: { type: Boolean, default: DEFAULT_WATERMARK_IMAGES },
    total_value: { type: Number },
    total_appraised_value: { type: Number },
    include_valuation_table: { type: Boolean, default: false },
    valuation_methods: [{ type: String, enum: ['FML', 'TKV', 'OLV', 'FLV'] }],
    valuation_data: { type: Schema.Types.Mixed },
    analysis: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

/**
 * Older reports can contain lots created before core text fields were populated.
 * Mongoose validates the complete embedded lot array on every save,
 * including saves that only change job state. Repair those legacy rows at the
 * model boundary so retries, approvals, and file regeneration cannot fail
 * before the shared preview normalization runs.
 */
AssetReportSchema.pre("validate", function repairLegacyRequiredLotFields() {
  const report = this as IAssetReport;
  if (!Array.isArray(report.lots)) return;

  report.lots.forEach((lot: any, index: number) => {
    const lotNumber = String(lot?.lot_number ?? lot?.lot_id ?? index + 1).trim();
    const fallbackTitle =
      String(lot?.title ?? "").trim() ||
      String(lot?.categories ?? "").trim() ||
      `Lot ${lotNumber || index + 1}`;
    const fallbackDescription =
      String(lot?.description ?? "").trim() ||
      String(lot?.details ?? "").trim() ||
      fallbackTitle;

    if (!String(lot?.lot_id ?? "").trim()) lot.lot_id = `lot-${index + 1}`;
    if (!String(lot?.title ?? "").trim()) lot.title = fallbackTitle;
    if (lot?.description === undefined || lot?.description === null) lot.description = fallbackDescription;
  });
});

AssetReportSchema.pre("validate", function normalizeContractKey() {
  const report = this as IAssetReport;
  const contract = normalizeReportContractKey(
    report.contract_no || (report.preview_data as any)?.contract_no || ""
  );
  report.contract_key = contract || undefined;
});

attachReportImageDeletionHooks(AssetReportSchema, "asset");

AssetReportSchema.index({ status: 1, createdAt: -1 });
AssetReportSchema.index({ user: 1, createdAt: -1 });
AssetReportSchema.index({ is_draft_preview: 1, user: 1, updatedAt: -1 });
AssetReportSchema.index({ status: 1, updatedAt: -1 });
AssetReportSchema.index({
  preview_reminder_sent_at: 1,
  preview_reminder_claimed_at: 1,
  status: 1,
  processing_completed_at: 1,
  updatedAt: 1,
});
AssetReportSchema.index({ job_status: 1, updatedAt: -1 });
AssetReportSchema.index({ status: 1, contract_no: 1 });
AssetReportSchema.index({ user: 1, contract_key: 1, createdAt: -1 });
AssetReportSchema.index({ status: 1, adminArchivedAt: 1, createdAt: -1 });
AssetReportSchema.index({ status: 1, release_status: 1, release_assigned_to: 1, createdAt: -1 });
AssetReportSchema.index({ auctioneerWorkItem: 1, createdAt: -1 });
AssetReportSchema.index({ "proposal_valuation_evaluators.user": 1, updatedAt: -1 });
AssetReportSchema.index(
  { "report_job_outbox.type": 1, "report_job_outbox.createdAt": 1 },
  {
    name: "asset_report_job_outbox_dispatch",
    partialFilterExpression: { "report_job_outbox.token": { $type: "string" } },
  }
);
AssetReportSchema.index(
  { user: 1, client_submission_id: 1 },
  {
    unique: true,
    partialFilterExpression: { client_submission_id: { $type: "string" } },
  }
);
AssetReportSchema.index(
  { user: 1, merge_request_id: 1 },
  {
    unique: true,
    partialFilterExpression: { merge_request_id: { $type: "string" } },
  }
);

AssetReportSchema.plugin(reportActivityPlugin, { model: "AssetReport" });
const AssetReport = mongoose.model<IAssetReport>(
  "AssetReport",
  AssetReportSchema
);
export default AssetReport;
import { reportActivityPlugin } from "../utils/reportActivityPlugin.js";
