import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetCreateDetails } from "./asset";

const mocks = vi.hoisted(() => ({ post: vi.fn(), direct: vi.fn() }));
vi.mock("@/lib/api", () => ({ default: { post: mocks.post } }));
vi.mock("./directUpload", () => ({
  uploadReportFilesDirectToR2: mocks.direct,
  isUploadSessionUnsupportedError: (error: any) => error?.code === "UPLOAD_SESSION_UNSUPPORTED",
}));
import { AssetService } from "./asset";

const videos = [new File(["first"], "first.mp4", { type: "video/mp4" }), new File(["second"], "second.mp4", { type: "video/mp4" }), new File(["last"], "last.mp4", { type: "video/mp4" })];
const images = [new File(["photo"], "photo.jpg", { type: "image/jpeg" })];
const detailsFor = (counts: Array<number | undefined>): AssetCreateDetails => ({
  grouping_mode: "mixed",
  mixed_lots: counts.map((video_count) => ({ count: 1, extra_count: 0, video_count, mode: "single_lot" })),
});

describe("Asset video lot transport", () => {
  beforeEach(() => {
    mocks.post.mockReset().mockResolvedValue({ data: { reportId: "accepted", jobId: "job-accepted", status: "processing" } });
    mocks.direct.mockReset().mockResolvedValue({ reportId: "accepted" });
  });

  it("keeps sparse lot and clip order in the direct-upload manifest without changing photo indexes", async () => {
    const details = detailsFor([0, 2, 0, 1]);
    const before = structuredClone(details);
    await AssetService.create(details, images, videos);
    const sent = mocks.direct.mock.calls[0][0];
    expect(sent.details.mixed_lots.map((lot: any) => lot.video_count)).toEqual([0, 2, 0, 1]);
    expect(sent.files[0]).toEqual({ file: images[0], fieldname: "images", imageIndex: 0, role: "main" });
    expect(sent.files.slice(1)).toEqual(videos.map((file, imageIndex) => ({ file, fieldname: "videos", imageIndex, lotIndex: [1, 1, 3][imageIndex], role: "video" })));
    expect(details).toEqual(before);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("keeps the same sparse counts and video order in the unsupported-server multipart fallback", async () => {
    mocks.direct.mockRejectedValueOnce({ code: "UPLOAD_SESSION_UNSUPPORTED" });
    await AssetService.create(detailsFor([0, 2, 0, 1]), images, videos);
    const body = mocks.post.mock.calls[0][1] as FormData;
    expect(JSON.parse(String(body.get("details"))).mixed_lots.map((lot: any) => lot.video_count)).toEqual([0, 2, 0, 1]);
    expect(body.getAll("videos")).toEqual(videos);
    expect(body.getAll("images")).toEqual(images);
  });

  it.each([[0, undefined, 3], [0, -1, 4], [0, 1.5, 1.5], [0, 2, 0], [0, 4, 0], [0, Number.MAX_SAFE_INTEGER, 0]])("rejects inconsistent explicit video counts %j before either transport", async (...counts) => {
    await expect(AssetService.create(detailsFor(counts), images, videos)).rejects.toThrow("Video counts do not match");
    expect(mocks.direct).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("preserves legacy uploads with no declared mapping without guessing a lot", async () => {
    await AssetService.create(detailsFor([undefined, undefined]), images, videos);
    const sent = mocks.direct.mock.calls[0][0];
    for (const file of sent.files.slice(1)) expect(file).not.toHaveProperty("lotIndex");
  });
});
