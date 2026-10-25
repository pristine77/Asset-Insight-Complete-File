import { describe, expect, it } from "vitest";
import {
  appendSupportFiles,
  SUPPORT_MAX_IMAGE_BYTES,
  SUPPORT_MAX_VIDEO_BYTES,
  supportFileContentType,
} from "./supportFiles";

function sizedFile(name: string, type: string, size: number) {
  const file = new File(["test"], name, { type, lastModified: 100 });
  Object.defineProperty(file, "size", { configurable: true, value: size });
  return file;
}

describe("support file validation", () => {
  it("accepts the backend image/video allowlist and infers mobile extensions", () => {
    const image = sizedFile("screen.heic", "", SUPPORT_MAX_IMAGE_BYTES);
    const video = sizedFile("recording.mov", "", SUPPORT_MAX_VIDEO_BYTES);
    const result = appendSupportFiles([], [image, video]);

    expect(result.error).toBeNull();
    expect(result.files).toEqual([image, video]);
    expect(supportFileContentType(image)).toBe("image/heic");
    expect(supportFileContentType(video)).toBe("video/quicktime");
  });

  it("rejects unsupported and oversized files before requesting R2 URLs", () => {
    const document = sizedFile("secret.pdf", "application/pdf", 100);
    const hugeImage = sizedFile(
      "huge.jpg",
      "image/jpeg",
      SUPPORT_MAX_IMAGE_BYTES + 1
    );
    const result = appendSupportFiles([], [document, hugeImage]);

    expect(result.files).toEqual([]);
    expect(result.error).toMatch(/not a supported image or video/i);
  });

  it("deduplicates repeat selections", () => {
    const image = sizedFile("screen.png", "image/png", 500);
    const result = appendSupportFiles([image], [image]);
    expect(result.files).toHaveLength(1);
  });
});
