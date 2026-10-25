import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import type { MediaOwnership } from './offlineCaptureTypes';
import { loadNativeAuctionCamera } from '../components/camera/nativeAuctionCameraModule';

type ImportMediaArgs = {
  draftId: string;
  lotId: string;
  slot: 'main' | 'extra' | 'video';
  index: number;
  sourceUri: string;
  name?: string;
  type?: string;
  mediaId?: string;
};

export type StoredMedia = {
  ownership: MediaOwnership;
  mediaId: string;
  uri: string;
  thumbnailUri?: string;
  name: string;
  type: string;
  size?: number;
  sourceUri: string;
  createdAt: string;
};

const MEDIA_ROOT = `${FileSystem.documentDirectory || ''}local_media_store/`;
const DRAFT_ROOT = `${MEDIA_ROOT}drafts/`;
const nativeCameraDirs = () =>
  FileSystem.cacheDirectory
    ? [`${FileSystem.cacheDirectory}lot_photos/`, `${FileSystem.cacheDirectory}lot_videos/`]
    : [];
const THUMBNAIL_DIR_NAME = 'thumbs';
const MAX_FILE_OP_CONCURRENCY = 4;
const ORPHAN_MAX_AGE_MS = 48 * 60 * 60 * 1000;
let ownerId: string | null = null;
function createLimiter() {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= MAX_FILE_OP_CONCURRENCY)
      await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await work();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
const boundedImport = createLimiter();
// Existing-photo checks bypass importMedia; their native descriptors still need a global bound.
const boundedMetadata = createLimiter();
const ownerGuard =
  (expected = ownerId) =>
  () => {
    if (ownerId !== expected)
      throw new Error('The signed-in account changed while accessing local media.');
  };

/** Persist references to our durable originals; temporary/provider imports need one managed copy. */
export function durableMediaOwnership(uri: string): MediaOwnership | null {
  if (/^content:\/\/media\//i.test(uri)) return 'gallery';
  if (FileSystem.documentDirectory && uri.startsWith(FileSystem.documentDirectory)) {
    return uri.startsWith(MEDIA_ROOT) ? 'managed' : 'camera';
  }
  // Native Android filesDir is outside Expo's documentDirectory on some builds.
  if (/^file:\/\/[^?#]*\/files\/camera-(?:photos|videos)\//.test(uri)) return 'camera';
  return null;
}

const ensureDirectory = async (dir: string, assertOwner = ownerGuard()): Promise<void> => {
  assertOwner();
  const info = await FileSystem.getInfoAsync(dir);
  assertOwner();
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
    assertOwner();
  }
};

const fileExists = async (uri?: string | null, assertOwner = ownerGuard()): Promise<boolean> => {
  if (!uri) return false;
  try {
    assertOwner();
    const info = await getFileInfo(uri);
    assertOwner();
    return Boolean(info.exists);
  } catch {
    assertOwner();
    return false;
  }
};

const getFileInfo = async (
  uri: string
): Promise<{ exists: boolean; size?: number; modificationTime?: number }> => {
  const assertOwner = ownerGuard();
  return boundedMetadata(async () => {
    assertOwner();
    let result: { exists: boolean; size?: number; modificationTime?: number };
    try {
      if (/^content:\/\/media\//i.test(uri)) {
        const native = await loadNativeAuctionCamera();
        assertOwner();
        if (!native.getContentUriInfo)
          throw new Error('Update the app before saving gallery references.');
        const info = await native.getContentUriInfo(uri);
        result = { exists: info.exists, size: info.size && info.size > 0 ? info.size : undefined };
      } else {
        const info = await FileSystem.getInfoAsync(uri);
        result = {
          exists: Boolean(info.exists),
          size: info.exists && typeof info.size === 'number' ? info.size : undefined,
          modificationTime:
            info.exists && typeof info.modificationTime === 'number'
              ? info.modificationTime
              : undefined,
        };
      }
    } catch {
      result = { exists: false };
    }
    assertOwner();
    return result;
  });
};

const getExtension = (nameOrUri?: string, fallback = 'jpg') => {
  const match = /\.([a-zA-Z0-9]+)(\?|#|$)/.exec(nameOrUri || '');
  return match?.[1]?.toLowerCase() || fallback;
};

const safeNamePart = (value?: string | null) =>
  String(value || 'media')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'media';

const draftDirectory = (draftId: string, expectedOwner: string | null) =>
  `${DRAFT_ROOT}${expectedOwner ? `${safeNamePart(expectedOwner)}_` : ''}${safeNamePart(draftId)}/`;

const makeMediaId = () => `m-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const normalizeSourceUri = (uri: string) => {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(uri)) return uri;
  return `file://${uri}`;
};

const uriScheme = (uri: string) => {
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(uri);
  return match?.[1]?.toLowerCase();
};

const isImage = (type?: string, uri?: string) => {
  const lowerType = String(type || '').toLowerCase();
  if (lowerType.startsWith('image/')) return true;
  const ext = getExtension(uri || '', '').toLowerCase();
  return ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'].includes(ext);
};

const runWithConcurrency = async <T>(
  items: T[],
  worker: (item: T) => Promise<void>,
  concurrency = MAX_FILE_OP_CONCURRENCY
) => {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) break;
        await worker(items[index]);
      }
    })
  );
};

const collectFiles = async (dir: string, assertOwner = ownerGuard()): Promise<string[]> => {
  assertOwner();
  const info = await FileSystem.getInfoAsync(dir);
  assertOwner();
  if (!info.exists) return [];

  const entries = await FileSystem.readDirectoryAsync(dir);
  assertOwner();
  const output: string[] = [];
  for (const entry of entries) {
    const child = `${dir}${entry}`;
    const childInfo = await FileSystem.getInfoAsync(child);
    assertOwner();
    if (childInfo.exists && childInfo.isDirectory) {
      output.push(...(await collectFiles(`${child}/`, assertOwner)));
    } else if (childInfo.exists) {
      output.push(child);
    }
  }
  return output;
};

const deleteIfExists = async (uri?: string | null, assertOwner = ownerGuard()): Promise<void> => {
  if (!uri) return;
  try {
    assertOwner();
    const info = await FileSystem.getInfoAsync(uri);
    assertOwner();
    if (info.exists) {
      await FileSystem.deleteAsync(uri, { idempotent: true });
      assertOwner();
    }
  } catch {
    assertOwner();
    // best-effort cleanup
  }
};

export const LocalMediaStore = {
  mediaRoot: MEDIA_ROOT,
  getFileInfo,
  setOwner(value: string | null) {
    ownerId = value?.trim() || null;
  },

  getDraftDir(draftId: string) {
    return draftDirectory(draftId, ownerId);
  },

  getDraftThumbDir(draftId: string) {
    return `${this.getDraftDir(draftId)}${THUMBNAIL_DIR_NAME}/`;
  },

  isManagedUri(uri?: string | null) {
    return Boolean(uri && uri.startsWith(MEDIA_ROOT));
  },

  async importMedia(args: ImportMediaArgs): Promise<StoredMedia | null> {
    const expectedOwner = ownerId;
    const assertOwner = ownerGuard(expectedOwner);
    const draftDir = draftDirectory(args.draftId, expectedOwner);
    return boundedImport(async () => {
      assertOwner();
      const sourceUri = normalizeSourceUri(args.sourceUri);
      const sourceInfo = await getFileInfo(sourceUri);
      assertOwner();
      const scheme = uriScheme(sourceUri);
      const canTryContentCopy = scheme === 'content';
      if (!sourceInfo.exists && !canTryContentCopy) {
        console.warn(`[LocalMediaStore] Source file does not exist: ${args.sourceUri}`);
        return null;
      }

      const ownership = durableMediaOwnership(sourceUri);
      if (ownership && !sourceInfo.exists) return null;
      if (ownership && sourceInfo.exists) {
        return {
          mediaId: args.mediaId || makeMediaId(),
          ownership,
          uri: sourceUri,
          name: args.name || `${args.slot}-${args.index}.${args.slot === 'video' ? 'mp4' : 'jpg'}`,
          type: args.type || (args.slot === 'video' ? 'video/mp4' : 'image/jpeg'),
          size: sourceInfo.size,
          sourceUri,
          createdAt: new Date().toISOString(),
        };
      }

      await ensureDirectory(draftDir, assertOwner);
      assertOwner();

      const mediaId = args.mediaId || makeMediaId();
      const ext = getExtension(args.name || sourceUri, args.slot === 'video' ? 'mp4' : 'jpg');
      const fileName = `${safeNamePart(args.lotId)}_${args.slot}_${String(args.index).padStart(4, '0')}_${safeNamePart(mediaId)}.${ext}`;
      const destinationUri = `${draftDir}${fileName}`;

      if (sourceUri !== destinationUri && !(await fileExists(destinationUri, assertOwner))) {
        try {
          assertOwner();
          await FileSystem.copyAsync({ from: sourceUri, to: destinationUri });
          assertOwner();
        } catch (error) {
          assertOwner();
          console.warn(`[LocalMediaStore] Failed to import media: ${sourceUri}`, error);
          return null;
        }
      }

      const copiedInfo = await getFileInfo(destinationUri);
      assertOwner();
      if (!copiedInfo.exists) {
        console.warn(`[LocalMediaStore] Imported media is missing after copy: ${destinationUri}`);
        return null;
      }

      let thumbnailUri: string | undefined;
      if (isImage(args.type, sourceUri)) {
        try {
          const thumbDir = `${draftDir}${THUMBNAIL_DIR_NAME}/`;
          await ensureDirectory(thumbDir, assertOwner);
          const thumbName = `${safeNamePart(args.lotId)}_${args.slot}_${String(args.index).padStart(4, '0')}_${safeNamePart(mediaId)}.jpg`;
          const thumbTarget = `${thumbDir}${thumbName}`;
          if (!(await fileExists(thumbTarget, assertOwner))) {
            assertOwner();
            const result = await ImageManipulator.manipulateAsync(
              destinationUri,
              [{ resize: { width: 260 } }],
              { compress: 0.65, format: ImageManipulator.SaveFormat.JPEG }
            );
            assertOwner();
            await FileSystem.copyAsync({ from: result.uri, to: thumbTarget });
            assertOwner();
            await deleteIfExists(result.uri, assertOwner);
          }
          thumbnailUri = thumbTarget;
        } catch (error) {
          assertOwner();
          console.warn('[LocalMediaStore] Thumbnail generation failed:', error);
        }
      }

      assertOwner();
      return {
        ownership: 'managed',
        mediaId,
        uri: destinationUri,
        thumbnailUri,
        name: args.name || fileName,
        type: args.type || (args.slot === 'video' ? 'video/mp4' : 'image/jpeg'),
        size: copiedInfo.size ?? sourceInfo.size,
        sourceUri,
        createdAt: new Date().toISOString(),
      };
    });
  },

  async deleteDraftMedia(draftId: string): Promise<void> {
    const expectedOwner = ownerId;
    await deleteIfExists(draftDirectory(draftId, expectedOwner), ownerGuard(expectedOwner));
  },

  async pruneDraftFiles(
    draftId: string,
    keepUris: Iterable<string | undefined | null>
  ): Promise<void> {
    const expectedOwner = ownerId;
    const assertOwner = ownerGuard(expectedOwner);
    const draftDir = draftDirectory(draftId, expectedOwner);
    const keep = new Set(
      Array.from(keepUris)
        .filter(Boolean)
        .map((uri) => String(uri))
        .filter((uri) => uri.startsWith(draftDir))
    );
    const allFiles = await collectFiles(draftDir, assertOwner);
    assertOwner();
    const stale = allFiles.filter((uri) => !keep.has(uri));
    await runWithConcurrency(stale, (uri) => deleteIfExists(uri, assertOwner));
  },

  async getDirectorySize(uri: string): Promise<number> {
    const assertOwner = ownerGuard();
    const info = await FileSystem.getInfoAsync(uri);
    assertOwner();
    if (!info.exists) return 0;
    if (!info.isDirectory) return typeof info.size === 'number' ? info.size : 0;
    const files = await collectFiles(uri.endsWith('/') ? uri : `${uri}/`, assertOwner);
    let total = 0;
    for (const file of files) {
      const fileInfo = await getFileInfo(file);
      assertOwner();
      total += fileInfo.size || 0;
    }
    return total;
  },

  async cleanupOrphanedDraftFolders(
    activeDraftIds: string[],
    activeFileUris: string[] = []
  ): Promise<number> {
    const expectedOwner = ownerId;
    const assertOwner = ownerGuard(expectedOwner);
    const rootInfo = await FileSystem.getInfoAsync(DRAFT_ROOT);
    assertOwner();
    if (!rootInfo.exists) return 0;

    const activeDirs = new Set(activeDraftIds.map((id) => draftDirectory(id, expectedOwner)));
    const activeFiles = new Set(activeFileUris.filter(Boolean));
    const now = Date.now();
    let deletedBytes = 0;
    const entries = await FileSystem.readDirectoryAsync(DRAFT_ROOT);
    assertOwner();

    for (const entry of entries) {
      // Unowned legacy folders and other accounts are never inferred to be disposable.
      assertOwner();
      if (!expectedOwner || !entry.startsWith(`${safeNamePart(expectedOwner)}_`)) continue;
      const dir = `${DRAFT_ROOT}${entry}/`;
      if (activeDirs.has(dir)) continue;

      const files = await collectFiles(dir, assertOwner);
      if (files.some((uri) => activeFiles.has(uri))) continue;
      const newest = Math.max(
        0,
        ...(await Promise.all(
          files.map(async (uri) => (await getFileInfo(uri)).modificationTime || 0)
        ))
      );
      assertOwner();
      if (newest && now - newest * 1000 < ORPHAN_MAX_AGE_MS) continue;

      deletedBytes += await this.getDirectorySize(dir);
      assertOwner();
      await deleteIfExists(dir, assertOwner);
    }

    return deletedBytes;
  },

  async cleanupNativeCameraCache(
    activeFileUris: string[] = [],
    maxAgeMs = ORPHAN_MAX_AGE_MS
  ): Promise<number> {
    const assertOwner = ownerGuard();
    const active = new Set(activeFileUris.filter(Boolean));
    const now = Date.now();
    let deletedBytes = 0;

    for (const dir of nativeCameraDirs()) {
      const info = await FileSystem.getInfoAsync(dir);
      assertOwner();
      if (!info.exists) continue;
      const files = await collectFiles(dir, assertOwner);
      for (const file of files) {
        if (active.has(file)) continue;
        const fileInfo = await getFileInfo(file);
        assertOwner();
        const modifiedMs = fileInfo.modificationTime ? fileInfo.modificationTime * 1000 : 0;
        if (maxAgeMs > 0 && modifiedMs && now - modifiedMs < maxAgeMs) continue;
        deletedBytes += fileInfo.size || 0;
        await deleteIfExists(file, assertOwner);
      }
    }

    return deletedBytes;
  },
};

export default LocalMediaStore;
