import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const r2Storage = vi.hoisted(() => ({
  headR2Object: vi.fn(),
  readR2ObjectBuffer: vi.fn(),
  resolveR2ObjectLocationFromUrl: vi.fn(),
}));

vi.mock("../src/utils/r2Storage/r2Upload.js", () => r2Storage);

import { loadAuctioneerPhoto, sniffAuctioneerImageType } from "../src/service/auctioneer2PhotoService.js";
import { AuctioneerDeliveryError } from "../src/service/auctioneer2DeliveryError.js";

describe("reading a photo's type from its bytes, as Auctioneer 2.0 does", () => {
  it("knows the five types Auctioneer takes, and nothing else", () => {
    expect(sniffAuctioneerImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffAuctioneerImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("image/png");
    expect(sniffAuctioneerImageType(Buffer.from("GIF89a", "ascii"))).toBe("image/gif");
    expect(sniffAuctioneerImageType(Buffer.from("RIFF\0\0\0\0WEBP", "binary"))).toBe("image/webp");
    expect(sniffAuctioneerImageType(Buffer.from("\0\0\0\x1cftypavif", "binary"))).toBe("image/avif");
    expect(sniffAuctioneerImageType(Buffer.from("\0\0\0\x18ftypheic", "binary"))).toBeNull();
    expect(sniffAuctioneerImageType(Buffer.from("II*\0", "binary"))).toBeNull();
  });
});

describe("Auctioneer 2.0 photo preparation", () => {
  it.each([
    ["https://youtu.be/AbCdEfGhI_1?token=private", "video link is saved in the photo list"],
    ["https://foreign.test/private?signature=secret", "storage host is not trusted: foreign.test"],
    ["https://res.cloudinary.com/not-our-account/photo.jpg", "Cloudinary account"],
    ["https://user:secret@assetinsight.test/photo.jpg", "invalid storage URL"],
  ])("exposes typed safe photo diagnostics without fetching: %s", async (url, message) => {
    const error = await loadAuctioneerPhoto(url, 0, 0).catch(error => error);
    expect(error).toBeInstanceOf(AuctioneerDeliveryError);
    expect(error.message).toContain(message);
    expect(error.message).not.toMatch(/token=|signature=|secret/);
    expect(r2Storage.headR2Object).not.toHaveBeenCalled();
  });
  const originalR2BucketName = process.env.R2_BUCKET_NAME;
  const originalR2PublicUrl = process.env.R2_PUBLIC_URL;
  const originalR2CustomDomain = process.env.R2_CUSTOM_DOMAIN;

  beforeEach(() => {
    process.env.R2_BUCKET_NAME = "asset-insight-test";
    process.env.R2_PUBLIC_URL = "https://media.asset-insight.example";
    delete process.env.R2_CUSTOM_DOMAIN;
    vi.clearAllMocks();
    r2Storage.resolveR2ObjectLocationFromUrl.mockImplementation((url: string) => {
      const parsed = new URL(url);
      if (parsed.hostname === "media.asset-insight.example") {
        return {
          bucketName: "asset-insight-test",
          publicBaseUrl: "https://media.asset-insight.example",
          generation: "current",
          key: parsed.pathname.replace(/^\/+/, ""),
        };
      }
      if (parsed.hostname === "images.sellsnap.store") {
        return {
          bucketName: "sellsnap",
          publicBaseUrl: "https://images.sellsnap.store",
          generation: "legacy",
          key: parsed.pathname.replace(/^\/+/, ""),
        };
      }
      return null;
    });
  });

  afterEach(() => {
    if (originalR2BucketName === undefined) delete process.env.R2_BUCKET_NAME;
    else process.env.R2_BUCKET_NAME = originalR2BucketName;

    if (originalR2PublicUrl === undefined) delete process.env.R2_PUBLIC_URL;
    else process.env.R2_PUBLIC_URL = originalR2PublicUrl;

    if (originalR2CustomDomain === undefined) delete process.env.R2_CUSTOM_DOMAIN;
    else process.env.R2_CUSTOM_DOMAIN = originalR2CustomDomain;
  });

  it("loads a trusted R2 URL through authenticated storage helpers", async () => {
    const sourceUrl =
      "https://media.asset-insight.example/uploads/asset/front.png?version=2";
    const objectKey = "uploads/asset/front.png";
    const png = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    })
      .png()
      .toBuffer();
    r2Storage.headR2Object.mockResolvedValue({
      size: png.length,
      contentType: "image/png",
    });
    r2Storage.readR2ObjectBuffer.mockResolvedValue(png);

    const photo = await loadAuctioneerPhoto(sourceUrl, 1, 2);

    expect(r2Storage.resolveR2ObjectLocationFromUrl).toHaveBeenCalledWith(sourceUrl);
    expect(r2Storage.headR2Object).toHaveBeenCalledWith(
      "asset-insight-test",
      objectKey
    );
    expect(r2Storage.readR2ObjectBuffer).toHaveBeenCalledWith(
      "asset-insight-test",
      objectKey
    );
    expect(photo).toEqual({
      buffer: png,
      contentType: "image/png",
      filename: "lot-002-photo-003.png",
      sourceUrl,
    });
  });

  it("reads legacy report photos from the legacy bucket", async () => {
    const sourceUrl = "https://images.sellsnap.store/uploads/asset/legacy.png";
    const objectKey = "uploads/asset/legacy.png";
    const png = await sharp({
      create: {
        width: 2,
        height: 2,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    })
      .png()
      .toBuffer();
    r2Storage.headR2Object.mockResolvedValue({
      size: png.length,
      contentType: "image/png",
    });
    r2Storage.readR2ObjectBuffer.mockResolvedValue(png);

    await loadAuctioneerPhoto(sourceUrl, 0, 0);

    expect(r2Storage.headR2Object).toHaveBeenCalledWith("sellsnap", objectKey);
    expect(r2Storage.readR2ObjectBuffer).toHaveBeenCalledWith("sellsnap", objectKey);
  });

  it("rejects an untrusted photo host before reading storage", async () => {
    await expect(
      loadAuctioneerPhoto("https://untrusted.example/front.jpg", 0, 0)
    ).rejects.toThrow(
      "Report photo storage host is not trusted: untrusted.example"
    );

    expect(r2Storage.resolveR2ObjectLocationFromUrl).toHaveBeenCalledOnce();
    expect(r2Storage.headR2Object).not.toHaveBeenCalled();
    expect(r2Storage.readR2ObjectBuffer).not.toHaveBeenCalled();
  });

  /*
     Owner, 2026-11-19 (contract 825853): Auctioneer 2.0 judges a photo by its
     bytes and refused one sent under its storage label, stopping the delivery
     as "status 400". The label sent now always comes from the bytes. (This
     test used to expect PNG bytes stored as HEIC to be re-encoded as JPEG; the
     bytes are a PNG Auctioneer takes, so they now go as that PNG.)
  */
  it("labels a photo by its bytes, not its storage label: PNG bytes stored as HEIC go as PNG", async () => {
    const sourceUrl =
      "https://media.asset-insight.example/uploads/asset/camera.heic";
    const sourceBytes = await sharp({
      create: { width: 3, height: 2, channels: 3, background: { r: 180, g: 90, b: 30 } },
    })
      .png()
      .toBuffer();
    r2Storage.headR2Object.mockResolvedValue({ size: sourceBytes.length, contentType: "image/heic" });
    r2Storage.readR2ObjectBuffer.mockResolvedValue(sourceBytes);

    const photo = await loadAuctioneerPhoto(sourceUrl, 0, 0);

    expect(photo.contentType).toBe("image/png");
    expect(photo.filename).toBe("lot-001-photo-001.png");
    expect(photo.buffer.equals(sourceBytes)).toBe(true);
  });

  it("sends JPEG bytes stored under a PNG label as JPEG, the mismatch Auctioneer refused", async () => {
    const sourceUrl = "https://media.asset-insight.example/uploads/asset/front.png";
    const jpeg = await sharp({
      create: { width: 4, height: 3, channels: 3, background: { r: 10, g: 120, b: 200 } },
    })
      .jpeg()
      .toBuffer();
    r2Storage.headR2Object.mockResolvedValue({ size: jpeg.length, contentType: "image/png" });
    r2Storage.readR2ObjectBuffer.mockResolvedValue(jpeg);

    const photo = await loadAuctioneerPhoto(sourceUrl, 0, 4);

    expect(photo.contentType).toBe("image/jpeg");
    expect(photo.filename).toBe("lot-001-photo-005.jpg");
    expect(photo.buffer.equals(jpeg)).toBe(true);
  });

  it("converts a format Auctioneer does not take (TIFF) to JPEG, whatever its label", async () => {
    const sourceUrl = "https://media.asset-insight.example/uploads/asset/scan.jpg";
    const tiff = await sharp({
      create: { width: 3, height: 3, channels: 3, background: { r: 200, g: 200, b: 10 } },
    })
      .tiff()
      .toBuffer();
    r2Storage.headR2Object.mockResolvedValue({ size: tiff.length, contentType: "image/jpeg" });
    r2Storage.readR2ObjectBuffer.mockResolvedValue(tiff);

    const photo = await loadAuctioneerPhoto(sourceUrl, 0, 0);

    expect(photo.contentType).toBe("image/jpeg");
    expect(photo.filename).toBe("lot-001-photo-001.jpg");
    expect((await sharp(photo.buffer).metadata()).format).toBe("jpeg");
  });

  it("names the photo and its format when it cannot be converted either", async () => {
    const sourceUrl = "https://media.asset-insight.example/uploads/asset/iphone.jpg";
    // An iPhone HEIC header with no decodable picture behind it.
    const heic = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from("ftypheic", "ascii"),
      Buffer.alloc(64, 7),
    ]);
    r2Storage.headR2Object.mockResolvedValue({ size: heic.length, contentType: "image/jpeg" });
    r2Storage.readR2ObjectBuffer.mockResolvedValue(heic);

    const error = await loadAuctioneerPhoto(sourceUrl, 0, 2).catch(value => value);

    expect(error).toBeInstanceOf(AuctioneerDeliveryError);
    expect(error.message).toContain("A report photo (photo 3) is a HEIC (iPhone) file");
    expect(error.message).toContain("Replace that photo in the report");
  });
});
