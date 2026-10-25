import { requireNativeModule } from 'expo-modules-core';

// This resolves to the AuctionCameraModule registered via Name("AuctionCameraModule") in Kotlin
const AuctionCamera = requireNativeModule('AuctionCameraModule');

// Older installed binaries must not silently ignore the imported-lot lock.
export async function getCameraCapabilities(): Promise<{ lockedStructure: boolean; launchRecovery?: boolean }> {
  if (typeof AuctionCamera.getCameraCapabilities !== 'function') return { lockedStructure: false };
  return AuctionCamera.getCameraCapabilities();
}

/**
 * Opens the native Auction Camera activity.
 * @param initialPayload Optional JSON string of existing lots to seed the camera session.
 * @returns A promise that resolves with the lot payload JSON string,
 *          or rejects with E_CANCELLED if the user presses Back without capturing.
 */
export async function openAuctionCamera(initialPayload?: string, requestId?: string): Promise<string> {
  return requestId ? AuctionCamera.openAuctionCamera(initialPayload ?? '', requestId) : AuctionCamera.openAuctionCamera(initialPayload ?? '');
}

export const cancelCameraLaunch = (requestId: string): Promise<boolean> =>
  typeof AuctionCamera.cancelCameraLaunch === 'function' ? AuctionCamera.cancelCameraLaunch(requestId) : Promise.resolve(false);

export const getPendingCapture = (ownerId: string, draftId: string): Promise<string | null> => AuctionCamera.getPendingCapture(ownerId, draftId);
export const getContentUriInfo = (uri: string): Promise<{ exists: boolean; size?: number; type?: string }> => AuctionCamera.getContentUriInfo(uri);
export const acknowledgeCapture = (ownerId: string, draftId: string, sessionId: string, revision: number): Promise<boolean> => AuctionCamera.acknowledgeCapture(ownerId, draftId, sessionId, revision);
export const cancelContentUriUpload = (id: string): Promise<void> => AuctionCamera.cancelContentUriUpload(id);
export async function streamContentUriUpload(args: {
  id: string; uri: string; url: string; headers: Record<string, string>; size: number;
  onProgress?: (bytesSent: number, totalBytes: number) => void;
}): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const subscription = args.onProgress ? AuctionCamera.addListener('uploadProgress', (event: { id: string; bytesSent: number; totalBytes: number }) => {
    if (event.id === args.id) args.onProgress?.(event.bytesSent, event.totalBytes);
  }) : undefined;
  try { return await AuctionCamera.uploadContentUri(args.id, args.uri, args.url, args.headers, args.size); }
  finally { subscription?.remove(); }
}
