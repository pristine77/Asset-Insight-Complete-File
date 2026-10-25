import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  assertValidR2StorageConfiguration,
  createR2PresignedPutUrl,
  deleteFromR2Strict,
  getCurrentR2StorageTarget,
  getLegacyR2StorageTarget,
  getR2PublicUrl,
  isCurrentR2StorageTarget,
  resolveCurrentR2ObjectLocationFromUrl,
  resolvePersistedR2StorageTarget,
  resolveR2ObjectLocationFromUrl,
  uploadBufferToR2,
  validateR2ObjectKeyForRead,
} from "../src/utils/r2Storage/r2Upload.js";

const envNames = [
  "R2_BUCKET_NAME",
  "R2_BUCKET",
  "R2_PUBLIC_URL",
  "R2_CUSTOM_DOMAIN",
  "R2_LEGACY_BUCKET_NAME",
  "R2_LEGACY_PUBLIC_URL",
] as const;

const originalEnvironment = Object.fromEntries(
  envNames.map((name) => [name, process.env[name]])
);

beforeEach(() => {
  process.env.R2_BUCKET_NAME = "asset-insight";
  delete process.env.R2_BUCKET;
  process.env.R2_PUBLIC_URL = "https://assetinsight.pro";
  delete process.env.R2_CUSTOM_DOMAIN;
  process.env.R2_LEGACY_BUCKET_NAME = "sellsnap";
  process.env.R2_LEGACY_PUBLIC_URL = "https://images.sellsnap.store";
});

afterAll(() => {
  for (const name of envNames) {
    const value = originalEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("R2 storage generation routing", () => {
  it("builds all new public URLs on the active custom domain", () => {
    expect(getCurrentR2StorageTarget()).toEqual({
      bucketName: "asset-insight",
      publicBaseUrl: "https://assetinsight.pro",
      generation: "current",
    });
    expect(getR2PublicUrl("uploads/asset/photo 1.jpg")).toBe(
      "https://assetinsight.pro/uploads/asset/photo%201.jpg"
    );
  });

  it("round-trips URL delimiter characters without changing the object key", () => {
    const key = "uploads/report-sessions/asset/file ?#% name.jpg";
    const publicUrl = getR2PublicUrl(key);

    expect(publicUrl).toBe(
      "https://assetinsight.pro/uploads/report-sessions/asset/file%20%3F%23%25%20name.jpg"
    );
    expect(resolveR2ObjectLocationFromUrl(publicUrl)).toMatchObject({
      bucketName: "asset-insight",
      generation: "current",
      key,
    });
  });

  it("rejects noncanonical keys before publishing or signing them", async () => {
    expect(() => getR2PublicUrl("/uploads/asset/photo.jpg")).toThrow(
      /canonical relative path/i
    );
    await expect(
      createR2PresignedPutUrl(
        "asset-insight",
        "/uploads/asset/photo.jpg",
        "image/jpeg"
      )
    ).rejects.toThrow(/canonical relative path/i);
    await expect(
      uploadBufferToR2(
        Buffer.from("must-not-upload"),
        "image/jpeg",
        "asset-insight",
        "/uploads/asset/photo.jpg"
      )
    ).rejects.toThrow(/canonical relative path/i);
  });

  it("recognizes current and legacy owned URLs without accepting foreign hosts", () => {
    expect(
      resolveR2ObjectLocationFromUrl(
        "https://assetinsight.pro/uploads/asset/photo.jpg?v=2"
      )
    ).toMatchObject({
      bucketName: "asset-insight",
      generation: "current",
      key: "uploads/asset/photo.jpg",
    });
    expect(
      resolveR2ObjectLocationFromUrl(
        "https://images.sellsnap.store/uploads/asset/photo.jpg"
      )
    ).toMatchObject({
      bucketName: "sellsnap",
      generation: "legacy",
      key: "uploads/asset/photo.jpg",
    });
    expect(resolveR2ObjectLocationFromUrl("https://example.com/uploads/asset/photo.jpg")).toBeNull();
    expect(resolveR2ObjectLocationFromUrl("http://assetinsight.pro/uploads/asset/photo.jpg")).toBeNull();
    expect(resolveR2ObjectLocationFromUrl("https://assetinsight.pro/uploads/../secret")).toBeNull();
  });

  it("allows destructive resolution only for the active generation", () => {
    expect(
      resolveCurrentR2ObjectLocationFromUrl(
        "https://assetinsight.pro/uploads/lot-listing/photo.jpg"
      )
    ).toMatchObject({ bucketName: "asset-insight", key: "uploads/lot-listing/photo.jpg" });
    expect(
      resolveCurrentR2ObjectLocationFromUrl(
        "https://images.sellsnap.store/uploads/lot-listing/photo.jpg"
      )
    ).toBeNull();
  });

  it("treats metadata-free persisted records as legacy and snapshots as current", () => {
    expect(resolvePersistedR2StorageTarget()).toEqual(getLegacyR2StorageTarget());
    expect(
      resolvePersistedR2StorageTarget({
        r2Bucket: "sellsnap",
        r2PublicBaseUrl: "https://images.sellsnap.store",
      })
    ).toEqual(getLegacyR2StorageTarget());
    const current = resolvePersistedR2StorageTarget({
      r2Bucket: "asset-insight",
      r2PublicBaseUrl: "https://assetinsight.pro",
    });
    expect(current).toEqual(getCurrentR2StorageTarget());
    expect(isCurrentR2StorageTarget(current)).toBe(true);
    expect(isCurrentR2StorageTarget(getLegacyR2StorageTarget())).toBe(false);
  });

  it("fails closed when non-empty persisted storage metadata is unknown or mismatched", () => {
    expect(() =>
      resolvePersistedR2StorageTarget({
        r2Bucket: "unexpected-bucket",
        r2PublicBaseUrl: "https://assetinsight.pro",
      })
    ).toThrow(/not an allowed storage generation/i);
    expect(() =>
      resolvePersistedR2StorageTarget({
        r2Bucket: "asset-insight",
        r2PublicBaseUrl: "https://images.sellsnap.store",
      })
    ).toThrow(/not an allowed storage generation/i);
  });

  it("rejects partial cutovers and overlapping current/legacy namespaces", () => {
    delete process.env.R2_BUCKET_NAME;
    process.env.R2_BUCKET = "asset-insight";
    expect(() => assertValidR2StorageConfiguration()).toThrow(
      /R2_BUCKET_NAME is required/i
    );

    process.env.R2_BUCKET_NAME = "asset-insight";
    delete process.env.R2_BUCKET;
    delete process.env.R2_PUBLIC_URL;
    process.env.R2_CUSTOM_DOMAIN = "https://assetinsight.pro";
    expect(() => assertValidR2StorageConfiguration()).toThrow(
      /R2_PUBLIC_URL is required/i
    );

    process.env.R2_PUBLIC_URL = "https://assetinsight.pro";
    delete process.env.R2_CUSTOM_DOMAIN;
    delete process.env.R2_LEGACY_BUCKET_NAME;
    expect(() => assertValidR2StorageConfiguration()).toThrow(
      /R2_LEGACY_BUCKET_NAME is required/i
    );

    process.env.R2_LEGACY_BUCKET_NAME = "sellsnap";
    delete process.env.R2_LEGACY_PUBLIC_URL;
    expect(() => assertValidR2StorageConfiguration()).toThrow(
      /R2_LEGACY_PUBLIC_URL is required/i
    );

    process.env.R2_LEGACY_PUBLIC_URL = "https://images.sellsnap.store";
    process.env.R2_BUCKET_NAME = "sellsnap";
    expect(() => assertValidR2StorageConfiguration()).toThrow(
      /buckets must be different/i
    );

    process.env.R2_BUCKET_NAME = "asset-insight";
    process.env.R2_PUBLIC_URL = "https://images.sellsnap.store";
    expect(() => assertValidR2StorageConfiguration()).toThrow(
      /namespaces must not overlap/i
    );

    process.env.R2_PUBLIC_URL = "https://assetinsight.pro";
    process.env.R2_CUSTOM_DOMAIN = "https://images.sellsnap.store";
    expect(() => assertValidR2StorageConfiguration()).toThrow(
      /conflict.*stale alias/i
    );

    delete process.env.R2_CUSTOM_DOMAIN;
    process.env.R2_LEGACY_PUBLIC_URL = "https://assetinsight.pro/legacy";
    expect(() => assertValidR2StorageConfiguration()).toThrow(
      /namespaces must not overlap/i
    );

    process.env.R2_BUCKET_NAME = "sellsnap";
    process.env.R2_PUBLIC_URL = "https://images.sellsnap.store";
    process.env.R2_LEGACY_BUCKET_NAME = "asset-insight";
    process.env.R2_LEGACY_PUBLIC_URL = "https://assetinsight.pro";
    expect(() => assertValidR2StorageConfiguration()).toThrow(
      /sellsnap.*permanently legacy/i
    );

    process.env.R2_BUCKET_NAME = "asset-insight";
    process.env.R2_PUBLIC_URL = "https://images.sellsnap.store.";
    process.env.R2_LEGACY_BUCKET_NAME = "legacy-fixture";
    process.env.R2_LEGACY_PUBLIC_URL = "https://legacy.example.test";
    expect(() => assertValidR2StorageConfiguration()).toThrow(
      /images\.sellsnap\.store.*permanently legacy/i
    );
  });

  it("hard-blocks every legacy or unknown write target", async () => {
    await expect(
      createR2PresignedPutUrl("sellsnap", "uploads/new.jpg", "image/jpeg")
    ).rejects.toThrow(/legacy.*read-only/i);
    await expect(
      uploadBufferToR2(
        Buffer.from("must-not-upload"),
        "image/jpeg",
        "sellsnap",
        "uploads/new.jpg"
      )
    ).rejects.toThrow(/legacy.*read-only/i);
    await expect(
      uploadBufferToR2(
        Buffer.from("must-not-upload"),
        "image/jpeg",
        "unexpected-bucket",
        "uploads/new.jpg"
      )
    ).rejects.toThrow(/only in the active current bucket/i);

    await expect(
      deleteFromR2Strict("sellsnap", "uploads/existing.jpg")
    ).resolves.toBeUndefined();
    await expect(
      deleteFromR2Strict("unexpected-bucket", "uploads/existing.jpg")
    ).rejects.toThrow(/only in the active current bucket/i);
  });

  it("protects sellsnap even when a different fixture is configured as legacy", async () => {
    process.env.R2_LEGACY_BUCKET_NAME = "legacy-fixture";
    process.env.R2_LEGACY_PUBLIC_URL = "https://legacy.example.test";

    await expect(
      createR2PresignedPutUrl("sellsnap", "uploads/new.jpg", "image/jpeg")
    ).rejects.toThrow(/immutable legacy.*read-only/i);
    await expect(
      uploadBufferToR2(
        Buffer.from("must-not-upload"),
        "image/jpeg",
        "sellsnap",
        "uploads/new.jpg"
      )
    ).rejects.toThrow(/immutable legacy.*read-only/i);
    await expect(
      deleteFromR2Strict("sellsnap", "uploads/existing.jpg")
    ).resolves.toBeUndefined();
  });

  it("reads exact historical legacy keys while rejecting them for current mutations", async () => {
    const historicalKeys = [
      {
        key: "uploads/report-sessions/legacy\\photo.jpg",
        publicUrl:
          "https://images.sellsnap.store/uploads/report-sessions/legacy\\photo.jpg",
      },
      {
        key: "uploads/report-sessions//photo.jpg",
        publicUrl:
          "https://images.sellsnap.store/uploads/report-sessions//photo.jpg",
      },
      {
        key: "uploads/report-sessions/../photo.jpg",
        publicUrl:
          "https://images.sellsnap.store/uploads/report-sessions/../photo.jpg",
      },
    ];

    for (const { key, publicUrl } of historicalKeys) {
      expect(validateR2ObjectKeyForRead("sellsnap", key)).toBe(key);
      expect(getR2PublicUrl(key, getLegacyR2StorageTarget())).toBe(publicUrl);
      expect(() => validateR2ObjectKeyForRead("asset-insight", key)).toThrow(
        /canonical relative path/i
      );
      expect(() => getR2PublicUrl(key, getCurrentR2StorageTarget())).toThrow(
        /canonical relative path/i
      );
      await expect(
        createR2PresignedPutUrl("asset-insight", key, "image/jpeg")
      ).rejects.toThrow(/canonical relative path/i);
      await expect(
        uploadBufferToR2(
          Buffer.from("must-not-upload"),
          "image/jpeg",
          "asset-insight",
          key
        )
      ).rejects.toThrow(/canonical relative path/i);
      await expect(deleteFromR2Strict("asset-insight", key)).rejects.toThrow(
        /canonical relative path/i
      );
      await expect(deleteFromR2Strict("sellsnap", key)).resolves.toBeUndefined();
    }

    expect(() =>
      getR2PublicUrl(historicalKeys[0].key, {
        ...getCurrentR2StorageTarget(),
        generation: "legacy",
      })
    ).toThrow(/generation does not match/i);
  });
});
