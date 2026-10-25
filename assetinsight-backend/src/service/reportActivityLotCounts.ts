import mongoose from "mongoose";
import { activityHash, activitySnapshot } from "../utils/reportActivitySnapshot.js";

// A read-only current-state projection, not reconstructed historical activity.
// Never return photos, local paths, descriptions or other saved field values.
export async function readActivityLotCounts(stream: any, page: number, limit: number) {
  type Lot = { id: string; lotNumber: string; position: number; mainPhotos: number; extraPhotos: number; photos: number; missingPhotos: number | null };
  let lots: Lot[] = [], source: "report" | "draft" | "capture" | "unavailable" = "unavailable", asOf: Date | null = null;
  const fromSnapshot = (row: any, model: string) => activitySnapshot(row, model).lots.map((lot: any) => ({
    id: activityHash(`${lot.id}:${lot.position}`), lotNumber: lot.lotNumber.trim() || String(lot.position + 1), position: lot.position,
    mainPhotos: lot.main.length, extraPhotos: lot.extra.length, photos: lot.main.length + lot.extra.length, missingPhotos: null,
  }));
  if (!stream.deleted && stream.reportId) {
    const name = stream.reportType === "asset" ? "AssetReport" : "LotListing";
    const model = mongoose.models[name];
    const row = model && await model.findOne({ _id: stream.reportId, user: stream.owner })
      .select("preview_data.lots preview_data.imageUrls lots imageUrls updatedAt").lean();
    if (row) { lots = fromSnapshot(row, name); source = "report"; asOf = row.updatedAt || null; }
  } else if (!stream.deleted) {
    const draftModel = mongoose.models.ReportDraft;
    const draft = draftModel && await draftModel.findOne({ user: stream.owner, type: stream.reportType,
      ...(stream.draftId ? { _id: stream.draftId } : { clientDraftId: stream.activityId }) })
      .select("lots media updatedAt").lean();
    if (draft) { lots = fromSnapshot(draft, "ReportDraft"); source = "draft"; asOf = draft.updatedAt || null; }
    else {
      const captureModel = mongoose.models.CaptureInventory;
      const capture = captureModel && await captureModel.findOne({ user: stream.owner, reportType: stream.reportType,
        captureId: stream.captureId || stream.activityId, removedAt: null }).select("lots lastReceivedAt").lean();
      if (capture) {
        source = "capture"; asOf = capture.lastReceivedAt || null;
        lots = capture.lots.map((lot: any, position: number) => ({ id: activityHash(`${lot.id}:${position}`),
          lotNumber: lot.lotNumber?.trim() || String(position + 1), position, mainPhotos: lot.mainPhotoCount,
          extraPhotos: lot.extraPhotoCount, photos: lot.mainPhotoCount + lot.extraPhotoCount, missingPhotos: lot.missingPhotoCount }));
      }
    }
  }
  // Do not substitute old draft counts for a deleted/missing submitted report.
  // Its retained timeline remains available, but a complete lot list is unknown.
  return { items: lots.slice((page - 1) * limit, page * limit), total: lots.length, page, limit, source, asOf };
}
