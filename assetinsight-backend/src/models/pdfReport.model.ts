import mongoose, { Schema, Document } from 'mongoose';

export interface IPdfReport extends Document {
  filename: string;
  address: string;
  fairMarketValue: string;
  user: mongoose.Schema.Types.ObjectId;
  report: mongoose.Schema.Types.ObjectId;
  reportType: 'RealEstate' | 'Salvage' | 'Asset';
  reportModel: 'RealEstateReport' | 'SalvageReport' | 'AssetReport';
  fileType?: 'pdf' | 'spec_pdf' | 'docx' | 'xlsx' | 'images';
  filePath?: string; // relative path like "reports/<filename>"
  artifact_generation?: string;
  imagesFolderPath?: string; // optional: for 'images' type, relative folder path containing original images
  createdAt: Date;
  approvalStatus: 'pending' | 'approved' | 'rejected';
  approvalNote?: string;
  reviewedBy?: mongoose.Schema.Types.ObjectId | null;
  reviewedAt?: Date | null;
  salvage_review_acknowledgement?: {
    revision: number;
    limitation_codes: string[];
    note: string;
    reviewed_by: mongoose.Schema.Types.ObjectId;
    reviewed_at: Date;
  };
  approval_assigned_to?: mongoose.Schema.Types.ObjectId | null;
  approval_assigned_at?: Date | null;
  approval_assigned_source?: string;
  approval_assignment_email_sent_at?: Date | null;
  release_status?: 'pending_release' | 'released';
  release_assigned_to?: mongoose.Schema.Types.ObjectId | null;
  release_assigned_at?: Date | null;
  release_assigned_source?: string;
  release_assignment_email_sent_at?: Date | null;
  released_by?: mongoose.Schema.Types.ObjectId | null;
  released_at?: Date | null;
  adminArchivedAt?: Date | null;
  adminArchivedBy?: mongoose.Schema.Types.ObjectId | null;
  contract_no?: string;
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

const PdfReportSchema: Schema = new Schema(
  {
    filename: {
      type: String,
      required: true,
    },
    fileType: {
      type: String,
      enum: ['pdf', 'spec_pdf', 'docx', 'xlsx', 'images'],
      required: false,
      index: true,
    },
    filePath: {
      type: String,
      required: false,
      default: '',
    },
    imagesFolderPath: {
      type: String,
      required: false,
      default: '',
    },
    // A reviewed Salvage revision owns the whole artifact group. Approval and
    // release updates must not cross this generation when a resubmit races.
    artifact_generation: { type: String },
    address: {
      type: String,
      required: true,
    },
    fairMarketValue: {
      type: String,
      required: true,
    },
    contract_no: {
      type: String,
      required: false,
      default: '',
      index: true,
    },
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    reportType: {
      type: String,
      enum: ['RealEstate', 'Salvage', 'Asset'],
      required: true,
    },
    reportModel: {
      type: String,
      enum: ['RealEstateReport', 'SalvageReport', 'AssetReport'],
      required: true,
    },
    report: {
      type: Schema.Types.ObjectId,
      refPath: 'reportModel',
      required: true,
    },
    approvalStatus: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
    approvalNote: {
      type: String,
      default: '',
      maxlength: 2000,
    },
    reviewedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    salvage_review_acknowledgement: {
      type: new Schema({
        revision: { type: Number, required: true },
        limitation_codes: [{ type: String }],
        note: { type: String, maxlength: 2000, required: true },
        reviewed_by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        reviewed_at: { type: Date, required: true },
      }, { _id: false }),
      required: false,
    },
    approval_assigned_to: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    approval_assigned_at: {
      type: Date,
      default: null,
    },
    approval_assigned_source: {
      type: String,
      default: '',
    },
    approval_assignment_email_sent_at: {
      type: Date,
      default: null,
    },
    release_status: {
      type: String,
      enum: ['pending_release', 'released'],
      default: undefined,
      index: true,
    },
    release_assigned_to: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true,
    },
    release_assigned_at: {
      type: Date,
      default: null,
    },
    release_assigned_source: {
      type: String,
      default: '',
    },
    release_assignment_email_sent_at: {
      type: Date,
      default: null,
    },
    released_by: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    released_at: {
      type: Date,
      default: null,
    },
    adminArchivedAt: {
      type: Date,
      default: null,
      index: true,
    },
    adminArchivedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    valuation_methods: [{ type: String, enum: ['FML', 'TKV', 'OLV', 'FLV'] }],
    valuation_data: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

PdfReportSchema.index({ approvalStatus: 1, adminArchivedAt: 1, createdAt: -1 });
PdfReportSchema.index({ user: 1, createdAt: -1 });
PdfReportSchema.index({ approvalStatus: 1, approval_assigned_to: 1, createdAt: -1 });
PdfReportSchema.index({ approvalStatus: 1, release_status: 1, release_assigned_to: 1, createdAt: -1 });

const PdfReport = mongoose.model<IPdfReport>('PdfReport', PdfReportSchema);

export default PdfReport;
