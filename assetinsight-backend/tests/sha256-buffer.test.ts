import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SHA256_BUFFER_CHUNK_BYTES, sha256Buffer } from "../src/utils/sha256Buffer.js";
import { buildImmutableAssetArtifactKey } from "../src/service/assetArtifactBufferPublicationService.js";

describe("bounded, event-loop-friendly artifact hashing", () => {
  it.each([0, 1, 255, SHA256_BUFFER_CHUNK_BYTES - 1, SHA256_BUFFER_CHUNK_BYTES, SHA256_BUFFER_CHUNK_BYTES + 1, 2 * SHA256_BUFFER_CHUNK_BYTES + 137])(
    "preserves the exact SHA-256 digest across the %i-byte boundary", async size => {
      const buffer = Buffer.alloc(size, 0x9d);
      if (size) { buffer[0] = 0x02; buffer[size - 1] = 0xf7; }
      const expected = createHash("sha256").update(buffer).digest("hex");
      expect(await sha256Buffer(buffer)).toBe(expected);
    },
  );

  it("uses bounded zero-copy views and lets heartbeat callbacks run before the next chunk", async () => {
    const backing = Buffer.alloc(2 * SHA256_BUFFER_CHUNK_BYTES + 115, 0x35);
    const buffer = backing.subarray(17, backing.length - 13);
    let heartbeatRan = false;
    const observed: Array<{ start: number; end: number; heartbeat: boolean }> = [];
    const original = buffer.subarray.bind(buffer);
    const spy = vi.spyOn(buffer, "subarray").mockImplementation((start = 0, end = buffer.length) => {
      const view = original(start, end);
      expect(view.buffer).toBe(buffer.buffer);
      expect(view.byteOffset).toBe(buffer.byteOffset + start);
      observed.push({ start, end, heartbeat: heartbeatRan });
      return view;
    });
    setImmediate(() => { heartbeatRan = true; });
    try {
      expect(await sha256Buffer(buffer)).toBe(createHash("sha256").update(buffer).digest("hex"));
      expect(observed.map(value => value.end - value.start)).toEqual([SHA256_BUFFER_CHUNK_BYTES, SHA256_BUFFER_CHUNK_BYTES, 85]);
      expect(observed[0].heartbeat).toBe(false);
      expect(observed.slice(1).every(value => value.heartbeat)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it.each(["report.pdf", "report-cr.pdf", "report-cr.docx", "report-schedule-a.pdf", "report.docx", "report.xlsx", "report-images.zip"])(
    "retains the existing immutable object key for %s", async filename => {
      const buffer = Buffer.from([0, 255, 7, 0, 19]);
      const input = { reportId: "report-123", revision: 9, baseKey: `previews/${filename}`, buffer };
      const expected = `previews/asset-generations/report-123/revision-9/${createHash("sha256").update(buffer).digest("hex")}-${filename}`;
      expect(await buildImmutableAssetArtifactKey(input)).toBe(expected);
      expect(await buildImmutableAssetArtifactKey(input)).toBe(expected);
      expect(await buildImmutableAssetArtifactKey({ ...input, buffer: Buffer.from("different bytes") })).not.toBe(expected);
    },
  );
});
