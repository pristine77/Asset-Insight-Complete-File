import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const r2Storage = vi.hoisted(() => ({
  headR2Object: vi.fn(),
  readR2ObjectBuffer: vi.fn(),
  resolveR2ObjectLocationFromUrl: vi.fn(),
}));

vi.mock("../src/utils/r2Storage/r2Upload.js", () => r2Storage);

import { loadAuctioneerPhoto } from "../src/service/auctioneer2PhotoService.js";
import { AuctioneerDeliveryError } from "../src/service/auctioneer2DeliveryError.js";

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

  it("transcodes an unsupported HEIC-declared image to JPEG with a .jpg name", async () => {
    const sourceUrl =
      "https://media.asset-insight.example/uploads/asset/camera.heic";
    const objectKey = "uploads/asset/camera.heic";
    // A decodable image body isolates the outbound-format policy from HEIC codec
    // availability: the unsupported declared type must still take the JPEG path.
    const sourceBytes = await sharp({
      create: {
        width: 3,
        height: 2,
        channels: 3,
        background: { r: 180, g: 90, b: 30 },
      },
    })
      .png()
      .toBuffer();
    r2Storage.headR2Object.mockResolvedValue({
      size: sourceBytes.length,
      contentType: "image/heic",
    });
    r2Storage.readR2ObjectBuffer.mockResolvedValue(sourceBytes);

    const photo = await loadAuctioneerPhoto(sourceUrl, 0, 0);
    const outputMetadata = await sharp(photo.buffer).metadata();

    expect(photo.contentType).toBe("image/jpeg");
    expect(photo.filename).toBe("lot-001-photo-001.jpg");
    expect(photo.buffer.equals(sourceBytes)).toBe(false);
    expect(outputMetadata.format).toBe("jpeg");
  });
});
