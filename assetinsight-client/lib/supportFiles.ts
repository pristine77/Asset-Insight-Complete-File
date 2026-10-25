export const SUPPORT_MAX_ATTACHMENTS = 8;
export const SUPPORT_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const SUPPORT_MAX_VIDEO_BYTES = 250 * 1024 * 1024;

export type SupportFileLimits = {
  imageContentTypes: string[];
  videoContentTypes: string[];
  maxImageBytes: number;
  maxVideoBytes: number;
  maxAttachmentsPerMessage: number;
  maxPendingUploads: number;
};

const IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
]);
const VIDEO_CONTENT_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-m4v",
]);

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  m4v: "video/x-m4v",
};

export const DEFAULT_SUPPORT_FILE_LIMITS: SupportFileLimits = {
  imageContentTypes: Array.from(IMAGE_CONTENT_TYPES),
  videoContentTypes: Array.from(VIDEO_CONTENT_TYPES),
  maxImageBytes: SUPPORT_MAX_IMAGE_BYTES,
  maxVideoBytes: SUPPORT_MAX_VIDEO_BYTES,
  maxAttachmentsPerMessage: SUPPORT_MAX_ATTACHMENTS,
  maxPendingUploads: 20,
};

const EXTENSION_ACCEPTS = [
  ".heic",
  ".heif",
  ".mov",
  ".m4v",
];

export function supportFileAccept(
  limits: SupportFileLimits = DEFAULT_SUPPORT_FILE_LIMITS
) {
  return [
    ...limits.imageContentTypes,
    ...limits.videoContentTypes,
    ...EXTENSION_ACCEPTS,
  ].join(",");
}

export function supportFileKey(file: File) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

export function supportFileContentType(file: File) {
  const declared = file.type.trim().toLowerCase();
  if (IMAGE_CONTENT_TYPES.has(declared) || VIDEO_CONTENT_TYPES.has(declared)) {
    return declared;
  }
  const extension = file.name.split(".").pop()?.toLowerCase() || "";
  return CONTENT_TYPE_BY_EXTENSION[extension] || declared;
}

export function supportFileKind(
  file: File,
  limits: SupportFileLimits = DEFAULT_SUPPORT_FILE_LIMITS
): "image" | "video" | null {
  const contentType = supportFileContentType(file);
  if (limits.imageContentTypes.includes(contentType)) return "image";
  if (limits.videoContentTypes.includes(contentType)) return "video";
  return null;
}

export function appendSupportFiles(
  current: File[],
  incoming: File[],
  limits: SupportFileLimits = DEFAULT_SUPPORT_FILE_LIMITS
) {
  const unique = new Map(current.map((file) => [supportFileKey(file), file]));
  const errors: string[] = [];

  for (const file of incoming) {
    const kind = supportFileKind(file, limits);
    if (!kind) {
      errors.push(`${file.name} is not a supported image or video.`);
      continue;
    }
    const limit =
      kind === "image" ? limits.maxImageBytes : limits.maxVideoBytes;
    if (file.size <= 0 || file.size > limit) {
      const maximum = Math.max(1, Math.floor(limit / (1024 * 1024)));
      errors.push(`${file.name} must be ${maximum} MiB or smaller.`);
      continue;
    }
    if (!unique.has(supportFileKey(file))) {
      unique.set(supportFileKey(file), file);
    }
  }

  const maxAttachments = Math.max(1, limits.maxAttachmentsPerMessage);
  const files = Array.from(unique.values()).slice(0, maxAttachments);
  if (unique.size > maxAttachments) {
    errors.push(`You can attach up to ${maxAttachments} files per message.`);
  }
  return { files, error: errors[0] || null };
}
