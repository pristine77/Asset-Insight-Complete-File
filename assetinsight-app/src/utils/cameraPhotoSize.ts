/**
 * Standard camera photo size restored to the pre-2026-10-02 policy.
 *
 * A standard photo keeps its aspect ratio, is never enlarged, and has at most
 * 3000 pixels on its longest side. The JS camera encodes once at JPEG quality
 * 95, without the later 300 KiB quality ladder.
 *
 * Pristine 9b1f739 introduced the fixed 1200 x 900 reduction on 2026-10-02;
 * 551205d reversed it on 2026-10-04. Local restoration requested 2026-10-05.
 *
 * Android's native CameraViewEngine has a separate owner-approved MozJPEG
 * policy (2400 px / approximately 200 KiB since 2026-10-22). These constants
 * remain the iOS/JS policy; they do not re-encode native Android captures.
 */
export const CAMERA_PHOTO_MAX_SIDE = 3000;
export const CAMERA_PHOTO_BOX = Object.freeze({
  width: CAMERA_PHOTO_MAX_SIDE,
  height: CAMERA_PHOTO_MAX_SIDE,
});

export const CAMERA_PHOTO_JPEG_QUALITY = 95;

/** The size that fits width x height inside the box, keeping the shape and never enlarging. */
export function fitInsideBox(
  width: number,
  height: number,
  box: { width: number; height: number } = CAMERA_PHOTO_BOX
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width, height };
  const scale = Math.min(1, box.width / width, box.height / height);
  if (scale >= 1) return { width, height };
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
