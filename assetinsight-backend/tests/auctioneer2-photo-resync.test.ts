import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Auctioneer2PhotoResyncError,
  collectAuctioneer2ResyncPhotoUrls,
  resyncAuctioneer2Photos,
  type Auctioneer2PhotoResyncDependencies,
} from "../src/service/auctioneer2PhotoResyncService.js";

const WORK_ITEM_ID = "507f1f77bcf86cd799439011";
const SECOND_WORK_ITEM_ID = "507f1f77bcf86cd799439012";
const REPORT_ID = "507f1f77bcf86cd799439021";

function sentWorkItem(input: {
  workItemId?: string;
  checkpoint?: Record<string, unknown>;
  lot?: Record<string, unknown>;
  status?: string;
  deliveryStatus?: string;
}) {
  const sourceKey = "source-1";
  return {
    _id: input.workItemId || WORK_ITEM_ID,
    source: "auctioneer2",
    status: input.status || "sent",
    selectedReportType: "asset",
    linkedReportId: REPORT_ID,
    delivery: {
      status: input.deliveryStatus || "sent",
      manifest: {
        previewData: {
          lots: [
            {
              auctioneer_source_key: sourceKey,
              ...(input.lot || {}),
            },
          ],
        },
      },
      lots: [
        {
          sourceKey,
          sourceLotId: "auctioneer-row-guid",
          status: "sent",
          ...(input.checkpoint || {}),
        },
      ],
    },
  };
}

function dependencies(input: {
  workItems: Record<string, any>;
  report?: Record<string, any>;
  loadPhoto?: Auctioneer2PhotoResyncDependencies["loadPhoto"];
  uploadPhotos?: Auctioneer2PhotoResyncDependencies["uploadPhotos"];
}): Auctioneer2PhotoResyncDependencies {
  return {
    loadWorkItem: vi.fn(async (workItemId) => input.workItems[workItemId] || null),
    loadLinkedReport: vi.fn(async () => input.report || { _id: REPORT_ID }),
    loadPhoto:
      input.loadPhoto ||
      vi.fn(async (url, lotIndex, photoIndex) => ({
        buffer: Buffer.from(`bytes:${url}`),
        contentType: "image/jpeg",
        filename: `lot-${lotIndex + 1}-photo-${photoIndex + 1}.jpg`,
        sourceUrl: url,
      })),
    uploadPhotos:
      input.uploadPhotos || vi.fn(async () => ({ success: true })),
  };
}

describe("Auctioneer 2.0 historical photo resync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses frozen v2 photo arrays by exact lot position even when duplicate display IDs and live images change", async () => {
    const firstPhoto = "https://assetinsight.test/original-first.jpg";
    const secondPhoto = "https://assetinsight.test/original-second.jpg";
    const workItem: any = sentWorkItem({ lot: { lot_id: "duplicate", lot_number: "222", image_indexes: [0] } });
    workItem.delivery.manifest.previewData.lots.push({ lot_id: "duplicate", lot_number: "222", auctioneer_source_key: "source-2", image_indexes: [1] });
    workItem.delivery.lots.push({ sourceKey: "source-2", sourceLotId: "second-target", status: "sent" });
    workItem.delivery.manifest.photoOrderVersion = 2;
    workItem.delivery.manifest.photoUrlsByLot = [[firstPhoto], [secondPhoto]];
    const deps = dependencies({ workItems: { [WORK_ITEM_ID]: workItem }, report: { _id: REPORT_ID, imageUrls: ["https://assetinsight.test/later-second.jpg", "https://assetinsight.test/later-first.jpg"] } });
    const before = JSON.parse(JSON.stringify(workItem));
    const result = await resyncAuctioneer2Photos({ workItemIds: [WORK_ITEM_ID] }, deps);
    expect(vi.mocked(deps.loadPhoto).mock.calls.map(([url, lotIndex]) => [url, lotIndex])).toEqual([[firstPhoto, 0], [secondPhoto, 1]]);
    expect(result.photoCount).toBe(2);
    expect(deps.uploadPhotos).not.toHaveBeenCalled();
    expect(workItem).toEqual(before);
    expect(() => collectAuctioneer2ResyncPhotoUrls(workItem, {}, workItem.delivery.manifest.previewData.lots[0]))
      .toThrow("frozen delivery photo manifest is incomplete");
  });

  it.each([undefined, [], [null], [[""]], [[1]], [["https://assetinsight.test/one.jpg"], []]])("rejects invalid v2 manifests without provider reads or writes (%j)", async (photoUrlsByLot) => {
    const workItem: any = sentWorkItem({ lot: { image_indexes: [0] } });
    workItem.delivery.manifest.photoOrderVersion = 2;
    workItem.delivery.manifest.photoUrlsByLot = photoUrlsByLot;
    const deps = dependencies({ workItems: { [WORK_ITEM_ID]: workItem }, report: { imageUrls: ["https://assetinsight.test/later.jpg"] } });
    await expect(resyncAuctioneer2Photos({ workItemIds: [WORK_ITEM_ID], execute: true }, deps)).rejects.toMatchObject({ code: "photo_manifest_invalid" });
    expect(deps.loadPhoto).not.toHaveBeenCalled();
    expect(deps.uploadPhotos).not.toHaveBeenCalled();
  });

  it("preserves an explicitly empty frozen v2 lot photo array", async () => {
    const workItem: any = sentWorkItem({ lot: { image_indexes: [0] } });
    workItem.delivery.manifest.photoOrderVersion = 2;
    workItem.delivery.manifest.photoUrlsByLot = [[]];
    const deps = dependencies({ workItems: { [WORK_ITEM_ID]: workItem }, report: { imageUrls: ["https://assetinsight.test/later.jpg"] } });
    const result = await resyncAuctioneer2Photos({ workItemIds: [WORK_ITEM_ID] }, deps);
    expect(result.photoCount).toBe(0);
    expect(deps.loadPhoto).not.toHaveBeenCalled();
    expect(deps.uploadPhotos).not.toHaveBeenCalled();
  });

  it("is a non-mutating dry run and selects only final, non-deleted, unique photos", async () => {
    const urls = {
      first: "https://images.sellsnap.store/first.jpg",
      deletedIndex: "https://images.sellsnap.store/deleted-index.jpg",
      deletedUrl: "https://images.sellsnap.store/deleted-url.jpg",
      directDeleted: "https://images.sellsnap.store/direct-deleted.jpg",
      extra: "https://images.sellsnap.store/extra.jpg",
      nested: "https://images.sellsnap.store/nested.jpg",
    };
    const workItem = sentWorkItem({
      lot: {
        image_url: urls.first,
        image_urls: [urls.directDeleted, urls.first],
        extra_image_urls: [urls.extra, urls.directDeleted],
        image_indexes: [0, 1, 2],
        deleted_image_urls: [urls.directDeleted],
        items: [
          { image_url: urls.extra },
          { image_urls: [urls.nested, urls.extra] },
        ],
      },
    });
    workItem.delivery.manifest.previewData = {
      ...workItem.delivery.manifest.previewData,
      imageUrls: [urls.first, urls.deletedIndex, urls.deletedUrl],
      deleted_image_indexes: [1],
      deleted_image_urls: [urls.deletedUrl],
    };
    const before = JSON.parse(JSON.stringify(workItem));
    const loadPhoto = vi.fn(async (url: string, lotIndex: number, photoIndex: number) => ({
      buffer: Buffer.from(`bytes:${url}`),
      contentType: "image/jpeg",
      filename: `lot-${lotIndex + 1}-photo-${photoIndex + 1}.jpg`,
      sourceUrl: url,
    }));
    const uploadPhotos = vi.fn(async () => ({ success: true }));
    const deps = dependencies({
      workItems: { [WORK_ITEM_ID]: workItem },
      loadPhoto,
      uploadPhotos,
    });

    const summary = await resyncAuctioneer2Photos(
      { workItemIds: [WORK_ITEM_ID] },
      deps
    );

    expect(summary).toMatchObject({
      mode: "dry-run",
      workItemCount: 1,
      lotCount: 1,
      photoCount: 3,
      batchCount: 1,
      submittedPhotoCount: 0,
    });
    expect(summary.lots[0]).toMatchObject({
      targetLotId: "auctioneer-row-guid",
      photoCount: 3,
      status: "ready",
    });
    expect(loadPhoto.mock.calls.map(([url]) => url)).toEqual([
      urls.first,
      urls.extra,
      urls.nested,
    ]);
    expect(uploadPhotos).not.toHaveBeenCalled();
    expect(workItem).toEqual(before);
  });

  it("requires execute and partitions POSTs by count and decoded bytes with absolute order", async () => {
    const imageUrls = Array.from(
      { length: 7 },
      (_, index) => `https://images.sellsnap.store/photo-${index + 1}.jpg`
    );
    const workItem = sentWorkItem({
      checkpoint: {
        sourceLotId: undefined,
        createdLotId: "created-auctioneer-row-guid",
      },
      lot: { image_urls: imageUrls },
    });
    const loadPhoto = vi.fn(
      async (url: string, lotIndex: number, photoIndex: number) => ({
        buffer:
          photoIndex < 5
            ? Buffer.from(`small-${photoIndex}`)
            : Buffer.alloc(18 * 1024 * 1024, photoIndex),
        contentType: "image/jpeg",
        filename: `lot-${lotIndex + 1}-photo-${photoIndex + 1}.jpg`,
        sourceUrl: url,
      })
    );
    const uploadPhotos = vi.fn(async () => ({
      success: true,
      delivery: "base64",
      photos: [],
    }));
    const deps = dependencies({
      workItems: { [WORK_ITEM_ID]: workItem },
      loadPhoto,
      uploadPhotos,
    });

    const summary = await resyncAuctioneer2Photos(
      { workItemIds: [WORK_ITEM_ID], execute: true },
      deps
    );

    expect(uploadPhotos).toHaveBeenCalledTimes(3);
    expect(uploadPhotos.mock.calls.map(([, photos]) => photos.length)).toEqual([
      5, 1, 1,
    ]);
    expect(uploadPhotos.mock.calls.map(([lotId]) => lotId)).toEqual([
      "created-auctioneer-row-guid",
      "created-auctioneer-row-guid",
      "created-auctioneer-row-guid",
    ]);
    expect(
      uploadPhotos.mock.calls.flatMap(([, photos]) =>
        photos.map((photo) => photo.order)
      )
    ).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(summary).toMatchObject({
      mode: "execute",
      photoCount: 7,
      batchCount: 3,
      submittedPhotoCount: 7,
    });
    expect(summary.lots[0].status).toBe("submitted");
  });

  it("preflights every explicit work item before an execute run can POST", async () => {
    const first = sentWorkItem({ lot: { image_url: "https://images.sellsnap.store/a.jpg" } });
    const second = sentWorkItem({
      workItemId: SECOND_WORK_ITEM_ID,
      lot: { image_url: "https://images.sellsnap.store/b.jpg" },
      deliveryStatus: "failed",
    });
    const loadPhoto = vi.fn();
    const uploadPhotos = vi.fn();
    const deps = dependencies({
      workItems: {
        [WORK_ITEM_ID]: first,
        [SECOND_WORK_ITEM_ID]: second,
      },
      loadPhoto,
      uploadPhotos,
    });

    await expect(
      resyncAuctioneer2Photos(
        {
          workItemIds: [WORK_ITEM_ID, SECOND_WORK_ITEM_ID],
          execute: true,
        },
        deps
      )
    ).rejects.toMatchObject({
      name: "Auctioneer2PhotoResyncError",
      code: "work_item_not_sent",
    });
    expect(loadPhoto).not.toHaveBeenCalled();
    expect(uploadPhotos).not.toHaveBeenCalled();
  });

  it("rejects missing or invalid explicit IDs before reading any work item", async () => {
    const deps = dependencies({ workItems: {} });

    await expect(
      resyncAuctioneer2Photos({ workItemIds: [] }, deps)
    ).rejects.toBeInstanceOf(Auctioneer2PhotoResyncError);
    await expect(
      resyncAuctioneer2Photos({ workItemIds: ["not-an-object-id"] }, deps)
    ).rejects.toMatchObject({ code: "work_item_id_invalid" });
    expect(deps.loadWorkItem).not.toHaveBeenCalled();
  });

  it("does not expose storage errors, URLs, or payload details", async () => {
    const sensitiveUrl =
      "https://images.sellsnap.store/customer-secret-photo.jpg";
    const workItem = sentWorkItem({ lot: { image_url: sensitiveUrl } });
    const deps = dependencies({
      workItems: { [WORK_ITEM_ID]: workItem },
      loadPhoto: vi.fn(async () => {
        throw new Error(`storage failure for ${sensitiveUrl}: secret-image-bytes`);
      }),
    });

    const error = await resyncAuctioneer2Photos(
      { workItemIds: [WORK_ITEM_ID] },
      deps
    ).catch((value) => value);

    expect(error).toMatchObject({ code: "photo_load_failed" });
    expect(error.message).not.toContain(sensitiveUrl);
    expect(error.message).not.toContain("secret-image-bytes");
  });
});
