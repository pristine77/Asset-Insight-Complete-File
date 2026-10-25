import { Image } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import { Skia } from '@shopify/react-native-skia';
import { stampCameraPhoto } from './cameraPhotoWatermark';
import { ImageEditService } from './imageEditService';
import {
  addPhotoWatermarkReceipt,
  hasPhotoWatermarkReceipt,
  photoBytesToBase64,
} from '../utils/photoWatermarkReceipt';

jest.mock('expo-crypto', () => ({
  randomUUID: () => 'test-capture',
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digest: async (_algorithm: string, bytes: ArrayBuffer) =>
    Uint8Array.from(require('node:crypto').createHash('sha256').update(Buffer.from(bytes)).digest())
      .buffer,
}));
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///test/',
  EncodingType: { Base64: 'base64' },
  getInfoAsync: jest.fn(async () => ({ exists: true })),
  makeDirectoryAsync: jest.fn(async () => {}),
  writeAsStringAsync: jest.fn(async () => {}),
  readAsStringAsync: jest.fn(),
  deleteAsync: jest.fn(async () => {}),
}));
jest.mock('expo-image-manipulator', () => ({
  SaveFormat: { JPEG: 'jpeg' },
  manipulateAsync: jest.fn(async () => ({ uri: 'file:///normalized.jpg' })),
}));
jest.mock('@shopify/react-native-skia', () => {
  const image = { width: () => 4000, height: () => 3000, dispose: jest.fn() };
  const canvas = { drawImageRect: jest.fn() };
  const paint = { setAlphaf: jest.fn(), dispose: jest.fn() };
  const snapshot = {
    encodeToBytes: jest.fn(() => new Uint8Array([255, 216, 255, 217])),
    dispose: jest.fn(),
  };
  const surface = {
    getCanvas: () => canvas,
    flush: jest.fn(),
    makeImageSnapshot: () => snapshot,
    dispose: jest.fn(),
  };
  return {
    ImageFormat: { JPEG: 'jpeg' },
    Skia: {
      Data: { fromURI: jest.fn(async (uri) => uri) },
      Image: { MakeImageFromEncoded: jest.fn(() => image) },
      Surface: { MakeOffscreen: jest.fn(() => surface) },
      Paint: () => paint,
      XYWHRect: (...args: number[]) => args,
    },
    fixture: { image, canvas, paint, snapshot, surface },
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .spyOn(Image, 'resolveAssetSource')
    .mockReturnValue({ uri: 'asset://mcd-logo', width: 400, height: 200, scale: 1 });
});

it('stamps one logo before saving a receipt-bearing camera JPEG with bounded dimensions', async () => {
  const result = await stampCameraPhoto('file:///raw.jpg');
  const { fixture } = jest.requireMock('@shopify/react-native-skia');
  expect(result).toBe('file:///test/camera-photos/test-capture.jpg');
  expect(ImageManipulator.manipulateAsync).toHaveBeenCalledTimes(1);
  // Restore the pre-reduction camera dimensions; keep the stamp/receipt flow.
  expect(Skia.Surface.MakeOffscreen).toHaveBeenCalledWith(3000, 2250);
  expect(fixture.snapshot.encodeToBytes).toHaveBeenCalledTimes(1);
  expect(fixture.snapshot.encodeToBytes).toHaveBeenCalledWith('jpeg', 95);
  expect(fixture.canvas.drawImageRect).toHaveBeenCalledTimes(2); // original, then one logo
  expect(fixture.paint.setAlphaf).toHaveBeenCalledWith(200 / 255);
  const [, encoded] = jest.mocked(FileSystem.writeAsStringAsync).mock.calls[0];
  expect(await hasPhotoWatermarkReceipt(Uint8Array.from(Buffer.from(encoded, 'base64')))).toBe(
    true
  );
  expect(fixture.surface.dispose).toHaveBeenCalled();
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///normalized.jpg', {
    idempotent: true,
  });
});

it('preserves portrait detail with a 3000 px longest side', async () => {
  const { fixture } = jest.requireMock('@shopify/react-native-skia');
  const original = { width: fixture.image.width, height: fixture.image.height };
  fixture.image.width = () => 3024;
  fixture.image.height = () => 4032;
  try {
    await stampCameraPhoto('file:///raw.jpg');
    expect(Skia.Surface.MakeOffscreen).toHaveBeenCalledWith(2250, 3000);
  } finally {
    Object.assign(fixture.image, original);
  }
});

it('does not enlarge a photo smaller than the box', async () => {
  const { fixture } = jest.requireMock('@shopify/react-native-skia');
  const original = { width: fixture.image.width, height: fixture.image.height };
  fixture.image.width = () => 1000;
  fixture.image.height = () => 750;
  try {
    await stampCameraPhoto('file:///raw.jpg');
    expect(Skia.Surface.MakeOffscreen).toHaveBeenCalledWith(1000, 750);
  } finally {
    Object.assign(fixture.image, original);
  }
});

it('encodes once at quality 95 even above the former 300 KiB budget', async () => {
  const { fixture } = jest.requireMock('@shopify/react-native-skia');
  const jpegOf = (size: number) => {
    const bytes = new Uint8Array(size);
    bytes.set([255, 216], 0);
    bytes.set([255, 217], size - 2);
    return bytes;
  };
  fixture.snapshot.encodeToBytes.mockReturnValueOnce(jpegOf(1500 * 1024));
  await stampCameraPhoto('file:///raw.jpg');
  expect(fixture.snapshot.encodeToBytes.mock.calls.map((call: unknown[]) => call[1])).toEqual([95]);
  const [, encoded] = jest.mocked(FileSystem.writeAsStringAsync).mock.calls[0];
  expect(Buffer.from(encoded, 'base64').length).toBeGreaterThan(1500 * 1024);
});

it('does not save an unmarked camera photo if the logo cannot be decoded', async () => {
  jest.mocked(Skia.Image.MakeImageFromEncoded).mockReturnValueOnce(null);
  await expect(stampCameraPhoto('file:///raw.jpg')).rejects.toThrow('watermark');
  expect(FileSystem.writeAsStringAsync).not.toHaveBeenCalled();
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith('file:///normalized.jpg', {
    idempotent: true,
  });
});

it('retains camera watermark provenance when saving edited bytes without stamping again', async () => {
  const source = await addPhotoWatermarkReceipt(new Uint8Array([255, 216, 1, 2, 255, 217]));
  jest.mocked(FileSystem.readAsStringAsync).mockResolvedValueOnce(photoBytesToBase64(source));
  const edited = new Uint8Array([255, 216, 3, 4, 255, 217]);
  await ImageEditService.saveEditedImageBase64(
    photoBytesToBase64(edited),
    'lot1',
    'photo.jpg',
    'file:///source.jpg'
  );
  const [, saved] = jest.mocked(FileSystem.writeAsStringAsync).mock.calls[0];
  expect(Buffer.from(saved, 'base64')).toEqual(Buffer.from(await addPhotoWatermarkReceipt(edited)));
  expect(Skia.Image.MakeImageFromEncoded).not.toHaveBeenCalled();
});

it('does not claim imported unwatermarked photos were already stamped', async () => {
  jest.mocked(FileSystem.readAsStringAsync).mockResolvedValueOnce('/9j/2Q==');
  await ImageEditService.saveEditedImageBase64(
    '/9j/2Q==',
    'lot1',
    'photo.jpg',
    'file:///import.jpg'
  );
  expect(FileSystem.writeAsStringAsync).toHaveBeenCalledWith(
    expect.any(String),
    '/9j/2Q==',
    expect.any(Object)
  );
});

it('keeps the existing edit unsaved if the source cannot be verified', async () => {
  const fetchMock = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce({ ok: false, status: 404 } as Response);
  try {
    await expect(
      ImageEditService.saveEditedImageBase64(
        '/9j/2Q==',
        'lot1',
        'photo.jpg',
        'https://example.test/photo.jpg'
      )
    ).rejects.toThrow('verify the original');
    expect(FileSystem.writeAsStringAsync).not.toHaveBeenCalled();
  } finally {
    fetchMock.mockRestore();
  }
});
