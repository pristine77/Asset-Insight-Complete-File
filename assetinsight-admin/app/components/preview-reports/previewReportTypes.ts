import type { ReportPreviewPayload } from "@/app/components/reports/reportPreviewTypes";

export type PreviewWorkflowStage =
  | "preparing_preview"
  | "preview_ready"
  | "generating_files"
  | "awaiting_approval"
  | "awaiting_release"
  | "error";

export type PreviewReportCreator = {
  id: string;
  username: string;
  email: string;
  companyName: string;
  isBlocked: boolean;
  displayName?: string;
};

export type PreviewReportSummary = {
  id: string;
  reportType: "Asset" | "LotListing";
  title: string;
  contractNo: string;
  clientName: string;
  creator: PreviewReportCreator | null;
  creatorDisplay: string;
  lotCount: number;
  imageCount: number;
  lotNumbers: Array<string | number>;
  lotNumberSummary: string;
  thumbnailUrl: string | null;
  status: string;
  releaseStatus: string;
  createdAt: string;
  updatedAt: string;
  previewSubmittedAt: string | null;
  workflowStage: PreviewWorkflowStage;
  workflowMessage: string;
  workflowProgressPercent: number;
  generationState: string;
  filesReady: boolean;
  jobStatus: string;
  jobError: string;
  transferEligible: boolean;
  transferIneligibleReason: string | null;
  transferRequiresReview?: boolean;
  deleteEligible: boolean;
  deleteIneligibleReason: string | null;
  reminderEligible: boolean;
  reminderIneligibleReason: string | null;
  reminderWaitingSince: string;
  reminderSentAt: string | null;
  previewTransferredAt: string | null;
};

export type PreviewTransferUser = PreviewReportCreator & {
  role: string;
  displayName: string;
};

export type PreviewNotificationDraft = {
  reportId: string;
  reportType: "Asset" | "LotListing";
  contractNo: string;
  recipient: { id: string; displayName: string; email: string };
  subject: string;
  message: string;
  baseRevision: string;
  eligible: boolean;
  ineligibleReason: string | null;
  reportError: string | null;
  affectedLots: string[];
  correctionSteps: string[];
  lastSentAt?: string | null;
  pendingDelivery?: { requestId: string; status: "processing" | "uncertain"; deliveryStatus?: "processing" | "sent" | "uncertain"; inAppStatus?: "pending" | "sent" | "uncertain" } | null;
};

export type PreviewReportsResponse = {
  items: PreviewReportSummary[];
  total: number;
  page: number;
  limit: number;
  pages: number;
  stageCounts: Record<PreviewWorkflowStage, number>;
  creators: PreviewReportCreator[];
  truncated?: boolean;
};

export type PreviewReportDetailResponse = {
  report: {
    id: string;
    reportType: "Asset" | "LotListing";
    contractNo: string;
    creator: PreviewReportCreator | null;
    status: string;
    releaseStatus: string;
    createdAt: string;
    updatedAt: string;
    previewSubmittedAt: string | null;
    generation_state: string;
    workflow_stage: PreviewWorkflowStage;
    workflow_message: string;
    workflow_progress_percent: number;
    files_ready: boolean;
    job_status: string;
    job_error: string;
    // Optional until backend-first rollout; absent means resubmission is unavailable.
    resubmitEligible?: boolean;
    resubmitIneligibleReason?: string | null;
    resubmitRevision?: string | null;
    transferEligible: boolean;
    transferIneligibleReason: string | null;
    transferRequiresReview?: boolean;
    deleteEligible: boolean;
    deleteIneligibleReason: string | null;
    reminderEligible: boolean;
    reminderIneligibleReason: string | null;
    reminderWaitingSince: string;
    reminderSentAt: string | null;
    previewTransferredAt: string | null;
    transferHistory: Array<{
      fromUser: string;
      toUser: string;
      transferredBy: string;
      transferredAt: string;
    }>;
  };
  preview: ReportPreviewPayload;
};

export type DraftPreviewStatus =
  | "idle"
  | "queued"
  | "processing"
  | "ready"
  | "error";

export type DraftPreviewSummary = {
  id: string;
  type: "asset" | "lotListing";
  title: string;
  contractNo: string;
  clientDraftId: string;
  storageMode: "standard" | "smart_upload";
  revision: number;
  lotCount: number;
  imageCount: number;
  videoCount: number;
  thumbnailUrl: string | null;
  previewStatus: DraftPreviewStatus;
  previewReportId: string | null;
  previewJobId: string | null;
  previewError: string | null;
  previewRequestedRevision: number | null;
  previewProcessedRevision: number | null;
  previewRequestedAt: string | null;
  previewReadyAt: string | null;
  duplicateLotConflicts: Array<{
    contractNo?: string;
    lotNumber?: string;
    sourceType?: string;
    sourceId?: string;
    ownerDisplay?: string;
    message?: string;
  }>;
  reviewReminderSentAt: string | null;
  creator: PreviewReportCreator | null;
  creatorDisplay: string;
  createdAt: string;
  updatedAt: string;
};

export type DraftPreviewsResponse = {
  items: DraftPreviewSummary[];
  total: number;
  page: number;
  limit: number;
  pages: number;
};
