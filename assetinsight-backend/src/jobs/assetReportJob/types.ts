// Shared types for asset report background jobs.
export type AssetGroupingMode =
  | "single_lot"
  | "per_item"
  | "per_photo"
  | "catalogue"
  | "combined"
  | "mixed";

// Request shape used by asset job entry points.
export type AssetJobInput = {
  reportId?: string;
  user: { id: string; email: string; name?: string | null };
  images: Express.Multer.File[];
  videos?: Express.Multer.File[];
  details: any;
  progressId?: string;
  /** New logical attempt for a failed direct multipart retry. */
  submissionAttemptId?: string;
  /** Exact embedded outbox handoff already persisted with the report row. */
  reportJobOutboxToken?: string;
};
