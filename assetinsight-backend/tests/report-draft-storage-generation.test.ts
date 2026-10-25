import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const r2Mocks = vi.hoisted(() => ({
  createPresignedPutUrl: vi.fn(),
  deleteFromR2: vi.fn(),
  headR2Object: vi.fn(),
}));

vi.mock("../src/utils/r2Storage/r2Upload.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../src/utils/r2Storage/r2Upload.js")
  >();
  return {
    ...actual,
    createR2PresignedPutUrl: r2Mocks.createPresignedPutUrl,
    deleteFromR2: r2Mocks.deleteFromR2,
    headR2Object: r2Mocks.headR2Object,
  };
});

import {
  confirmDraftMedia,
  createDraftMediaTargets,
  deleteDraftMediaObjects,
} from "../src/service/reportDraftMediaService.js";

const originalStorageEnvironment = {
  R2_BUCKET_NAME: process.env.R2_BUCKET_NAME,
  R2_PUBLIC_URL: process.env.R2_PUBLIC_URL,
  R2_LEGACY_BUCKET_NAME: process.env.R2_LEGACY_BUCKET_NAME,
  R2_LEGACY_PUBLIC_URL: process.env.R2_LEGACY_PUBLIC_URL,
};

const manifestItem = (clientFileId: string, originalOrder: number) => ({
  clientFileId,
  localKey: clientFileId,
  mediaId: clientFileId,
  lotId: `lot-${originalOrder + 1}`,
  slot: "main",
  index: 0,
  captureOrder: 0,
  originalOrder,
  name: `${clientFileId}.jpg`,
  mimeType: "image/jpeg",
  size: 1_024,
  lastModified: 1_700_000_000_000 + originalOrder,
});

const draftValue = (media: any[]) => ({
  _id: "draft-storage-generation",
  user: "draft-owner",
  media,
  storageMode: "r2_media",
  save: vi.fn().mockResolvedValue(undefined),
});

beforeEach(() => {
  process.env.R2_BUCKET_NAME = "asset-insight-test";
  process.env.R2_PUBLIC_URL = "https://assetinsight.test";
  process.env.R2_LEGACY_BUCKET_NAME = "sellsnap-test";
  process.env.R2_LEGACY_PUBLIC_URL = "https://images.sellsnap.test";
  r2Mocks.createPresignedPutUrl.mockReset();
  r2Mocks.deleteFromR2.mockReset();
  r2Mocks.headR2Object.mockReset();
  r2Mocks.createPresignedPutUrl.mockResolvedValue(
    "https://upload.example.test/presigned"
  );
  r2Mocks.deleteFromR2.mockResolvedValue(undefined);
  r2Mocks.headR2Object.mockResolvedValue({ size: 1_024 });
});

afterAll(() => {
  for (const [name, value] of Object.entries(originalStorageEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("report draft storage generations", () => {
  it("allocates current storage for an existing manifest row without a durable R2 key", async () => {
    const item = manifestItem("new-after-cutover", 0);
    const draft = draftValue([item]);

    const [target] = await createDraftMediaTargets(draft, [item]);

    expect(target).toMatchObject({
      clientFileId: "new-after-cutover",
      r2Bucket: "asset-insight-test",
      r2PublicBaseUrl: "https://assetinsight.test",
      alreadyUploaded: false,
    });
    expect(draft.media[0]).toMatchObject({
      r2Bucket: "asset-insight-test",
      r2PublicBaseUrl: "https://assetinsight.test",
    });
    expect(r2Mocks.headR2Object).not.toHaveBeenCalled();
    expect(draft.save).toHaveBeenCalledTimes(1);
  });

  it("HEAD-checks and serializes mixed legacy/current media against their stored targets", async () => {
    const sharedKey = "report-drafts/shared/photo.jpg";
    const uploadedAt = new Date("2026-08-10T12:00:00.000Z");
    const legacy = {
      ...manifestItem("legacy-photo", 0),
      r2Key: sharedKey,
      uploadedAt,
    };
    const current = {
      ...manifestItem("current-photo", 1),
      r2Key: sharedKey,
      r2Bucket: "asset-insight-test",
      r2PublicBaseUrl: "https://assetinsight.test",
      uploadedAt,
    };
    const draft = draftValue([legacy, current]);

    const targets = await createDraftMediaTargets(draft, [legacy, current]);

    expect(r2Mocks.headR2Object).toHaveBeenCalledWith(
      "sellsnap-test",
      sharedKey
    );
    expect(r2Mocks.headR2Object).toHaveBeenCalledWith(
      "asset-insight-test",
      sharedKey
    );
    expect(targets).toEqual([
      expect.objectContaining({
        clientFileId: "legacy-photo",
        r2Bucket: "sellsnap-test",
        url: `https://images.sellsnap.test/${sharedKey}`,
        alreadyUploaded: true,
      }),
      expect.objectContaining({
        clientFileId: "current-photo",
        r2Bucket: "asset-insight-test",
        url: `https://assetinsight.test/${sharedKey}`,
        alreadyUploaded: true,
      }),
    ]);
  });

  it("rotates a missing or mismatched legacy object to current storage", async () => {
    const legacyKey = "report-drafts/legacy/mismatched.jpg";
    const item = {
      ...manifestItem("legacy-mismatch", 0),
      r2Key: legacyKey,
      uploadedAt: new Date("2026-08-10T12:00:00.000Z"),
    };
    const draft = draftValue([item]);
    r2Mocks.headR2Object.mockResolvedValueOnce({ size: 12 });

    const [target] = await createDraftMediaTargets(draft, [item]);

    expect(r2Mocks.headR2Object).toHaveBeenCalledWith("sellsnap-test", legacyKey);
    expect(target).toMatchObject({
      r2Bucket: "asset-insight-test",
      r2PublicBaseUrl: "https://assetinsight.test",
      alreadyUploaded: false,
    });
    expect(draft.media[0]).toMatchObject({
      r2Bucket: "asset-insight-test",
      r2PublicBaseUrl: "https://assetinsight.test",
    });
  });

  it("rotates a definitively missing legacy object to current storage", async () => {
    const legacyKey = "report-drafts/legacy/missing.jpg";
    const item = {
      ...manifestItem("legacy-missing", 0),
      r2Key: legacyKey,
      uploadedAt: new Date("2026-08-10T12:00:00.000Z"),
    };
    const draft = draftValue([item]);
    r2Mocks.headR2Object.mockRejectedValueOnce(
      Object.assign(new Error("not found"), {
        name: "NoSuchKey",
        $metadata: { httpStatusCode: 404 },
      })
    );

    const [target] = await createDraftMediaTargets(draft, [item]);

    expect(target).toMatchObject({
      r2Bucket: "asset-insight-test",
      r2PublicBaseUrl: "https://assetinsight.test",
      alreadyUploaded: false,
    });
    expect(draft.media[0]).toMatchObject({
      r2Bucket: "asset-insight-test",
      r2PublicBaseUrl: "https://assetinsight.test",
    });
  });

  it("rotates a missing current object to a fresh immutable key", async () => {
    const currentKey = "report-drafts/current/missing.jpg";
    const item = {
      ...manifestItem("current-missing", 0),
      r2Key: currentKey,
      r2Bucket: "asset-insight-test",
      r2PublicBaseUrl: "https://assetinsight.test",
      uploadedAt: new Date("2026-08-10T12:00:00.000Z"),
    };
    const draft = draftValue([item]);
    r2Mocks.headR2Object.mockRejectedValueOnce(
      Object.assign(new Error("not found"), {
        name: "NoSuchKey",
        $metadata: { httpStatusCode: 404 },
      }),
    );

    const [target] = await createDraftMediaTargets(draft, [item]);

    expect(target.r2Key).not.toBe(currentKey);
    expect(target.r2Key).toMatch(/^report-drafts\//);
    expect(target).toMatchObject({
      r2Bucket: "asset-insight-test",
      r2PublicBaseUrl: "https://assetinsight.test",
      alreadyUploaded: false,
    });
  });

  it("keeps legacy draft metadata intact when HEAD fails transiently", async () => {
    const legacyKey = "report-drafts/legacy/unavailable.jpg";
    const item = {
      ...manifestItem("legacy-unavailable", 0),
      r2Key: legacyKey,
      uploadedAt: new Date("2026-08-10T12:00:00.000Z"),
    };
    const draft = draftValue([item]);
    r2Mocks.headR2Object.mockRejectedValueOnce(
      Object.assign(new Error("storage unavailable"), {
        $metadata: { httpStatusCode: 503 },
      })
    );

    await expect(createDraftMediaTargets(draft, [item])).rejects.toThrow(
      /storage unavailable/i
    );
    expect(draft.save).not.toHaveBeenCalled();
    expect(draft.media[0]).toMatchObject({
      r2Key: legacyKey,
      uploadedAt: item.uploadedAt,
    });
    expect(draft.media[0]).not.toHaveProperty("r2Bucket");
  });

  it("confirms each mixed-generation media item in its own bucket", async () => {
    const sharedKey = "report-drafts/shared/confirm.jpg";
    const draft = draftValue([
      { ...manifestItem("legacy-photo", 0), r2Key: sharedKey },
      {
        ...manifestItem("current-photo", 1),
        r2Key: sharedKey,
        r2Bucket: "asset-insight-test",
        r2PublicBaseUrl: "https://assetinsight.test",
      },
    ]);

    const confirmed = await confirmDraftMedia(draft, [
      "legacy-photo",
      "current-photo",
    ]);

    expect(r2Mocks.headR2Object.mock.calls).toEqual(
      expect.arrayContaining([
        ["sellsnap-test", sharedKey],
        ["asset-insight-test", sharedKey],
      ])
    );
    expect(confirmed.map((item) => item.url)).toEqual([
      `https://images.sellsnap.test/${sharedKey}`,
      `https://assetinsight.test/${sharedKey}`,
    ]);
  });

  it("physically deletes only current media even when legacy and current share a key", async () => {
    const sharedKey = "report-drafts/shared/delete.jpg";

    await deleteDraftMediaObjects([
      { r2Key: sharedKey },
      {
        r2Key: sharedKey,
        r2Bucket: "asset-insight-test",
        r2PublicBaseUrl: "https://assetinsight.test",
      },
    ]);

    expect(r2Mocks.deleteFromR2).toHaveBeenCalledTimes(1);
    expect(r2Mocks.deleteFromR2).toHaveBeenCalledWith(
      "asset-insight-test",
      sharedKey
    );
  });
});
