import { beforeEach, describe, expect, it, vi } from "vitest";
import API from "@/lib/api";
import { RealEstateService, type RealEstateDetails } from "./realEstate";

vi.mock("@/lib/api", () => ({ default: { post: vi.fn() } }));
const details = { property_type: "agricultural", farmland_details: { use_income_approach: true, vacancy_loss_percent: 0 } } as RealEstateDetails;
const files = (count: number, prefix: string) => Array.from({ length: count }, (_, i) => new File([`${i}`], `${prefix}-${i}.jpg`, { type: "image/jpeg" }));

beforeEach(() => {
  vi.mocked(API.post).mockReset().mockResolvedValue({ data: { jobId: "re-job", phase: "processing" } });
});

describe("Real Estate multipart contract", () => {
  it("sends every photo, map and video in the correct field without reordering", async () => {
    const images = files(50, "main");
    const extras = files(99, "extra");
    const map = new File(["map"], "map.png", { type: "image/png" });
    const video = new File(["video"], "walkthrough.mp4", { type: "video/mp4" });
    const result = await RealEstateService.create(details, images, [...extras, map], [video]);
    const [url, body] = vi.mocked(API.post).mock.calls[0];
    const data = body as FormData;
    expect(url).toBe("/real-estate");
    expect(data.getAll("images")).toEqual(images);
    expect(data.getAll("extraImages")).toEqual([...extras, map]);
    expect(data.getAll("videos")).toEqual([video]);
    expect(data.has("mapImage")).toBe(false);
    expect(JSON.parse(String(data.get("details")))).toEqual(details);
    expect(result.phase).toBe("processing");
  });

  it.each([[51, 0, 0], [1, 101, 0], [1, 0, 21]])("rejects unsupported media counts %i/%i/%i before upload", async (main, extra, video) => {
    await expect(RealEstateService.create(details, files(main, "main"), files(extra, "extra"), files(video, "video"))).rejects.toThrow("support up to");
    expect(API.post).not.toHaveBeenCalled();
  });
});
