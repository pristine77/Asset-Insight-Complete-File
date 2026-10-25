import { useSyncExternalStore } from 'react';
import backgroundUploadManager, { type BackgroundUploadSnapshot } from '../services/backgroundUploadManager';

/**
 * The background upload line (services/backgroundUploadManager.ts) as React
 * state: the upload bar and the Drafts lists re-render on every change.
 */
export function useBackgroundUploads(): BackgroundUploadSnapshot {
  return useSyncExternalStore(
    backgroundUploadManager.subscribe,
    backgroundUploadManager.getSnapshot,
    backgroundUploadManager.getSnapshot,
  );
}
