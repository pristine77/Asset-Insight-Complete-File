"use client";

import { useSyncExternalStore } from "react";
import {
  backgroundUploads,
  type BackgroundUploadSnapshot,
} from "@/services/backgroundUploadManager";

/**
 * Reads the upload line. The manager publishes a fresh snapshot object on every
 * change, which is what useSyncExternalStore needs to detect one; the server
 * snapshot is a stable empty line so a server-rendered pass cannot mismatch.
 */
export function useBackgroundUploads(): BackgroundUploadSnapshot {
  return useSyncExternalStore(
    backgroundUploads.subscribe,
    backgroundUploads.getSnapshot,
    backgroundUploads.getServerSnapshot
  );
}
