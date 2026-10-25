import { createHash } from 'node:crypto';
import {
  addPhotoWatermarkReceipt,
  hasPhotoWatermarkReceipt,
  photoBytesFromBase64,
  photoBytesToBase64,
} from './photoWatermarkReceipt';

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digest: async (_algorithm: string, bytes: ArrayBuffer) => {
    const result = require('node:crypto').createHash('sha256').update(Buffer.from(bytes)).digest();
    return Uint8Array.from(result).buffer;
  },
}));

function input(format: string) {
  if (format === 'jpeg') return Buffer.from([255, 216, 255, 217]);
  if (format === 'avif') return Buffer.from([0, 0, 0, 16, ...Buffer.from('ftypavif'), 0, 0, 0, 0]);
  return Buffer.from([...Buffer.from('RIFF'), 12, 0, 0, 0, ...Buffer.from('WEBPVP8 '), 0, 0, 0, 0]);
}

it.each(['jpeg', 'webp', 'avif'])('matches the backend/native %s byte protocol', async (format) => {
  const original = input(format);
  const prefix = Buffer.from('AssetInsight:photo-watermark:v1\0');
  const checksum = createHash('sha256').update(original).digest();
  const payload = Buffer.concat([prefix, checksum]);
  const header =
    format === 'jpeg' ? Buffer.from([255, 239, 0, payload.length + 2]) : Buffer.alloc(8);
  if (format === 'webp') {
    header.write('aiwm');
    header.writeUInt32LE(payload.length, 4);
  }
  if (format === 'avif') {
    header.writeUInt32BE(payload.length + 8, 0);
    header.write('free', 4);
  }
  const expected =
    format === 'jpeg'
      ? Buffer.concat([original.subarray(0, 2), header, payload, original.subarray(2)])
      : Buffer.concat([original, header, payload]);
  if (format === 'webp') expected.writeUInt32LE(expected.length - 8, 4);
  const marked = await addPhotoWatermarkReceipt(Uint8Array.from(original));
  expect(Buffer.from(marked)).toEqual(expected);
  expect(await hasPhotoWatermarkReceipt(marked)).toBe(true);
  expect(await addPhotoWatermarkReceipt(marked)).toBe(marked);
  expect(await hasPhotoWatermarkReceipt(marked.subarray(0, 12))).toBe(false);
  const corrupt = marked.slice();
  corrupt[corrupt.length - 1] ^= 1;
  expect(await hasPhotoWatermarkReceipt(corrupt)).toBe(false);
  expect(photoBytesFromBase64(photoBytesToBase64(marked))).toEqual(marked);
});
