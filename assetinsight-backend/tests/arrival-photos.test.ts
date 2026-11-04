/**
 * Arrival photos (owner, 2026-11-03): "the images taken are watermarked and
 * not processed by Asset Insight" and "Its just file copy only". The service
 * watermarks each photo and sends them to Auctioneer in batches of five; it
 * never touches the AI, a report, a job or a work item.
 */
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const uploads: Array<{ requestId: string; userId: string; photos: Array<{ filename: string; contentType: string; order: number }> }> = [];

vi.mock("../src/service/auctioneer2Client.js", () => ({
  AUCTIONEER2_PHOTO_MAX_FILES_PER_REQUEST: 5,
  listArrivalPhotoRequests: vi.fn(async () => [{ requestId: "request-1" }]),
  uploadArrivalPhotos: vi.fn(async (requestId: string, userId: string, photos: any[]) => {
    uploads.push({ requestId, userId, photos });
    const total = uploads.reduce((sum, upload) => sum + upload.photos.length, 0);
    return { stored: photos.length, skipped: 0, photoCount: total };
  }),
}));
vi.mock("../src/utils/imageProcessing.js", () => ({
  processImageWithLogo: vi.fn(async (buffer: Buffer) => ({ buffer: Buffer.concat([buffer, Buffer.from("+logo")]), format: "jpeg" })),
}));

const { sendArrivalPhotos, listMyArrivalPhotoRequests, MAX_ARRIVAL_PHOTOS_PER_SEND } = await import("../src/service/arrivalPhotoService.js");
const { processImageWithLogo } = await import("../src/utils/imageProcessing.js");

const photo = (name: string, mimetype = "image/jpeg") => ({ buffer: Buffer.from(name), originalname: name, mimetype });

beforeEach(() => {
  uploads.length = 0;
  vi.clearAllMocks();
});

describe("sendArrivalPhotos", () => {
  it("watermarks every photo and sends them in batches of five", async () => {
    const files = Array.from({ length: 12 }, (_, index) => photo(`photo ${index + 1}.HEIC`));
    const result = await sendArrivalPhotos("user-1", "request-1", files);

    expect(processImageWithLogo).toHaveBeenCalledTimes(12);
    expect(uploads.map(upload => upload.photos.length)).toEqual([5, 5, 2]);
    expect(uploads.every(upload => upload.requestId === "request-1" && upload.userId === "user-1")).toBe(true);
    expect(uploads[0].photos[0]).toMatchObject({ filename: "photo-1.jpg", contentType: "image/jpeg", order: 0 });
    expect(result).toEqual({ sent: 12, stored: 12, skipped: 0, photoCount: 12 });
  });

  it("leaves out files that are not images", async () => {
    await sendArrivalPhotos("user-1", "request-1", [photo("front.jpg"), photo("clip.mp4", "video/mp4"), photo("notes.pdf", "application/pdf")]);
    expect(processImageWithLogo).toHaveBeenCalledTimes(1);
    expect(uploads[0].photos.map(item => item.filename)).toEqual(["front.jpg"]);
  });

  it("refuses an empty send and an oversized one before touching anything", async () => {
    await expect(sendArrivalPhotos("user-1", "request-1", [])).rejects.toMatchObject({ statusCode: 400, code: "arrival_photos_required" });
    const tooMany = Array.from({ length: MAX_ARRIVAL_PHOTOS_PER_SEND + 1 }, (_, index) => photo(`p${index}.jpg`));
    await expect(sendArrivalPhotos("user-1", "request-1", tooMany)).rejects.toMatchObject({ statusCode: 400, code: "arrival_photos_too_many" });
    expect(processImageWithLogo).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(0);
  });

  it("lists the signed-in user's requests from Auctioneer", async () => {
    await expect(listMyArrivalPhotoRequests("user-1")).resolves.toEqual([{ requestId: "request-1" }]);
  });
});

describe("file copy only", () => {
  it("uses only the Auctioneer client and the watermark, nothing that analyses photos or makes reports", () => {
    const source = readFileSync(new URL("../src/service/arrivalPhotoService.ts", import.meta.url), "utf8");
    const modules = [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(match => match[1]).sort();
    expect(modules).toEqual(["../utils/imageProcessing.js", "./auctioneer2Client.js"]);
    expect(source).not.toMatch(/require\(/);
  });
});
