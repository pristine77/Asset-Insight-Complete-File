import { describe, expect, it } from "vitest";
import {
  buildPreviewImageObjectKey,
  normalizePreviewLotKey,
} from "../src/utils/previewLotImageUpload.js";

describe("preview lot image object identity", () => {
  const bytes = Buffer.from("same-image-bytes");

  it("treats common UI lot labels as the same stable lot identity", () => {
    expect([
      "4",
      "Lot 4",
      "Lot #4",
      "lot-4",
      "lot_4",
      "lot:4",
      "# 4",
    ].map(normalizePreviewLotKey)).toEqual(Array(7).fill("4"));
  });

  it("reuses one content-addressed key for an identical report-lot retry", () => {
    const input = {
      kind: "asset" as const,
      reportId: "66c000000000000000000001",
      lotKey: "Lot # 8",
      buffer: bytes,
      extension: ".JPG",
      watermarkImages: true,
    };

    const first = buildPreviewImageObjectKey(input);
    const retry = buildPreviewImageObjectKey({ ...input, lotKey: "8" });

    expect(retry).toBe(first);
    expect(first).toMatch(
      /^uploads\/asset\/preview-additions\/[a-f0-9]{24}\/[a-f0-9]{64}\.img$/
    );
  });

  it("does not let a renamed extension create a second object identity", () => {
    const base = {
      kind: "asset" as const,
      reportId: "66c000000000000000000001",
      lotKey: "8",
      buffer: bytes,
      watermarkImages: false,
    };

    expect(buildPreviewImageObjectKey({ ...base, extension: ".jpg" })).toBe(
      buildPreviewImageObjectKey({ ...base, extension: ".png" })
    );
  });

  it("uses the actual image bytes for a canonical public suffix", () => {
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const key = buildPreviewImageObjectKey({
      kind: "asset",
      reportId: "66c000000000000000000001",
      lotKey: "8",
      buffer: jpegBytes,
      extension: ".png",
      watermarkImages: false,
    });

    expect(key).toMatch(/\.jpg$/);
  });

  it("does not share an object lifecycle across reports, lots, or watermark policies", () => {
    const base = {
      kind: "lot-listing" as const,
      reportId: "66c000000000000000000001",
      lotKey: "4",
      buffer: bytes,
      extension: ".png",
      watermarkImages: true,
    };

    const keys = new Set([
      buildPreviewImageObjectKey(base),
      buildPreviewImageObjectKey({ ...base, reportId: "66c000000000000000000002" }),
      buildPreviewImageObjectKey({ ...base, lotKey: "9" }),
      buildPreviewImageObjectKey({ ...base, watermarkImages: false }),
    ]);

    expect(keys.size).toBe(4);
  });

  it("rejects an unscoped upload instead of risking a cross-report collision", () => {
    expect(() =>
      buildPreviewImageObjectKey({
        kind: "asset",
        reportId: "",
        lotKey: "1",
        buffer: bytes,
        extension: ".jpg",
        watermarkImages: false,
      })
    ).toThrow("Report identity is required");
  });
});
