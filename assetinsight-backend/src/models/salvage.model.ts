import mongoose, { Schema, Document } from "mongoose";
import type { SalvageAssessmentInputs, SalvageAssessmentV2 } from "../service/salvageAssessment.js";

export interface ISalvageReport extends Document {
  user: mongoose.Schema.Types.ObjectId;
  report_date: Date;
  file_number: string;
  date_received: Date;
  claim_number: string;
  policy_number: string;
  date_of_loss: Date;
  reported_loss_type: string;
  appraiser_name: string;
  appraiser_phone: string;
  appraiser_email: string;
  item_type: string;
  year: string;
  make: string;
  item_model: string;
  vin: string;
  adjuster_name: string;
  insured_name: string;
  company_name: string;
  company_address: string;
  cause_of_loss_summary: string;
  appraiser_comments: string;
  next_report_due: Date;
  imageUrls: string[];
  aiExtractedDetails: Record<string, any>;
  comparableItems: {
    title: string;
    link: string;
    price: string;
    price_numeric?: number;
    currency?: string;
    snippet: string;
    location: string;
    image_url: string;
    details?: Record<string, string>;
  }[];
  valuation: Record<string, any>;
  language?: "en" | "fr" | "es";
  currency?: string;
  specialty_data?: Record<string, any>;
  // Optional: itemized parts and labour extracted by AI or entered manually
  repair_items?: Array<{
    name: string;
    sku?: string;
    oem_or_aftermarket?: "OEM" | "Aftermarket" | "Unknown";
    quantity: number;
    unit_price: number;
    line_total: number;
    vendor?: string;
    vendor_link?: string;
    lead_time_days?: number;
    notes?: string;
  }>;
  labour_breakdown?: Array<{
    task: string;
    hours: number;
    rate_per_hour?: number;
    line_total: number;
    notes?: string;
  }>;
  procurement_notes?: string;
  assumptions?: string;
  safety_concerns?: string;
  priority_level?: "High" | "Medium" | "Low";
  labour_rate_default?: number;
  parts_subtotal?: number;
  labour_total?: number;
  workflow_version?: number;
  status?: string;
  revision?: number;
  preview_data?: Record<string, any>;
  files?: Record<string, string>;
  artifact_ids?: Record<string, string>;
  files_stale?: boolean;
  files_generating?: boolean;
  files_regenerating?: boolean;
  job_id?: string;
  job_status?: string;
  job_error?: string;
  job_execution_token?: string;
  generation_kind?: "preview" | "files";
  generation_progress?: Record<string, any>;
  assessment_inputs?: Partial<SalvageAssessmentInputs>;
  report_context?: import("../service/salvageReportEnrichment.js").SalvageReportContext;
  /** Versioned canonical assessment; optional vehicleDetails stores photo evidence separately from corrections. */
  assessment?: SalvageAssessmentV2;
  research_checkpoint?: Record<string, unknown>;
  research_requests?: Array<{ clientRequestId: string; baseRevision: number; jobId: string; requestedAt: Date }>;
  assessment_edit_history?: Array<Record<string, unknown>>;
}

const SalvageReportSchema: Schema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    report_date: { type: Date, required: true },
    file_number: { type: String, required: true },
    date_received: { type: Date, required: true },
    claim_number: { type: String, required: true },
    policy_number: { type: String, required: true },
    date_of_loss: { type: Date, required: false },
    reported_loss_type: { type: String, required: false },
    appraiser_name: { type: String, required: true },
    appraiser_phone: { type: String, required: true },
    appraiser_email: { type: String, required: true },
    item_type: { type: String, required: false },
    year: { type: String, required: false },
    make: { type: String, required: false },
    item_model: { type: String, required: false },
    vin: { type: String, required: false },
    adjuster_name: { type: String, required: true },
    insured_name: { type: String, required: true },
    company_name: { type: String, required: true },
    company_address: { type: String, required: true },
    cause_of_loss_summary: { type: String, required: false },
    appraiser_comments: { type: String, required: true },
    next_report_due: { type: Date, required: true },
    imageUrls: [{ type: String }],
    aiExtractedDetails: { type: Schema.Types.Mixed },
    comparableItems: [
      {
        title: { type: String },
        link: { type: String },
        price: { type: String },
        price_numeric: { type: Number },
        currency: { type: String },
        snippet: { type: String },
        location: { type: String },
        image_url: { type: String },
        details: { type: Schema.Types.Mixed },
      },
    ],
    valuation: { type: Schema.Types.Mixed },
    language: { type: String, enum: ["en", "fr", "es"], default: "en" },
    currency: { type: String, default: "CAD" },
    specialty_data: { type: Schema.Types.Mixed },
    // Optional denormalized structures for itemized estimate
    repair_items: [
      {
        name: { type: String },
        sku: { type: String },
        oem_or_aftermarket: {
          type: String,
          enum: ["OEM", "Aftermarket", "Unknown"],
          default: "Unknown",
        },
        quantity: { type: Number },
        unit_price: { type: Number },
        line_total: { type: Number },
        vendor: { type: String },
        vendor_link: { type: String },
        lead_time_days: { type: Number },
        notes: { type: String },
      },
    ],
    labour_breakdown: [
      {
        task: { type: String },
        hours: { type: Number },
        rate_per_hour: { type: Number },
        line_total: { type: Number },
        notes: { type: String },
      },
    ],
    procurement_notes: { type: String },
    assumptions: { type: String },
    safety_concerns: { type: String },
    priority_level: { type: String, enum: ["", "High", "Medium", "Low"] },
    labour_rate_default: { type: Number },
    parts_subtotal: { type: Number },
    labour_total: { type: Number },
    // Keep the complete reviewed snapshot; older records remain readable when
    // workflow_version is absent and continue to use their PdfReport decisions.
    workflow_version: { type: Number },
    status: { type: String, enum: ["processing", "preview", "pending_approval", "approved", "declined", "error"] },
    revision: { type: Number, default: 0 },
    preview_data: { type: Schema.Types.Mixed },
    assessment_inputs: { type: Schema.Types.Mixed },
    report_context: { type: Schema.Types.Mixed },
    assessment: { type: Schema.Types.Mixed },
    // Execution checkpoints prevent duplicate work after a retry; retain them
    // and never expose provider payloads through generic report reads.
    research_checkpoint: { type: Schema.Types.Mixed, select: false },
    research_requests: { type: [Schema.Types.Mixed], select: false, default: undefined },
    assessment_edit_history: { type: [Schema.Types.Mixed], select: false, default: undefined },
    files: { type: Schema.Types.Mixed },
    artifact_ids: { type: Schema.Types.Mixed },
    files_stale: { type: Boolean, default: false },
    files_generating: { type: Boolean, default: false },
    files_regenerating: { type: Boolean, default: false },
    job_id: { type: String, index: true },
    job_status: { type: String },
    job_error: { type: String },
    job_execution_token: { type: String, select: false },
    generation_attempt: { type: Number, default: 0 },
    generation_kind: { type: String, enum: ["preview", "files"] },
    generation_progress: { type: Schema.Types.Mixed },
    generation_revision: { type: Number },
    artifact_generation: { type: String },
    source_files: { type: [Schema.Types.Mixed], select: false },
    submission_fingerprint: { type: String, select: false },
    client_submission_id: { type: String, select: false },
    legacy_progress_id: { type: String },
    report_job_outbox: { type: Schema.Types.Mixed, select: false },
    queued_at: { type: Date },
    processing_completed_at: { type: Date },
    item_condition: { type: String },
    damage_description: { type: String },
    inspection_comments: { type: String },
    is_repairable: { type: Schema.Types.Mixed },
    repair_facility: { type: Schema.Types.Mixed },
    repair_facility_comments: { type: String },
    repair_estimate: { type: Schema.Types.Mixed },
    actual_cash_value: { type: Schema.Types.Mixed },
    replacement_cost: { type: Schema.Types.Mixed },
    replacement_cost_references: { type: Schema.Types.Mixed },
    recommended_reserve: { type: Schema.Types.Mixed },
    estimate_warning: { type: String },
    analysis_warning: { type: String },
    analysis_model: { type: String },
  },
  { timestamps: true }
);

const SalvageReport = mongoose.model<ISalvageReport>(
  "SalvageReport",
  SalvageReportSchema
);

export default SalvageReport;
