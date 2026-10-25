export type WorkflowStage =
  | "preparing_preview"
  | "preview_ready"
  | "generating_files"
  | "awaiting_approval"
  | "awaiting_release"
  | "ready"
  | "error";

export type CoverageMetric = { covered: number; total: number };

export type EmployeePerformance = {
  userId: string;
  name: string;
  email: string;
  accountState: "active" | "blocked" | "historical";
  activeDays: number;
  firstActivityAt: string | null;
  lastActivityAt: string | null;
  reports: number;
  lots: number;
  images: number;
  averageLotsPerReport: number;
  medianPreviewMinutes: number | null;
  p90PreviewMinutes: number | null;
  medianFileMinutes: number | null;
  p90FileMinutes: number | null;
  p90EndToEndMinutes: number | null;
  readyReports: number;
  retryReports: number;
  failedReports: number;
  readyRate: number;
  retryRate: number;
  failureRate: number;
  retries: number;
  byType: Record<string, number>;
};

export type PerformancePayload = {
  range: { from: string; to: string; timeZone: string };
  summary: {
    totalReports: number;
    totalLots: number;
    totalImages: number;
    activeCreators: number;
    readyReports: number;
    failedReports: number;
    retryReports: number;
    medianPreviewMinutes: number | null;
    medianFileMinutes: number | null;
    p90EndToEndMinutes: number | null;
  };
  coverage: {
    previewTiming: CoverageMetric;
    fileTiming: CoverageMetric;
    endToEndTiming: CoverageMetric;
  };
  daily: Array<{
    date: string;
    reports: number;
    lots: number;
    images: number;
    activeCreators: number;
    medianPreviewMinutes: number | null;
    medianFileMinutes: number | null;
  }>;
  byType: Array<{ type: string; reports: number; lots: number }>;
  workflow: Array<{ stage: WorkflowStage; count: number }>;
  outcomes: {
    ready: number;
    retry: number;
    failed: number;
    readyRate: number;
    retryRate: number;
    failureRate: number;
  };
  backlog: Array<{
    id: string;
    reportType: string;
    title: string;
    contractNo: string;
    creator: string;
    lotCount: number;
    workflowStage: WorkflowStage;
    workflowMessage: string;
    elapsedMinutes: number;
    createdAt: string;
  }>;
  employees: EmployeePerformance[];
  filterOptions: {
    creators: Array<{ id: string; label: string; email: string }>;
    reportTypes: string[];
    workflowStages: WorkflowStage[];
  };
};

export type EmployeeReportDetail = {
  id: string;
  reportType: string;
  title: string;
  contractNo: string;
  workflowStage: WorkflowStage;
  workflowMessage: string;
  lotCount: number;
  imageCount: number;
  createdAt: string;
  updatedAt: string;
  previewMinutes: number | null;
  fileMinutes: number | null;
  approvalMinutes: number | null;
  releaseMinutes: number | null;
  endToEndMinutes: number | null;
  retries: number;
  attempts: number;
  error: string | null;
  timeline: Array<{ key: string; label: string; at: string }>;
};

export type EmployeeDetailPayload = {
  range: PerformancePayload["range"];
  employee: EmployeePerformance;
  coverage: PerformancePayload["coverage"];
  daily: Array<{
    date: string;
    firstActivity: string;
    lastActivity: string;
    activitySpanMinutes: number;
    reports: number;
    lots: number;
    images: number;
  }>;
  byType: Array<{ type: string; count: number }>;
  reports: EmployeeReportDetail[];
  failures: EmployeeReportDetail[];
  outliers: EmployeeReportDetail[];
};

export const STAGE_LABELS: Record<WorkflowStage, string> = {
  preparing_preview: "Preparing preview",
  preview_ready: "Preview ready",
  generating_files: "Generating files",
  awaiting_approval: "Awaiting approval",
  awaiting_release: "Awaiting release",
  ready: "Ready",
  error: "Error",
};
