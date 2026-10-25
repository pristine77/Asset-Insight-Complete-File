import type { Schema } from "mongoose";

type ReportKind = "asset" | "lotListing";

/**
 * Makes pending preview photo removals part of every document save path. The
 * storage queue is intentionally loaded after model compilation to avoid a
 * model import cycle while retaining an atomic Mongo-first workflow.
 */
export function attachReportImageDeletionHooks(schema: Schema, kind: ReportKind) {
  schema.pre("save", async function compactPendingReportImages() {
    const document = this as any;
    const previewData = document.preview_data;
    const hasIndexes = Array.isArray(previewData?.deleted_image_indexes) &&
      previewData.deleted_image_indexes.length > 0;
    const hasUrls = Array.isArray(previewData?.deleted_image_urls) &&
      previewData.deleted_image_urls.length > 0;
    if (!hasIndexes && !hasUrls) return;

    const { compactDeletedReportImages } = await import("./reportImageDeletion.js");
    const result = compactDeletedReportImages(previewData, document.imageUrls);
    document.preview_data = result.previewData;
    document.imageUrls = result.imageUrls;
    if (Array.isArray(result.previewData.lots)) {
      document.lots = result.previewData.lots;
    }
    document.markModified?.("preview_data");
    document.markModified?.("imageUrls");
    document.markModified?.("lots");
    document.$locals.reportImageDeletionUrls = result.removedUrls;
  });

  schema.post("save", async function queueCompactedReportImages(document: any) {
    const urls = Array.isArray(document?.$locals?.reportImageDeletionUrls)
      ? document.$locals.reportImageDeletionUrls
      : [];
    if (!urls.length) return;
    try {
      const { queueReportImageDeletions } = await import("./reportImageDeletion.js");
      await queueReportImageDeletions({
        urls,
        sourceKind: kind,
        sourceId: String(document._id),
        eventId: String(document.updatedAt?.getTime?.() || Date.now()),
      });
    } catch (error) {
      // Mongo is already safely updated. Retaining an unreferenced object is
      // preferable to failing/replaying the user's save after persistence.
      console.error("[ReportMediaDelete] Failed to enqueue deletion:", error);
    } finally {
      document.$locals.reportImageDeletionUrls = [];
    }
  });
}

