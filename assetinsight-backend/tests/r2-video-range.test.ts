import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn());
vi.mock("dotenv", () => ({ config: () => ({}) }));
vi.mock("@aws-sdk/client-s3", async (original) => ({
  ...await original<typeof import("@aws-sdk/client-s3")>(),
  S3Client: class { send = send; },
}));

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { readR2ObjectRange } from "../src/utils/r2Storage/r2Upload.js";

const bucket = "asset-insight-test";
const key = "uploads/video.mp4";
const etag = '"version-123"';
const maximum = 8 * 1024 * 1024;

beforeEach(() => {
  send.mockReset();
  vi.stubEnv("R2_BUCKET_NAME", bucket);
  vi.stubEnv("R2_BUCKET", "");
  vi.stubEnv("R2_PUBLIC_URL", "https://assetinsight.test");
  vi.stubEnv("R2_CUSTOM_DOMAIN", "");
  vi.stubEnv("R2_LEGACY_BUCKET_NAME", "sellsnap");
  vi.stubEnv("R2_LEGACY_PUBLIC_URL", "https://images.sellsnap.store");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("bounded version-checked R2 video ranges", () => {
  it("requests the exact byte range and quoted IfMatch with a bounded SDK abort signal", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    send.mockResolvedValue({ ContentLength: 5, ETag: etag, Body: Readable.from([Buffer.from("12"), Buffer.from("345")]) });

    expect(await readR2ObjectRange(bucket, key, 7, 5, etag)).toEqual(Buffer.from("12345"));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBeInstanceOf(GetObjectCommand);
    expect(send.mock.calls[0][0].input).toEqual({ Bucket: bucket, Key: key, Range: "bytes=7-11", IfMatch: etag });
    expect(send.mock.calls[0][1]).toEqual({ abortSignal: controller.signal });
    expect(timeout).toHaveBeenCalledExactlyOnceWith(60_000);
  });

  it("allows exactly the 8 MiB chunk limit without reading the whole source", async () => {
    const chunk = Buffer.alloc(maximum, 0x61);
    send.mockResolvedValue({ ContentLength: maximum, ETag: etag, Body: Readable.from([chunk]) });
    const result = await readR2ObjectRange(bucket, key, maximum, maximum, etag);
    expect(result.equals(chunk)).toBe(true);
    expect(send.mock.calls[0][0].input.Range).toBe(`bytes=${maximum}-${2 * maximum - 1}`);
  });

  it("preserves exact legacy object keys and reads only the requested bytes", async () => {
    send.mockResolvedValue({ ContentLength: 1, ETag: etag, Body: Readable.from([Buffer.from("x")]) });
    expect(await readR2ObjectRange("sellsnap", "uploads/old name.mp4", 0, 1, etag)).toEqual(Buffer.from("x"));
    expect(send.mock.calls[0][0].input).toEqual({ Bucket: "sellsnap", Key: "uploads/old name.mp4", Range: "bytes=0-0", IfMatch: etag });
  });

  it.each([
    [-1, 1], [0.5, 1], [NaN, 1], [Infinity, 1], [Number.MAX_SAFE_INTEGER + 1, 1],
    [0, 0], [0, -1], [0, 0.5], [0, NaN], [0, Infinity], [0, maximum + 1],
    [Number.MAX_SAFE_INTEGER, 3],
  ])("rejects invalid offset/length (%s, %s) before any SDK read", async (offset, length) => {
    await expect(readR2ObjectRange(bucket, key, offset, length, etag)).rejects.toThrow(/invalid video source range/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects an absent source version before any SDK read", async () => {
    await expect(readR2ObjectRange(bucket, key, 0, 1, "")).rejects.toThrow(/invalid video source range/i);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["", "/absolute.mp4", "uploads/../secret.mp4", "uploads//video.mp4", "uploads/./video.mp4", "uploads/", "uploads\\video.mp4", "uploads/invalid\u0000.mp4", "x".repeat(1025)])("rejects invalid current-storage key %j before any SDK read", async (invalidKey) => {
    await expect(readR2ObjectRange(bucket, invalidKey, 0, 1, etag)).rejects.toThrow(/object key/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects unknown storage generations before any SDK read", async () => {
    await expect(readR2ObjectRange("foreign-bucket", key, 0, 1, etag)).rejects.toThrow(/allowed storage generation/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects incomplete storage configuration before any SDK read", async () => {
    vi.stubEnv("R2_PUBLIC_URL", "");
    await expect(readR2ObjectRange(bucket, key, 0, 1, etag)).rejects.toThrow(/R2_PUBLIC_URL is required/i);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    { ContentLength: 4, ETag: '"changed-version"' },
    { ContentLength: 3, ETag: etag },
    { ContentLength: 5, ETag: etag },
    { ContentLength: undefined, ETag: etag },
    { ContentLength: 4, ETag: undefined },
  ])("destroys an untrusted body when range metadata changed: %j", async (metadata) => {
    const body = Readable.from([Buffer.from("data")]);
    const destroy = vi.spyOn(body, "destroy");
    const consume = vi.spyOn(body, Symbol.asyncIterator);
    send.mockResolvedValue({ ...metadata, Body: body });
    await expect(readR2ObjectRange(bucket, key, 0, 4, etag)).rejects.toThrow(/source changed/i);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(consume).not.toHaveBeenCalled();
  });

  it("stops and destroys an oversized stream even if declared length is correct", async () => {
    const body = Readable.from([Buffer.from("123"), Buffer.from("456")]);
    send.mockResolvedValue({ ContentLength: 4, ETag: etag, Body: body });
    await expect(readR2ObjectRange(bucket, key, 0, 4, etag)).rejects.toThrow(/4-byte read limit/i);
    expect(body.destroyed).toBe(true);
  });

  it("rejects a truncated stream instead of returning incomplete original bytes", async () => {
    send.mockResolvedValue({ ContentLength: 4, ETag: etag, Body: Readable.from([Buffer.from("123")]) });
    await expect(readR2ObjectRange(bucket, key, 0, 4, etag)).rejects.toThrow(/source was incomplete/i);
  });

  it("rejects missing response bodies as incomplete source data", async () => {
    send.mockResolvedValue({ ContentLength: 4, ETag: etag });
    await expect(readR2ObjectRange(bucket, key, 0, 4, etag)).rejects.toThrow(/source was incomplete/i);
  });

  it("propagates SDK abort without retrying or continuing the read", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    send.mockImplementation((_command, options) => new Promise((_resolve, reject) => {
      options.abortSignal.addEventListener("abort", () => reject(options.abortSignal.reason), { once: true });
    }));
    const failure = new Error("isolated read timeout");
    const pending = expect(readR2ObjectRange(bucket, key, 0, 4, etag)).rejects.toBe(failure);
    controller.abort(failure);
    await pending;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("propagates a provider precondition failure without retrying another version", async () => {
    const failure = Object.assign(new Error("source version changed"), { name: "PreconditionFailed" });
    send.mockRejectedValue(failure);
    await expect(readR2ObjectRange(bucket, key, 0, 4, etag)).rejects.toBe(failure);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
