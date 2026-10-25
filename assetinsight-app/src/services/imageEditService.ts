import * as FileSystem from 'expo-file-system/legacy';
import { addPhotoWatermarkReceipt, hasPhotoWatermarkReceipt, photoBytesFromBase64, photoBytesToBase64 } from '../utils/photoWatermarkReceipt';

const getImageEditsDir = (): string => `${FileSystem.documentDirectory || ''}image_edits/`;

const ensureImageEditsDirExists = async (): Promise<void> => {
  const info = await FileSystem.getInfoAsync(getImageEditsDir());
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(getImageEditsDir(), { intermediates: true });
  }
};

const getSafeBaseName = (name?: string) => {
  const candidate = name?.replace(/\.[^.]+$/, '') || 'image';
  return candidate.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 48) || 'image';
};

const getManagedPrefixes = () => [getImageEditsDir()];

const isManagedLocalUri = (uri?: string | null) => {
  if (!uri) return false;
  return getManagedPrefixes().some((prefix) => uri.startsWith(prefix));
};

export const ImageEditService = {
  getImageEditsDir,

  isManagedEditedUri(uri?: string | null) {
    return isManagedLocalUri(uri);
  },

  async saveEditedImageBase64(base64: string, lotId: string, imageName?: string, sourceUri?: string): Promise<string> {
    if (sourceUri) {
      let source: Uint8Array;
      if (/^https?:\/\//i.test(sourceUri)) {
        const response = await fetch(sourceUri);
        if (!response.ok) throw new Error('Unable to verify the original photo. Please retry saving.');
        source = new Uint8Array(await response.arrayBuffer());
      } else {
        source = photoBytesFromBase64(await FileSystem.readAsStringAsync(sourceUri, { encoding: FileSystem.EncodingType.Base64 }));
      }
      if (await hasPhotoWatermarkReceipt(source)) {
        base64 = photoBytesToBase64(await addPhotoWatermarkReceipt(photoBytesFromBase64(base64)));
      }
    }
    await ensureImageEditsDirExists();

    const fileName = `${getSafeBaseName(lotId)}_${getSafeBaseName(imageName)}_${Date.now()}.jpg`;
    const destination = `${getImageEditsDir()}${fileName}`;

    await FileSystem.writeAsStringAsync(destination, base64, {
      encoding: FileSystem.EncodingType?.Base64 ?? 'base64',
    });

    return destination;
  },

  async deleteEditedImage(uri?: string | null): Promise<void> {
    if (!uri || !isManagedLocalUri(uri)) return;
    const targetUri: string = uri;

    try {
      const info = await FileSystem.getInfoAsync(targetUri);
      if (info.exists) {
        await FileSystem.deleteAsync(targetUri, { idempotent: true });
      }
    } catch (error) {
      console.warn('[ImageEditService] Failed to delete edited image:', error);
    }
  },
};

export default ImageEditService;
