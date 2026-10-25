import { beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import {
  detectLotNumberUploadBatch,
  parseLotNumberUploadResults,
  prepareLotNumberUploadPhoto,
  LOT_NUMBER_UPLOAD_MAX_REQUEST_BYTES,
} from "../src/service/lotNumberUploadDetector.js";

const { createResponse } = vi.hoisted(() => ({ createResponse: vi.fn() }));
vi.mock("../src/utils/openaiClient.js", () => ({ default: { responses: { create: createResponse } } }));
const card = (fileId: string, lotNumber = "2500") => ({ fileId, kind: "lot_start", lotNumber });
const photo = (fileId: string) => ({ fileId, kind: "photo", lotNumber: null });
const parse = (rows: unknown[], ids = ["a", "b"]) => parseLotNumberUploadResults(JSON.stringify({ results: rows }), ids);
const prepared = (fileId: string) => ({ fileId, imageUrl: "data:image/jpeg;base64,aW1hZ2U=" });

beforeEach(() => vi.clearAllMocks());

describe("lot-number upload recognition", () => {
  it("maps shuffled results to original stable IDs, not model row order", () => {
    expect(parse([photo("b"), card("a")])).toEqual([card("a"), photo("b")]);
  });
  it.each(["157", "999", "1000", "1000A", "002500"])("retains card number %s", (value) => {
    expect(parse([card("a", value)], ["a"])[0]?.lotNumber).toBe(value);
  });
  it("normalizes a thousands separator without changing identity", () => {
    expect(parse([card("a", "1,000")], ["a"])[0]?.lotNumber).toBe("1000");
  });
  it.each(["VIN 1HGCM82633A004352", "1HGCM82633A004352", "Oct 28th", "1-800-263-4193", "$2500", "2500 or 2501", ""])(
    "does not treat unsafe reading %s as a boundary", (value) => {
      expect(parse([card("a", value)], ["a"])).toEqual([{ fileId: "a", kind: "uncertain", lotNumber: null }]);
    },
  );
  it("retains uncertainty and contradictory evidence for mandatory review", () => {
    expect(parse([{ fileId: "a", kind: "uncertain", lotNumber: null }, { ...photo("b"), lotNumber: "2501" }]))
      .toEqual(["a", "b"].map((fileId) => ({ fileId, kind: "uncertain", lotNumber: null })));
  });
  it.each([
    [], [card("a")], [card("a"), card("a")], [card("a"), photo("foreign")],
    [card("a"), { fileId: "b", kind: "made_up", lotNumber: null }],
    [card("a"), { fileId: "b", kind: "lot_start", lotNumber: 2500 }],
    [card("a"), { fileId: "b", kind: "photo" }], [null, photo("b")],
  ])("fails incomplete/malformed batch %# without silently merging", (rows) => {
    expect(() => parse(rows)).toThrow("could not verify this batch");
  });
  it.each(["", "not json", "null", "{}"])("rejects unusable output %s", (text) => {
    expect(() => parseLotNumberUploadResults(text, ["a"])).toThrow("could not verify this batch");
  });
  it("does not contact the provider for zero photos", async () => {
    expect(await detectLotNumberUploadBatch([])).toEqual([]);
    expect(createResponse).not.toHaveBeenCalled();
  });
  it("bounds requests, rejects duplicate IDs and disallows remote URLs", async () => {
    await expect(detectLotNumberUploadBatch(Array.from({ length: 11 }, (_, i) => prepared(String(i))))).rejects.toThrow("Invalid");
    await expect(detectLotNumberUploadBatch([prepared("a"), prepared("a")])).rejects.toThrow("Invalid");
    await expect(detectLotNumberUploadBatch([{ fileId: "a", imageUrl: "https://private.invalid/image" }])).rejects.toThrow("Invalid");
    await expect(detectLotNumberUploadBatch([{ fileId: "a", imageUrl: `data:image/jpeg;base64,${"a".repeat(LOT_NUMBER_UPLOAD_MAX_REQUEST_BYTES)}` }])).rejects.toThrow("request size");
    expect(createResponse).not.toHaveBeenCalled();
  });
  it("uses strict ID-bound output, bounded time/retries, high detail and no provider storage", async () => {
    createResponse.mockResolvedValue({ status: "completed", output_text: JSON.stringify({ results: [card("a"), photo("b")] }) });
    expect(await detectLotNumberUploadBatch([prepared("a"), prepared("b")])).toEqual([card("a"), photo("b")]);
    const [body, options] = createResponse.mock.calls[0]!;
    expect(body).toMatchObject({ store: false, max_output_tokens: 4000, text: { format: { strict: true } } });
    expect(options).toEqual({ timeout: 90000, maxRetries: 1 });
    expect(body.input[0].content.filter((item: any) => item.type === "input_image")).toHaveLength(2);
    expect(body.input[0].content.filter((item: any) => item.type === "input_image").every((item: any) => item.detail === "high")).toBe(true);
    expect(body.input[0].content[0].text).toContain("untrusted evidence");
  });
  it("fails provider refusal/incomplete/error without exposing diagnostics", async () => {
    createResponse.mockResolvedValueOnce({ status: "incomplete", output_text: JSON.stringify({ results: [card("a")] }) })
      .mockRejectedValueOnce(new Error("private-provider-detail"));
    await expect(detectLotNumberUploadBatch([prepared("a")])).rejects.toThrow("could not verify this batch");
    await expect(detectLotNumberUploadBatch([prepared("a")])).rejects.not.toThrow("private-provider-detail");
  });
  it("prepares a bounded rotated copy without modifying original bytes", async () => {
    const original = await sharp({ create: { width: 2200, height: 1200, channels: 3, background: "white" } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const before = Buffer.from(original);
    const result = await prepareLotNumberUploadPhoto("stable", original);
    const image = Buffer.from(result.imageUrl.split(",")[1]!, "base64");
    const meta = await sharp(image).metadata();
    expect(result.fileId).toBe("stable");
    expect(meta.width).toBeLessThanOrEqual(1600);
    expect(meta.height).toBe(1600);
    expect(meta.height).toBeGreaterThan(meta.width!);
    expect(meta.orientation).toBeUndefined();
    expect(original.equals(before)).toBe(true);
  });
  it("rejects corrupt/empty images rather than creating a photo classification", async () => {
    await expect(prepareLotNumberUploadPhoto("a", Buffer.alloc(0))).rejects.toThrow("empty");
    await expect(prepareLotNumberUploadPhoto("a", Buffer.from("not an image"))).rejects.toThrow();
  });
});
