export type CaptureModePreference = 'online' | 'offline';
export type OfflineSubmissionState = 'local' | 'ready' | 'uploading' | 'paused' | 'submitted' | 'accepted' | 'failed' | 'cancelled' | 'discarded';
export type MediaOwnership = 'gallery' | 'camera' | 'managed' | 'external' | 'remote';

export type CaptureContext = { ownerId: string; draftId: string; sessionId: string };
export type NativeCaptureJournal = CaptureContext & { revision: number; lots: unknown[]; updatedAt?: string };

export type OfflineDraftCounts = {
  lots: number;
  images: number;
  mainImages: number;
  extraImages: number;
  videos: number;
  missingImages: number;
  perLot: Array<{ id: string; lotNumber?: string; title?: string; mainImages: number; extraImages: number; images: number; videos: number; missingImages: number }>;
};

/** Device timestamps are observations, never substitutes for server receipt times. */
export type OfflineCaptureMetadata = {
  captureId?: string;
  inventoryAppVersion?: string;
  inventoryPlatform?: 'android' | 'ios';
  ownerId?: string;
  captureMode?: CaptureModePreference;
  manualSubmissionRequired?: boolean;
  localRevision?: number;
  captureStartedAt?: string;
  captureLastAt?: string;
  submissionState?: OfflineSubmissionState;
  submissionRequestedAt?: string;
  submittedAt?: string;
  reportId?: string;
  submissionError?: string;
  legacyRecoveredAt?: string;
  auctioneerSnapshot?: Record<string, unknown>;
  auctionsoftSnapshot?: Record<string, unknown>;
};
