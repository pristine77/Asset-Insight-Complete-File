// Video is deliberately independent of the still-photo quality/low-light controls.
export const VIDEO_RECORDING_RESOLUTION = Object.freeze({ width: 1280, height: 720 });
export const VIDEO_RECORDING_FPS = 30;
export const VIDEO_RECORDING_BIT_RATE = 5_000_000;

export function supportsRequiredVideoSession(
  resolution: { width: number; height: number } | undefined,
  framesPerSecond: number | undefined,
): boolean {
  if (!resolution || framesPerSecond !== VIDEO_RECORDING_FPS) return false;
  return Math.max(resolution.width, resolution.height) === 1280 &&
    Math.min(resolution.width, resolution.height) === 720;
}
