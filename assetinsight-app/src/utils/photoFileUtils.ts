import {
  IMAGE_ADJUSTMENT_VERSION,
  ImageAdjustments,
  PhotoFile,
} from '../components/camera/types';

type LegacyAdjustments = Partial<ImageAdjustments> & {
  detail?: number;
};

export const DEFAULT_IMAGE_ADJUSTMENTS: ImageAdjustments = {
  brightness: 0,
  contrast: 1,
  saturation: 1,
  sharpness: 0,
  clarity: 0,
  version: IMAGE_ADJUSTMENT_VERSION,
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export const normalizeImageAdjustments = (
  adjustments?: LegacyAdjustments | null
): ImageAdjustments | undefined => {
  if (!adjustments) return undefined;

  const normalized: ImageAdjustments = {
    brightness:
      typeof adjustments.brightness === 'number' ? clamp(adjustments.brightness, -1, 1) : 0,
    contrast: typeof adjustments.contrast === 'number' ? clamp(adjustments.contrast, 0.2, 2.5) : 1,
    saturation:
      typeof adjustments.saturation === 'number' ? clamp(adjustments.saturation, 0, 3) : 1,
    sharpness:
      typeof adjustments.sharpness === 'number' ? clamp(adjustments.sharpness, 0, 2) : 0,
    clarity:
      typeof adjustments.clarity === 'number'
        ? clamp(adjustments.clarity, 0, 2)
        : typeof adjustments.detail === 'number'
          ? clamp(adjustments.detail, 0, 2)
          : 0,
    version: IMAGE_ADJUSTMENT_VERSION,
  };

  return areImageAdjustmentsDefault(normalized) ? undefined : normalized;
};

export const areImageAdjustmentsDefault = (adjustments?: ImageAdjustments | null) => {
  if (!adjustments) return true;
  return (
    Math.abs(adjustments.brightness - DEFAULT_IMAGE_ADJUSTMENTS.brightness) < 0.0001 &&
    Math.abs(adjustments.contrast - DEFAULT_IMAGE_ADJUSTMENTS.contrast) < 0.0001 &&
    Math.abs(adjustments.saturation - DEFAULT_IMAGE_ADJUSTMENTS.saturation) < 0.0001 &&
    Math.abs(adjustments.sharpness - DEFAULT_IMAGE_ADJUSTMENTS.sharpness) < 0.0001 &&
    Math.abs(adjustments.clarity - DEFAULT_IMAGE_ADJUSTMENTS.clarity) < 0.0001
  );
};

export const areImageAdjustmentsEqual = (
  left?: ImageAdjustments | null,
  right?: ImageAdjustments | null
) => {
  const normalizedLeft = normalizeImageAdjustments(left);
  const normalizedRight = normalizeImageAdjustments(right);

  if (!normalizedLeft && !normalizedRight) return true;
  if (!normalizedLeft || !normalizedRight) return false;

  return (
    Math.abs(normalizedLeft.brightness - normalizedRight.brightness) < 0.0001 &&
    Math.abs(normalizedLeft.contrast - normalizedRight.contrast) < 0.0001 &&
    Math.abs(normalizedLeft.saturation - normalizedRight.saturation) < 0.0001 &&
    Math.abs(normalizedLeft.sharpness - normalizedRight.sharpness) < 0.0001 &&
    Math.abs(normalizedLeft.clarity - normalizedRight.clarity) < 0.0001
  );
};

export const getPhotoOriginalUri = (photo: Pick<PhotoFile, 'uri' | 'originalUri'>) =>
  photo.originalUri ?? photo.uri;

export const getPhotoDisplayUri = (
  photo: Pick<PhotoFile, 'uri' | 'displayUri' | 'editedUri'>
) => photo.editedUri ?? photo.displayUri ?? photo.uri;

export const getPhotoUploadUri = (photo: Pick<PhotoFile, 'uri' | 'editedUri'>) =>
  photo.editedUri ?? photo.uri;

export const normalizePhotoFile = (photo: PhotoFile): PhotoFile => {
  const adjustments = normalizeImageAdjustments(photo.adjustments);
  const originalUri = photo.originalUri ?? photo.uri;
  const editedUri = photo.editedUri;

  return {
    ...photo,
    uri: originalUri,
    originalUri,
    editedUri,
    displayUri: editedUri ?? photo.displayUri ?? originalUri,
    adjustments,
  };
};

export const withSavedPhotoEdits = (
  photo: PhotoFile,
  adjustments: ImageAdjustments,
  editedUri: string
): PhotoFile =>
  normalizePhotoFile({
    ...photo,
    originalUri: photo.originalUri ?? photo.uri,
    editedUri,
    displayUri: editedUri,
    adjustments,
  });

export const withoutPhotoEdits = (photo: PhotoFile): PhotoFile =>
  normalizePhotoFile({
    ...photo,
    editedUri: undefined,
    displayUri: photo.originalUri ?? photo.uri,
    adjustments: undefined,
  });
