import { PassThrough, Readable } from "node:stream";
import { setTimeout as realDelay } from "node:timers/promises";
import PizZip from "pizzip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ get: vi.fn(), stream: vi.fn(), optimize: vi.fn() }));
vi.mock("axios", () => ({ default: { get: transport.get } }));
vi.mock("../src/utils/cloudinary.js", () => ({
  isCloudinaryFetchConfigured: transport.optimize,
  getCloudinaryCustomUrl: () => "https://optimizer.example.test/photo.jpg",
}));
vi.mock("../src/utils/r2Storage/r2Upload.js", async (original) => ({
  ...await original<typeof import("../src/utils/r2Storage/r2Upload.js")>(),
  getR2ObjectStream: transport.stream,
}));
import { generateImagesZip } from "../src/jobs/assetReportJob/imagesZip.js";

const original = Buffer.from("retained original photo bytes");
const current = "https://assetinsight.test/photos/one.jpg";

beforeEach(() => {
  vi.resetAllMocks();
  transport.optimize.mockReturnValue(false);
  transport.stream.mockImplementation(async () => ({ stream: Readable.from([original]) }));
  transport.get.mockRejectedValue(Object.assign(new Error("Public CDN unavailable"), { response: { status: 403 } }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("complete ZIP reads retained media independently of public CDN access", () => {
  it("reads an owned original directly when its public CDN refuses access", async () => {
    const zip = new PizZip(await generateImagesZip([current]));
    expect(zip.file("one.jpg")!.asNodeBuffer()).toEqual(original);
    expect(transport.stream).toHaveBeenCalledWith("asset-insight-test", "photos/one.jpg", { timeoutMs: 30000 });
    expect(transport.get).not.toHaveBeenCalled();
  });

  it("keeps historical media in its own legacy bucket", async () => {
    await generateImagesZip(["https://images.sellsnap.test/photos/old.jpg"]);
    expect(transport.stream).toHaveBeenCalledWith("sellsnap-test", "photos/old.jpg", { timeoutMs: 30000 });
  });

  it("preserves encoded object keys and ignores a public cache-version query", async () => {
    await generateImagesZip(["https://assetinsight.test/photos/lot%201.jpg?v=7"]);
    expect(transport.stream).toHaveBeenCalledWith("asset-insight-test", "photos/lot 1.jpg", { timeoutMs: 30000 });
  });

  it.each([
    "https://assetinsight.test.evil.example/photo.jpg",
    "https://assetinsight.test@foreign.example/photo.jpg",
  ])("does not send foreign URL %s to authenticated storage", async (url) => {
    transport.get.mockResolvedValue({ data: original });
    await generateImagesZip([url]);
    expect(transport.stream).not.toHaveBeenCalled();
    expect(transport.get).toHaveBeenCalledWith(url, expect.objectContaining({ timeout: 30000 }));
  });

  it("retries a temporary storage response on the same original", async () => {
    transport.stream.mockRejectedValueOnce({ $metadata: { httpStatusCode: 503 } });
    const zip = new PizZip(await generateImagesZip([current]));
    expect(zip.file("one.jpg")!.asNodeBuffer()).toEqual(original);
    expect(transport.stream).toHaveBeenCalledTimes(2);
    expect(transport.get).not.toHaveBeenCalled();
  });

  it("discards a broken partial stream before retrying, rather than concatenating it", async () => {
    const broken = Readable.from((async function* () {
      yield Buffer.from("partial bytes which must not be included");
      throw Object.assign(new Error("Connection reset"), { code: "ECONNRESET" });
    })());
    transport.stream.mockResolvedValueOnce({ stream: broken });
    const zip = new PizZip(await generateImagesZip([current]));
    expect(zip.file("one.jpg")!.asNodeBuffer()).toEqual(original);
    expect(transport.stream).toHaveBeenCalledTimes(2);
    expect(broken.destroyed).toBe(true);
  });

  it("still fails a genuinely missing original and never substitutes a cached or different photo", async () => {
    transport.stream.mockRejectedValue({ name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
    await expect(generateImagesZip([current])).rejects.toThrow("Failed to include photo 1 of 1");
    expect(transport.stream).toHaveBeenCalledTimes(1);
    expect(transport.get).not.toHaveBeenCalled();
  });

  it("stops after two temporary failures and keeps private diagnostic URLs out of logs", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    transport.stream.mockRejectedValue(Object.assign(new Error("https://private.example/?secret=hidden"), { code: "ETIMEDOUT" }));
    await expect(generateImagesZip([current])).rejects.toThrow("Failed to include photo 1 of 1");
    expect(transport.stream).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private.example");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("ETIMEDOUT"));
  });

  it("destroys stalled body streams at the deadline and bounds their retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const streams: PassThrough[] = [];
    transport.stream.mockImplementation(async () => {
      const stream = new PassThrough(); streams.push(stream); return { stream };
    });
    const pending = expect(generateImagesZip([current])).rejects.toThrow("Failed to include photo 1 of 1");
    await realDelay(5);
    await vi.advanceTimersByTimeAsync(30000);
    await realDelay(230);
    expect(streams).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30000);
    await pending;
    expect(streams.every(stream => stream.destroyed)).toBe(true);
    expect(transport.stream).toHaveBeenCalledTimes(2);
  });

  it("retains all 1,769 ordered entries with bounded reads when photo 180 needs a retry", async () => {
    const urls = Array.from({ length: 1769 }, (_, i) => `https://assetinsight.test/photos/${i % 1707}.jpg`);
    const names = urls.map((_, i) => `photo-${String(i + 1).padStart(4, "0")}.jpg`);
    let active = 0, peak = 0, retried = false;
    transport.stream.mockImplementation(async (_bucket, key: string) => {
      peak = Math.max(peak, ++active);
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        if (key === "photos/179.jpg" && !retried) {
          retried = true; throw { $metadata: { httpStatusCode: 503 } };
        }
        return { stream: Readable.from([Buffer.from(key)]) };
      } finally { active -= 1; }
    });
    const zip = new PizZip(await generateImagesZip(urls, undefined, { filenames: names }));
    expect(Object.keys(zip.files)).toEqual(names);
    names.forEach((name, i) => expect(zip.file(name)!.asNodeBuffer()).toEqual(Buffer.from(`photos/${i % 1707}.jpg`)));
    expect(peak).toBeLessThanOrEqual(3);
    expect(transport.stream).toHaveBeenCalledTimes(1770);
    expect(active).toBe(0);
  });

  it("keeps optimizer fallback and reads the same stored original after an optimizer refusal", async () => {
    transport.optimize.mockReturnValue(true);
    const zip = new PizZip(await generateImagesZip([current]));
    expect(zip.file("one.jpg")!.asNodeBuffer()).toEqual(original);
    expect(transport.get).toHaveBeenCalledTimes(1);
    expect(transport.stream).toHaveBeenCalledTimes(1);
  });

  it("copies owned video bytes too, and refuses an empty original", async () => {
    const zip = new PizZip(await generateImagesZip([], undefined, { rawFiles: [{ url: current, filename: "clip.mp4" }] }));
    expect(zip.file("clip.mp4")!.asNodeBuffer()).toEqual(original);
    expect(transport.stream).toHaveBeenCalledWith("asset-insight-test", "photos/one.jpg", { timeoutMs: 120000 });
    transport.stream.mockResolvedValue({ stream: Readable.from([]) });
    await expect(generateImagesZip([], undefined, { rawFiles: [{ url: current, filename: "clip.mp4" }] })).rejects.toThrow("Failed to include video 1");
  });
});
