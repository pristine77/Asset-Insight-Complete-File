import type {
  LocalSupportAttachment,
  SupportAttachmentKind,
  SupportUploadConstraints,
} from '../services/supportService';

export const SUPPORT_ATTACHMENT_LIMIT = 8;
export const SUPPORT_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const SUPPORT_VIDEO_MAX_BYTES = 250 * 1024 * 1024;

function extension(value: string): string {
  return value.split('?')[0].split('.').pop()?.toLowerCase() || '';
}

export function inferSupportMediaType(input: {
  fileName?: string | null;
  mimeType?: string | null;
  assetType?: string | null;
}): { kind: SupportAttachmentKind; contentType: string } | null {
  const mimeType = String(input.mimeType || '').toLowerCase();
  const ext = extension(String(input.fileName || ''));
  const isVideo =
    input.assetType === 'video' ||
    mimeType.startsWith('video/') ||
    ['mp4', 'mov', 'm4v', 'webm'].includes(ext);
  const isImage =
    input.assetType === 'image' ||
    mimeType.startsWith('image/') ||
    ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'].includes(ext);

  if (isVideo) {
    const contentType = mimeType.startsWith('video/')
      ? mimeType
      : ext === 'mov'
        ? 'video/quicktime'
        : ext === 'webm'
          ? 'video/webm'
          : 'video/mp4';
    return { kind: 'video', contentType };
  }
  if (isImage) {
    const contentType = mimeType.startsWith('image/')
      ? mimeType
      : ext === 'png'
        ? 'image/png'
        : ext === 'webp'
          ? 'image/webp'
          : ext === 'heic'
            ? 'image/heic'
            : ext === 'heif'
              ? 'image/heif'
              : 'image/jpeg';
    return { kind: 'image', contentType };
  }
  return null;
}

export function validateSupportMedia(
  file: LocalSupportAttachment,
  constraints?: Pick<SupportUploadConstraints, 'maxImageBytes' | 'maxVideoBytes'>
): string | null {
  if (!file.uri.trim()) return 'The selected media file is unavailable.';
  if (file.kind === 'image' && !file.contentType.startsWith('image/')) {
    return 'Only supported image formats can be attached as images.';
  }
  if (file.kind === 'video' && !file.contentType.startsWith('video/')) {
    return 'Only supported video formats can be attached as videos.';
  }
  if (typeof file.size !== 'number') return null;
  const maxBytes =
    file.kind === 'video'
      ? constraints?.maxVideoBytes || SUPPORT_VIDEO_MAX_BYTES
      : constraints?.maxImageBytes || SUPPORT_IMAGE_MAX_BYTES;
  if (file.size > maxBytes) {
    const maxMb = Math.round(maxBytes / (1024 * 1024));
    return `${file.kind === 'video' ? 'Videos' : 'Images'} must be ${maxMb} MB or smaller.`;
  }
  return null;
}
