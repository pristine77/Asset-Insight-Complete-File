import { describe, expect, it } from "vitest";
import {
  draftMediaClientValue,
  mergeDraftMediaManifest,
  normalizeDraftMediaManifest,
  sortDraftMedia,
} from "../src/service/reportDraftMediaService.js";
import {
  getCurrentR2StorageTarget,
  getLegacyR2StorageTarget,
} from "../src/utils/r2Storage/r2Upload.js";

const media = (
  clientFileId: string,
  lotId: string,
  slot: "main" | "extra" | "video",
  index: number,
  originalOrder: number
) => ({
  clientFileId,
  localKey: clientFileId,
  mediaId: clientFileId,
  lotId,
  slot,
  index,
  captureOrder: index,
  originalOrder,
  name: `${clientFileId}.jpg`,
  mimeType: "image/jpeg",
  size: 1_024,
  lastModified: 1_700_000_000_000 + originalOrder,
});

describe("report draft media manifests", () => {
  it("restores photos in canonical capture order without crossing adjacent lots", () => {
    const manifest = normalizeDraftMediaManifest([
      media("1013-main-2", "lot-1013", "main", 1, 3),
      media("1012-main-1", "lot-1012", "main", 0, 0),
      media("1014-extra-1", "lot-1014", "extra", 0, 6),
      media("1013-main-1", "lot-1013", "main", 0, 2),
      media("1012-main-2", "lot-1012", "main", 1, 1),
      media("1014-main-2", "lot-1014", "main", 1, 5),
      media("1014-main-1", "lot-1014", "main", 0, 4),
    ]);

    const ordered = sortDraftMedia(manifest);
    expect(ordered.map((item) => item.clientFileId)).toEqual([
      "1012-main-1",
      "1012-main-2",
      "1013-main-1",
      "1013-main-2",
      "1014-main-1",
      "1014-main-2",
      "1014-extra-1",
    ]);
    expect(
      ordered.filter((item) => item.lotId === "lot-1013").map((item) => item.clientFileId)
    ).toEqual(["1013-main-1", "1013-main-2"]);
  });

  it("keeps stored R2 identity while allowing a photo to move within the draft", () => {
    const currentStorage = getCurrentR2StorageTarget();
    const existing = [
      {
        ...media("stable-photo", "lot-1012", "main", 0, 0),
        r2Key: "report-drafts/user/draft/stable-photo.jpg",
        r2Bucket: currentStorage.bucketName,
        r2PublicBaseUrl: currentStorage.publicBaseUrl,
        uploadedAt: new Date("2026-08-10T12:00:00.000Z"),
        verifiedSize: 1_024,
      },
    ];
    const incoming = normalizeDraftMediaManifest([
      media("stable-photo", "lot-1014", "extra", 2, 8),
    ]);

    const [merged] = mergeDraftMediaManifest(incoming, existing);
    expect(merged).toMatchObject({
      clientFileId: "stable-photo",
      lotId: "lot-1014",
      slot: "extra",
      index: 2,
      originalOrder: 8,
      r2Key: "report-drafts/user/draft/stable-photo.jpg",
      r2Bucket: currentStorage.bucketName,
      r2PublicBaseUrl: currentStorage.publicBaseUrl,
      verifiedSize: 1_024,
    });
    expect(merged.uploadedAt?.toISOString()).toBe("2026-08-10T12:00:00.000Z");
  });

  it("serializes mixed-generation media with each item's persisted public origin", () => {
    const currentStorage = getCurrentR2StorageTarget();
    const legacyStorage = getLegacyR2StorageTarget();
    const sharedKey = "report-drafts/user/draft/shared-photo.jpg";
    const uploadedAt = new Date("2026-08-10T12:00:00.000Z");

    const legacy = draftMediaClientValue({
      ...media("legacy-photo", "lot-1", "main", 0, 0),
      r2Key: sharedKey,
      uploadedAt,
    });
    const current = draftMediaClientValue({
      ...media("current-photo", "lot-2", "main", 0, 1),
      r2Key: sharedKey,
      r2Bucket: currentStorage.bucketName,
      r2PublicBaseUrl: currentStorage.publicBaseUrl,
      uploadedAt,
    });

    expect(legacy.url).toBe(`${legacyStorage.publicBaseUrl}/${sharedKey}`);
    expect(current.url).toBe(`${currentStorage.publicBaseUrl}/${sharedKey}`);
    expect(current.url).not.toBe(legacy.url);
  });

  it("rejects duplicate stable media ids instead of silently overwriting a photo", () => {
    expect(() =>
      normalizeDraftMediaManifest([
        media("duplicate", "lot-1", "main", 0, 0),
        media("duplicate", "lot-2", "main", 0, 1),
      ])
    ).toThrow("unique clientFileId");
  });
});
