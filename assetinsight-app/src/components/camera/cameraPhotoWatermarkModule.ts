// Keep Skia and file-system watermark code lazy until the first camera capture.
export const loadCameraPhotoWatermark = () => import('../../services/cameraPhotoWatermark');
