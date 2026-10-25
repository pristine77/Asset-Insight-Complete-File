import { describe, expect, it, vi } from "vitest";
import API from "@/lib/api";
import {
  getDraftFileMetadata,
  SavedInputService,
  type DraftImageData,
} from "./savedInputs";

describe("draft media identity", () => {
  it("keeps a stable identity and restores a persisted clientFileId", () => {
    const original = new File(["original"], "asset.jpg", {
      type: "image/jpeg",
      lastModified: 1234,
    });
    const first = getDraftFileMetadata(original);

    expect(getDraftFileMetadata(original)).toEqual(first);
    expect(first).toMatchObject({ size: 8, lastModified: 1234 });

    const replacement = new File(["original"], "asset.jpg", {
      type: "image/jpeg",
      lastModified: 1234,
    });
    expect(getDraftFileMetadata(replacement).clientFileId).not.toBe(
      first.clientFileId
    );

    const restored = new File(["original"], "asset.jpg", {
      type: "image/jpeg",
      lastModified: 1234,
    });
    expect(
      getDraftFileMetadata(restored, {
        clientFileId: first.clientFileId,
        size: first.size,
        lastModified: first.lastModified,
      })
    ).toEqual(first);
  });

  it("adds file identity metadata to upload responses", async () => {
    const file = new File(["image"], "lot.jpg", {
      type: "image/jpeg",
      lastModified: 9876,
    });
    const post = vi.spyOn(API, "post").mockResolvedValue({
      data: {
        message: "uploaded",
        data: [
          {
            lotId: "lot-1",
            type: "main",
            name: "lot.jpg",
            url: "/uploads/lot.jpg",
            mimeType: "image/jpeg",
          },
        ],
      },
    });

    const [uploaded] = await SavedInputService.uploadDraftImages(
      [file],
      "lot-1",
      "main"
    );

    expect(uploaded).toMatchObject({
      lotId: "lot-1",
      type: "main",
      size: file.size,
      lastModified: 9876,
    });
    expect(uploaded.clientFileId).toBe(
      getDraftFileMetadata(file).clientFileId
    );
    const body = post.mock.calls[0][1] as FormData;
    expect(JSON.parse(String(body.get("metadata")))[0]).toEqual(
      getDraftFileMetadata(file)
    );
  });
});

describe("draft upload scheduling", () => {
  it("never runs more than three upload batches concurrently", async () => {
    let active = 0;
    let maximumActive = 0;
    vi.spyOn(SavedInputService, "uploadDraftImages").mockImplementation(
      async (files, lotId, type) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        const mediaType = type || "main";
        return files.map((file) => ({
          ...getDraftFileMetadata(file),
          lotId,
          type: mediaType,
          name: file.name,
          url: `/uploads/${file.name}`,
          mimeType: file.type,
        }));
      }
    );
    const batches = Array.from({ length: 8 }, (_, index) => ({
      files: [
        new File([`${index}`], `${index}.jpg`, { type: "image/jpeg" }),
      ],
      lotId: `lot-${index}`,
      type: "main" as const,
    }));

    const uploaded = await SavedInputService.uploadDraftImageBatches(
      batches,
      3
    );

    expect(uploaded).toHaveLength(8);
    expect(maximumActive).toBe(3);
  });

  it("removes successful partial uploads when a later batch fails", async () => {
    const completed: DraftImageData = {
      clientFileId: "file-1",
      size: 5,
      lastModified: 0,
      lotId: "lot-1",
      type: "main",
      name: "one.jpg",
      url: "/uploads/one.jpg",
      mimeType: "image/jpeg",
    };
    vi.spyOn(SavedInputService, "uploadDraftImages")
      .mockResolvedValueOnce([completed])
      .mockRejectedValueOnce(new Error("offline"));
    const remove = vi
      .spyOn(SavedInputService, "deleteDraftImagesByUrls")
      .mockResolvedValue();

    await expect(
      SavedInputService.uploadDraftImageBatches(
        [
          {
            files: [new File(["one"], "one.jpg")],
            lotId: "lot-1",
            type: "main",
          },
          {
            files: [new File(["two"], "two.jpg")],
            lotId: "lot-2",
            type: "main",
          },
        ],
        1
      )
    ).rejects.toThrow("offline");
    expect(remove).toHaveBeenCalledWith(["/uploads/one.jpg"]);
  });
});
