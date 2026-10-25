import { requireOptionalNativeModule } from 'expo-modules-core';

export type CaptureBackupStatus = 'queued' | 'uploading' | 'paused' | 'waiting_network' | 'interrupted' | 'auth_required' | 'needs_attention' | 'completed';
export type CaptureBackupState = {
  clientDraftId: string; revision: number; planId?: string; status: CaptureBackupStatus;
  verified: number; total: number; message?: string; updatedAt: string;
  title?: string; contractNo?: string; pauseReason?: 'user_pause' | 'draft_deleted';
  retainedEarlierRevisionsPending?: number;
  retainedEarlierRevisionsStatus?: CaptureBackupStatus;
};
export type CaptureBackupConfiguration = {
  ownerId: string; apiBaseUrl: string; token?: string; expiresAt?: string | number;
  headers?: Record<string, string>; networkPolicy: 'unmetered' | 'connected';
};
export type CaptureBackupMedia = {
  clientFileId: string; lotId: string; slot: 'main' | 'extra' | 'video'; index: number;
  name: string; mimeType: string; size: number; uri: string; localKey?: string;
  mediaId?: string; captureOrder?: number; originalOrder?: number; lastModified?: number; sha256?: string;
};
export type CaptureBackupPlan = {
  ownerId: string; clientDraftId: string; captureId: string; type: string; revision: number;
  contractNo?: string; title?: string; formData: Record<string, unknown>;
  lots: unknown[]; media: CaptureBackupMedia[]; activeLotIdx?: number;
};
export type CaptureBackupNative = {
  configure(configuration: CaptureBackupConfiguration): Promise<void>;
  enqueue(plan: CaptureBackupPlan): Promise<CaptureBackupState>;
  pause(ownerId: string, clientDraftId: string, reason?: 'user_pause' | 'draft_deleted'): Promise<void>;
  resume(ownerId: string, clientDraftId: string): Promise<void>;
  list(ownerId: string): Promise<CaptureBackupState[]>;
  deactivate(): Promise<void>;
};

/** Older installed binaries and iOS must explicitly show background backup unavailable. */
export const CaptureBackup = requireOptionalNativeModule<CaptureBackupNative>('CaptureBackup');
export default CaptureBackup;
