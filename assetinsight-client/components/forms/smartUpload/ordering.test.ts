import { File as NodeFile } from "node:buffer";
import { describe, expect, it } from "vitest";
import { resolveSmartUploadFileOrder } from "./ordering";

Object.defineProperty(globalThis, "File", {
  configurable: true,
  value: NodeFile,
});

function image(name: string, lastModified: number) {
  return new File([name], name, {
    type: "image/jpeg",
    lastModified,
  });
}

describe("resolveSmartUploadFileOrder", () => {
  it("does not apply black-divider filename heuristics to lot-number photos", () => {
    const selected = [image("Black divider.jpg", 3000), image("photo-a.jpg", 1000), image("photo-b.jpg", 2000)];
    const resolved = resolveSmartUploadFileOrder(selected, { groupingMethod: "lot_number" });
    expect(resolved.diagnostic).toBe("file-timestamp-needs-review");
    expect(resolved.files.map((file) => file.name)).toEqual(["photo-a.jpg", "photo-b.jpg", "Black divider.jpg"]);
    expect(resolved.ambiguous).toBe(true);
  });
  it("preserves an intentional non-filesystem sequence", () => {
    const selected = [
      image("IMG_0002.jpg", 2_000),
      image("divider.jpg", 1_000),
      image("IMG_0001.jpg", 3_000),
    ];

    const resolved = resolveSmartUploadFileOrder(selected);

    expect(resolved.files).toEqual(selected);
    expect(resolved.strategy).toBe("preserved-selection");
    expect(resolved.ambiguous).toBe(false);
    expect(resolved.changed).toBe(false);
  });

  it("suggests timestamp order but requires review", () => {
    const selected = [
      image("scan-a.jpg", 30_000),
      image("scan-b.jpg", 10_000),
      image("scan-c.jpg", 20_000),
    ];

    const resolved = resolveSmartUploadFileOrder(selected);

    expect(resolved.files.map((file) => file.name)).toEqual([
      "scan-b.jpg",
      "scan-c.jpg",
      "scan-a.jpg",
    ]);
    expect(resolved.strategy).toBe("file-timestamp");
    expect(resolved.diagnostic).toBe("file-timestamp-needs-review");
    expect(resolved.ambiguous).toBe(true);
    expect(resolved.changed).toBe(true);
  });

  it("uses stable natural filename order when file timestamps are tied", () => {
    const selected = [
      image("IMG_1.jpg", 10_000),
      image("IMG_10.jpg", 10_000),
      image("IMG_2.jpg", 10_000),
    ];

    const resolved = resolveSmartUploadFileOrder(selected);

    expect(resolved.files.map((file) => file.name)).toEqual([
      "IMG_1.jpg",
      "IMG_2.jpg",
      "IMG_10.jpg",
    ]);
    expect(resolved.strategy).toBe("natural-filename");
    expect(resolved.diagnostic).toBe("natural-filename-restored");
    expect(resolved.changed).toBe(true);
  });

  it("prefers an explicit numbered series over conflicting file timestamps", () => {
    const selected = [
      image("IMG_1.jpg", 30_000),
      image("IMG_2.jpg", 10_000),
      image("IMG_3.jpg", 20_000),
    ];

    const resolved = resolveSmartUploadFileOrder(selected);

    expect(resolved.files).toEqual(selected);
    expect(resolved.strategy).toBe("natural-filename");
    expect(resolved.diagnostic).toBe("natural-filename-restored");
    expect(resolved.ambiguous).toBe(false);
    expect(resolved.changed).toBe(false);
  });

  it("flags a likely divider whose position was erased by folder sorting", () => {
    const selected = [
      image("Black divider.jpg", 1_000),
      image("IMG_0001.jpg", 2_000),
      image("IMG_0002.jpg", 3_000),
      image("IMG_0003.jpg", 4_000),
      image("IMG_0004.jpg", 5_000),
      image("IMG_0005.jpg", 6_000),
      image("IMG_0006.jpg", 7_000),
    ];

    const resolved = resolveSmartUploadFileOrder(selected);

    expect(resolved.files).toEqual(selected);
    expect(resolved.diagnostic).toBe("divider-position-needs-review");
    expect(resolved.ambiguous).toBe(true);
    expect(resolved.changed).toBe(false);
  });

  it("suggests an in-sequence divider position but still requires review", () => {
    const selected = [
      image("Black divider.jpg", 4_000),
      image("photo-1.jpg", 1_000),
      image("photo-2.jpg", 2_000),
      image("photo-3.jpg", 3_000),
      image("photo-4.jpg", 5_000),
      image("photo-5.jpg", 6_000),
      image("photo-6.jpg", 7_000),
    ];

    const resolved = resolveSmartUploadFileOrder(selected);

    expect(resolved.files.map((file) => file.name)).toEqual([
      "photo-1.jpg",
      "photo-2.jpg",
      "photo-3.jpg",
      "Black divider.jpg",
      "photo-4.jpg",
      "photo-5.jpg",
      "photo-6.jpg",
    ]);
    expect(resolved.strategy).toBe("file-timestamp");
    expect(resolved.diagnostic).toBe("divider-position-needs-review");
    expect(resolved.ambiguous).toBe(true);
    expect(resolved.changed).toBe(true);
  });

  it("still restores photo chronology when a reusable divider position is ambiguous", () => {
    const selected = [
      image("Black divider.jpg", 500),
      image("photo-a.jpg", 30_000),
      image("photo-b.jpg", 10_000),
      image("photo-c.jpg", 20_000),
    ];

    const resolved = resolveSmartUploadFileOrder(selected);

    expect(resolved.files.map((file) => file.name)).toEqual([
      "Black divider.jpg",
      "photo-b.jpg",
      "photo-c.jpg",
      "photo-a.jpg",
    ]);
    expect(resolved.strategy).toBe("file-timestamp");
    expect(resolved.diagnostic).toBe("divider-position-needs-review");
    expect(resolved.ambiguous).toBe(true);
    expect(resolved.changed).toBe(true);
  });

  it("keeps original selection index as the final stable tie-breaker", () => {
    const first = image("IMG_1.jpg", 10_000);
    const second = image("IMG_1.jpg", 10_000);
    const resolved = resolveSmartUploadFileOrder([first, second]);

    expect(resolved.files).toEqual([first, second]);
    expect(resolved.changed).toBe(false);
  });

  it("does not mutate the FileList snapshot supplied by the caller", () => {
    const selected = [
      image("scan-a.jpg", 30_000),
      image("scan-b.jpg", 10_000),
      image("scan-c.jpg", 20_000),
    ];
    const snapshot = [...selected];

    resolveSmartUploadFileOrder(selected);

    expect(selected).toEqual(snapshot);
  });
});
