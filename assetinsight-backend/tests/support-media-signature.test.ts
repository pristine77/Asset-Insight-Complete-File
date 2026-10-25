import { describe, expect, it } from "vitest";
import {
  matchesSupportMediaSignature,
  supportMediaSignatureBytes,
} from "../src/utils/supportMediaSignature.js";

function bmffSignature(brand: string, extended = false): Buffer {
  const prefix = Buffer.alloc(24);
  if (extended) {
    prefix.writeUInt32BE(1, 0);
    prefix.write("ftyp", 4, "ascii");
    prefix.writeBigUInt64BE(24n, 8);
    prefix.write(brand, 16, 4, "ascii");
    return prefix;
  }
  prefix.writeUInt32BE(24, 0);
  prefix.write("ftyp", 4, "ascii");
  prefix.write(brand, 8, 4, "ascii");
  prefix.write(brand, 16, 4, "ascii");
  return prefix;
}

describe("support media signatures", () => {
  it.each([
    ["image/jpeg", Buffer.from([0xff, 0xd8, 0xff])],
    ["image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ["image/gif", Buffer.from("GIF89a", "ascii")],
    [
      "image/webp",
      Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
    ],
    ["image/heic", bmffSignature("heic")],
    ["image/heif", bmffSignature("mif1")],
    ["video/mp4", bmffSignature("mp42")],
    ["video/mp4", bmffSignature("isom", true)],
    ["video/x-m4v", bmffSignature("M4V ")],
    ["video/quicktime", bmffSignature("qt  ")],
    ["video/webm", Buffer.from([0x1a, 0x45, 0xdf, 0xa3])],
  ])("accepts a minimal %s signature", (contentType, prefix) => {
    expect(matchesSupportMediaSignature(contentType, prefix)).toBe(true);
    expect(prefix.length).toBeGreaterThanOrEqual(
      supportMediaSignatureBytes(contentType) ?? Number.POSITIVE_INFINITY
    );
  });

  it.each([
    ["image/png", Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0])],
    ["image/heic", bmffSignature("mp42")],
    ["video/mp4", bmffSignature("heic")],
    ["video/quicktime", bmffSignature("mp42")],
    ["video/webm", Buffer.from([0x1a, 0x45, 0xdf])],
    ["application/octet-stream", Buffer.alloc(24)],
  ])("rejects bytes that do not match %s", (contentType, prefix) => {
    expect(matchesSupportMediaSignature(contentType, prefix)).toBe(false);
  });
});
