import { requireOptionalNativeModule } from 'expo-modules-core';

export type ReportTransferGrant = { token: string; expiresAt: string | number };
export type ReportTransferFile = { fileId: string; uri: string; name: string; type: string; size: number };
export type ReportTransferPlan = {
  ownerId: string; clientDraftId: string; captureId: string; clientSubmissionId: string; revision: number; type: 'asset' | 'lotListing';
  sessionId: string; title?: string; grant: ReportTransferGrant; files: ReportTransferFile[];
};
export type ReportTransferState = {
  ownerId: string; clientDraftId: string; captureId: string; clientSubmissionId: string; revision: number; sessionId: string; type: 'asset' | 'lotListing';
  status: 'queued' | 'uploading' | 'paused' | 'waiting_network' | 'interrupted' | 'auth_required' | 'needs_attention' | 'accepted';
  completedFiles: number; totalFiles: number; percent: number; updatedAt: string;
  title?: string; reportId?: string; message?: string; canPause: boolean;
  receipt?: Record<string, unknown>;
};
export type ReportTransferNative = {
  getCapabilities(): { version: number; durable: boolean; uidt: boolean };
  configure(value: { ownerId: string; apiBaseUrl: string; headers?: Record<string, string> }): Promise<void>;
  enqueue(plan: ReportTransferPlan): Promise<ReportTransferState>;
  list(ownerId: string): Promise<ReportTransferState[]>;
  pause(ownerId: string, clientDraftId: string): Promise<void>;
  resume(ownerId: string, clientDraftId: string, grant?: ReportTransferGrant): Promise<void>;
  forget(ownerId: string, clientDraftId: string): Promise<void>;
  deactivate(): Promise<void>;
};
export const ReportTransfer = requireOptionalNativeModule<ReportTransferNative>('ReportTransfer');
export default ReportTransfer;
