import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startReportActivitySync } from "./reportActivitySync";
const mocks = vi.hoisted(() => ({ post: vi.fn(), pending: vi.fn(), acknowledge: vi.fn() }));
vi.mock("@/lib/api", () => ({ default: { post: mocks.post } }));
vi.mock("@/components/forms/drafts/storage", () => ({ pendingBrowserActivity: mocks.pending, acknowledgeBrowserActivity: mocks.acknowledge }));
let stop: (() => void) | undefined;
const events = [{ eventId: "same-event", activityId: "draft-one", action: "photos_imported" }];
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  mocks.pending.mockResolvedValue(events); mocks.acknowledge.mockResolvedValue(undefined);
});
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); });
describe("foreground operational activity sync", () => {
  it("reuses exact events after a lost response and clears only acknowledged IDs", async () => {
    mocks.post.mockRejectedValueOnce(new Error("lost response")).mockResolvedValueOnce({ data: { data: { acknowledgements: [{ eventId: "same-event" }, { eventId: "not-sent" }] } } });
    mocks.pending.mockResolvedValueOnce(events).mockResolvedValueOnce(events).mockResolvedValue([]);
    stop = startReportActivitySync("owner-one"); await vi.advanceTimersByTimeAsync(0);
    expect(mocks.acknowledge).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30000);
    expect(mocks.post).toHaveBeenNthCalledWith(2, "/report-activity/events", { ownerId: "owner-one", events }, expect.any(Object));
    expect(mocks.acknowledge).toHaveBeenCalledExactlyOnceWith("owner-one", ["same-event"]);
    expect(mocks.post.mock.calls.every(([url]) => url === "/report-activity/events")).toBe(true);
  });
  it("stops account work and rejects a late acknowledgement after cleanup", async () => {
    let resolve!: (value: unknown) => void;
    mocks.post.mockReturnValue(new Promise(done => { resolve = done; }));
    stop = startReportActivitySync("owner-one"); await vi.advanceTimersByTimeAsync(0);
    const signal = mocks.post.mock.calls[0][2].signal as AbortSignal;
    stop(); expect(signal.aborted).toBe(true);
    resolve({ data: { data: { acknowledgements: [{ eventId: "same-event" }] } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.acknowledge).not.toHaveBeenCalled();
  });
  it("does not send while offline or hidden and wakes only for metadata", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    stop = startReportActivitySync("owner-one"); await vi.advanceTimersByTimeAsync(30000);
    expect(mocks.post).not.toHaveBeenCalled();
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    window.dispatchEvent(new Event("online")); await vi.advanceTimersByTimeAsync(0);
    expect(mocks.post).not.toHaveBeenCalled();
    mocks.post.mockResolvedValue({ data: { data: { acknowledgements: [] } } });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(0);
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith("/report-activity/events", { ownerId: "owner-one", events }, expect.any(Object));
  });
});
