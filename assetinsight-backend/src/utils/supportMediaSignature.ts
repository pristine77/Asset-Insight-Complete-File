/**
 * The number of leading bytes needed to identify each support-media format.
 * ISO BMFF formats reserve a larger prefix so normal and extended `ftyp`
 * boxes can both be checked without retaining the rest of the upload.
 */
const SIGNATURE_BYTES_BY_CONTENT_TYPE = new Map<string, number>([
  ["image/jpeg", 3],
  ["image/png", 8],
  ["image/gif", 6],
  ["image/webp", 12],
  ["image/heic", 24],
  ["image/heif", 24],
  ["video/mp4", 24],
  ["video/x-m4v", 24],
  ["video/quicktime", 24],
  ["video/webm", 4],
]);

const HEIF_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
]);

const MP4_BRANDS = new Set([
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "iso7",
  "iso8",
  "iso9",
  "avc1",
  "mp41",
  "mp42",
  "mp4v",
  "dash",
  "cmfc",
  "cmfs",
  "M4V ",
  "M4VH",
  "M4VP",
  "F4V ",
]);

const M4V_BRANDS = new Set([
  ...MP4_BRANDS,
  "M4V ",
  "M4VH",
  "M4VP",
]);

const QUICKTIME_BRANDS = new Set(["qt  "]);

function hasBytes(value: Buffer, expected: readonly number[]): boolean {
  return (
    value.length >= expected.length &&
    expected.every((byte, index) => value[index] === byte)
  );
}

function isoBmffMajorBrand(prefix: Buffer): string | undefined {
  if (prefix.length < 24 || prefix.toString("ascii", 4, 8) !== "ftyp") {
    return undefined;
  }

  const boxSize = prefix.readUInt32BE(0);
  if (boxSize === 1) {
    // A size of one selects the 64-bit extended-size form. Its major brand is
    // shifted by eight bytes compared with the normal form.
    const extendedSize = prefix.readBigUInt64BE(8);
    if (extendedSize < 24n) return undefined;
    return prefix.toString("ascii", 16, 20);
  }
  if (boxSize < 16) return undefined;
  return prefix.toString("ascii", 8, 12);
}

/** Return the bounded prefix length required for the declared media type. */
export function supportMediaSignatureBytes(contentType: string): number | undefined {
  return SIGNATURE_BYTES_BY_CONTENT_TYPE.get(contentType.trim().toLowerCase());
}

/**
 * Match an allowlisted MIME declaration to a leading file signature.
 *
 * This deliberately validates format identity, not whether a complete file can
 * be decoded. Decoder-level validation belongs in asynchronous media
 * processing; this boundary prevents obvious content-type spoofing before an
 * attachment becomes chat-visible.
 */
export function matchesSupportMediaSignature(
  contentType: string,
  prefix: Buffer
): boolean {
  const normalized = contentType.trim().toLowerCase();
  switch (normalized) {
    case "image/jpeg":
      return hasBytes(prefix, [0xff, 0xd8, 0xff]);
    case "image/png":
      return hasBytes(prefix, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/gif": {
      const signature = prefix.toString("ascii", 0, 6);
      return signature === "GIF87a" || signature === "GIF89a";
    }
    case "image/webp":
      return (
        prefix.length >= 12 &&
        prefix.toString("ascii", 0, 4) === "RIFF" &&
        prefix.toString("ascii", 8, 12) === "WEBP"
      );
    case "image/heic":
    case "image/heif": {
      const brand = isoBmffMajorBrand(prefix);
      return brand !== undefined && HEIF_BRANDS.has(brand);
    }
    case "video/mp4": {
      const brand = isoBmffMajorBrand(prefix);
      return brand !== undefined && MP4_BRANDS.has(brand);
    }
    case "video/x-m4v": {
      const brand = isoBmffMajorBrand(prefix);
      return brand !== undefined && M4V_BRANDS.has(brand);
    }
    case "video/quicktime": {
      const brand = isoBmffMajorBrand(prefix);
      return brand !== undefined && QUICKTIME_BRANDS.has(brand);
    }
    case "video/webm":
      return hasBytes(prefix, [0x1a, 0x45, 0xdf, 0xa3]);
    default:
      return false;
  }
}
