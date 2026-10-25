type NativeAuctionCameraModule = {
  openAuctionCamera: (initialPayload?: string, requestId?: string) => Promise<string>;
  getCameraCapabilities?: () => Promise<{ lockedStructure: boolean; launchRecovery?: boolean }>;
  cancelCameraLaunch?: (requestId: string) => Promise<boolean>;
  getContentUriInfo?: (uri: string) => Promise<{ exists: boolean; size?: number; type?: string }>;
  getPendingCapture?: (ownerId: string, draftId: string) => Promise<string | null>;
  acknowledgeCapture?: (ownerId: string, draftId: string, sessionId: string, revision: number) => Promise<boolean>;
  streamContentUriUpload?: (args: { id: string; uri: string; url: string; headers: Record<string, string>; size: number; onProgress?: (bytesSent: number, totalBytes: number) => void }) => Promise<{ status: number; body: string; headers: Record<string, string> }>;
  cancelContentUriUpload?: (id: string) => Promise<void>;
};

// Resolve the Android module only when capture or journal recovery needs it.
export async function loadNativeAuctionCamera(): Promise<NativeAuctionCameraModule> {
  const module = (await import('../../../modules/auction-camera')) as NativeAuctionCameraModule;
  if (typeof module.openAuctionCamera !== 'function') {
    throw new Error('Native auction camera module is not available.');
  }
  return module;
}
