import { CryptoDigestAlgorithm, digest } from 'expo-crypto';

const prefix = Uint8Array.from('AssetInsight:photo-watermark:v1\0', (c) => c.charCodeAt(0));
const payloadSize = prefix.length + 32;
const jpegSize = payloadSize + 4;
const boxSize = payloadSize + 8;
const ascii = (data: Uint8Array, start: number, count: number) =>
  String.fromCharCode(...data.slice(start, start + count));
const isJpeg = (data: Uint8Array) => data[0] === 255 && data[1] === 216;
const isWebp = (data: Uint8Array) => ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 4) === 'WEBP';
const isAvif = (data: Uint8Array) =>
  ascii(data, 4, 4) === 'ftyp' && ['avif', 'avis'].includes(ascii(data, 8, 4));
const view = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength);
const same = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((n, i) => n === b[i]);
const join = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((size, p) => size + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};
const hash = async (data: Uint8Array) =>
  new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, new Uint8Array(data).buffer));

export async function hasPhotoWatermarkReceipt(data: Uint8Array): Promise<boolean> {
  if (isJpeg(data)) {
    if (
      data.length < jpegSize + 2 ||
      data[2] !== 255 ||
      data[3] !== 239 ||
      view(data).getUint16(4) !== payloadSize + 2
    )
      return false;
    if (!same(data.slice(6, 6 + prefix.length), prefix)) return false;
    return same(
      data.slice(6 + prefix.length, 2 + jpegSize),
      await hash(join(data.slice(0, 2), data.slice(2 + jpegSize)))
    );
  }
  const offset = data.length - boxSize;
  if (offset < 12 || (!isWebp(data) && !isAvif(data))) return false;
  if (isWebp(data)) {
    if (
      view(data).getUint32(4, true) !== data.length - 8 ||
      ascii(data, offset, 4) !== 'aiwm' ||
      view(data).getUint32(offset + 4, true) !== payloadSize
    )
      return false;
  } else if (view(data).getUint32(offset) !== boxSize || ascii(data, offset + 4, 4) !== 'free')
    return false;
  if (!same(data.slice(offset + 8, offset + 8 + prefix.length), prefix)) return false;
  const original = data.slice(0, offset);
  if (isWebp(data)) view(original).setUint32(4, original.length - 8, true);
  return same(data.slice(offset + 8 + prefix.length), await hash(original));
}

/** Only for freshly stamped camera output or edits whose source receipt verified. */
export async function addPhotoWatermarkReceipt(data: Uint8Array): Promise<Uint8Array> {
  if (await hasPhotoWatermarkReceipt(data)) return data;
  const checksum = await hash(data);
  if (isJpeg(data)) {
    return join(
      data.slice(0, 2),
      new Uint8Array([255, 239, 0, payloadSize + 2]),
      prefix,
      checksum,
      data.slice(2)
    );
  }
  if (!isWebp(data) && !isAvif(data)) throw new Error('Unsupported watermark photo format');
  const marker = new Uint8Array(boxSize);
  if (isWebp(data)) {
    if (view(data).getUint32(4, true) !== data.length - 8) throw new Error('Invalid WebP size');
    marker.set(Uint8Array.from('aiwm', (c) => c.charCodeAt(0)));
    view(marker).setUint32(4, payloadSize, true);
  } else {
    view(marker).setUint32(0, boxSize);
    marker.set(
      Uint8Array.from('free', (c) => c.charCodeAt(0)),
      4
    );
  }
  marker.set(prefix, 8);
  marker.set(checksum, 8 + prefix.length);
  const result = join(data, marker);
  if (isWebp(data)) view(result).setUint32(4, result.length - 8, true);
  return result;
}

export const photoBytesFromBase64 = (data: string) =>
  Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
export function photoBytesToBase64(data: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < data.length; i += 8192)
    chunks.push(String.fromCharCode(...data.subarray(i, i + 8192)));
  return btoa(chunks.join(''));
}
