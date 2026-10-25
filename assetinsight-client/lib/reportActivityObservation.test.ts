import { test, expect } from "vitest";
import { activityCounts, observeActivity, activityBatch, type ActivityState } from "./reportActivityObservation";
const state = (count = 2): ActivityState => ({ lots: [{ id: "lot-one", lotNumber: "157", main: Array.from({ length: count }, (_, i) => ({ id: `photo-${i}`, camera: i === 0 })), extra: [{ id: "report-only", camera: false }], cover: 0 }], activeLot: "lot-one", logo: false, mode: "offline", status: "local" });
test.each([0, 1, 100, 200, 4999])("records %i main photos without private data or repeated manifests", count => {
  const after = state(count), events = observeActivity(null, after);
  expect(activityCounts(after)).toEqual({ lots: 1, photos: count + 1, mainPhotos: count, extraPhotos: 1 });
  expect(events.filter(e => ["photo_captured", "photos_imported"].includes(e.action)).flatMap(e => (e.data.lots as any[]).flatMap(l => l.photos))).toHaveLength(count + 1);
  expect(events.every(e => !(e.data.lots as any[])?.some(l => l.photos?.length > 100))).toBe(true);
  expect(observeActivity(after, after)).toEqual([]);
});
test("records count changes, original positions, cover change and Next Lot", () => {
  const before = state(), after = state(); after.lots[0].main.reverse(); after.lots[0].extra = []; after.lots[0].cover = 1;
  after.lots.push({ id: "lot-two", lotNumber: "158", main: [], extra: [], cover: null }); after.activeLot = "lot-two";
  const events = observeActivity(before, after);
  expect(events.map(e => e.action)).toEqual(expect.arrayContaining(["photos_reordered", "photos_removed", "cover_changed", "lot_added", "next_lot"]));
  const removal: any = events.find(e => e.action === "photos_removed");
  expect(removal.data.lots[0].photos).toEqual([{ id: "report-only", slot: "extra", before: 0, after: null }]);
  expect(observeActivity(after, { ...after, lots: [] }).map(e => e.action)).toContain("lot_removed");
});
test("does not conflate a logo choice with stamping or a submit request with acceptance", () => {
  const before = state(), after = { ...state(), logo: true, status: "ready" };
  const events = observeActivity(before, after);
  expect(events.find(e => e.action === "submission_requested")?.outcome).toBe("requested");
  expect(events.find(e => e.action === "logo_changed")?.data).toMatchObject({ uploadLogo: true, cameraStamp: "camera_reported" });
  expect(observeActivity(after, { ...after, status: "failed" }).find(e => e.action === "submission_requested")?.outcome).toBe("failed");
});
test("bounds UTF-8 batches by count and bytes without altering original events", () => {
  const events = Array.from({ length: 200 }, (_, i) => ({ id: i, text: "é".repeat(2000) }));
  const batch = activityBatch(events);
  expect(batch.length).toBeLessThanOrEqual(100);
  expect(Buffer.byteLength(JSON.stringify({ events: batch }))).toBeLessThanOrEqual(256 * 1024);
  expect(events).toHaveLength(200);
});

