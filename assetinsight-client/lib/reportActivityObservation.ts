/** Compact, metadata-only observations. Never serialize a URI, note or image bytes. */
export type ActivityPhoto = { id: string; camera: boolean };
export type ActivityLotState = { id: string; lotNumber: string; main: ActivityPhoto[]; extra: ActivityPhoto[]; cover: number | null };
export type ActivityState = { lots: ActivityLotState[]; activeLot: string | null; logo: boolean | null; mode: string; status: string };
export type DeviceActivity = { eventId: string; activityId: string; reportType: "asset" | "lotListing"; contract: string; source: "web" | "android" | "ios"; sequence: number; sequenceScope: string; observedAt: string; action: string; outcome: "requested" | "completed" | "failed"; data: Record<string, unknown> };
export function activityCounts(state: ActivityState | null) {
  if (!state) return null;
  const mainPhotos = state.lots.reduce((n, lot) => n + lot.main.length, 0);
  const extraPhotos = state.lots.reduce((n, lot) => n + lot.extra.length, 0);
  return { lots: state.lots.length, photos: mainPhotos + extraPhotos, mainPhotos, extraPhotos };
}
export function observeActivity(before: ActivityState | null, after: ActivityState) {
  const base = { beforeCounts: activityCounts(before), afterCounts: activityCounts(after), uploadLogo: after.logo,
    cameraStamp: after.lots.some(l => [...l.main, ...l.extra].some(p => p.camera)) ? "camera_reported" : "not_recorded", captureMode: after.mode };
  const events: Array<{ action: string; outcome: DeviceActivity["outcome"]; data: Record<string, unknown> }> = [];
  const add = (action: string, data = {}, outcome: DeviceActivity["outcome"] = "completed") => events.push({ action, outcome, data: { ...base, ...data } });
  if (!before) add("history_started");
  const old = new Map((before?.lots || []).map((lot, index) => [lot.id, { lot, index }]));
  const next = new Map(after.lots.map((lot, index) => [lot.id, { lot, index }]));
  for (const id of new Set([...old.keys(), ...next.keys()])) {
    const a = old.get(id), b = next.get(id);
    const detail = { id, lotNumber: b?.lot.lotNumber || a?.lot.lotNumber || "",
      beforePosition: a?.index ?? null, afterPosition: b?.index ?? null,
      beforeCover: a?.lot.cover ?? null, afterCover: b?.lot.cover ?? null,
      before: a ? { mainPhotos: a.lot.main.length, extraPhotos: a.lot.extra.length } : null,
      after: b ? { mainPhotos: b.lot.main.length, extraPhotos: b.lot.extra.length } : null };
    if (!a || !b) add(a ? "lot_removed" : "lot_added", { lots: [detail] });
    else {
      if (a.index !== b.index) add("lots_reordered", { lots: [detail] });
      if (a.lot.cover !== b.lot.cover) add("cover_changed", { lots: [detail] });
    }
    for (const slot of ["main", "extra"] as const) {
      const previous = new Map((a?.lot[slot] || []).map((p, i) => [p.id, { ...p, i }]));
      const current = new Map((b?.lot[slot] || []).map((p, i) => [p.id, { ...p, i }]));
      const groups = new Map<string, Array<{ id: string; slot: string; before: number | null; after: number | null }>>();
      for (const photo of new Set([...previous.keys(), ...current.keys()])) {
        const p = previous.get(photo), q = current.get(photo);
        if (p?.i === q?.i) continue;
        const action = !q ? "photos_removed" : !p ? q.camera ? "photo_captured" : "photos_imported" : "photos_reordered";
        const changes = groups.get(action) || [];
        changes.push({ id: photo, slot, before: p?.i ?? null, after: q?.i ?? null }); groups.set(action, changes);
      }
      for (const [action, photos] of groups) for (let i = 0; i < photos.length; i += 100)
        add(action, { lots: [{ ...detail, photos: photos.slice(i, i + 100) }] });
    }
  }
  if (before && before.activeLot !== after.activeLot && after.activeLot) add("next_lot", { fromLotId: before.activeLot, toLotId: after.activeLot });
  if (before && before.logo !== after.logo) add("logo_changed");
  if (before && before.mode !== after.mode) add("capture_mode_changed");
  if (before?.status !== after.status) {
    const action = ({ ready: "submission_requested", uploading: "upload_started", paused: "cancelled", cancelled: "cancelled", failed: "submission_requested", discarded: "draft_deleted" } as Record<string, string>)[after.status];
    if (action) add(action, {}, after.status === "failed" ? "failed" : ["ready", "uploading"].includes(after.status) ? "requested" : "completed");
  }
  // Unchanged periodic/text autosaves do not create per-keystroke history.
  if (events.length) add("draft_saved");
  return events;
}
export function activityBatch<T>(events: T[], maxBytes = 250 * 1024): T[] {
  const batch: T[] = []; let bytes = 14;
  for (const event of events.slice(0, 100)) {
    // UTF-8 upper bound works in Hermes without TextEncoder.
    const size = JSON.stringify(event).length * 3 + 1;
    if (bytes + size > maxBytes) break;
    batch.push(event); bytes += size;
  }
  return batch;
}

