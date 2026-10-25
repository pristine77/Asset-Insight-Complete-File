import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

const graph = vi.hoisted(() => ({ post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
const token = vi.hoisted(() => vi.fn());
vi.mock("axios", () => ({ default: graph }));
vi.mock("../src/service/msOutlookCalendarService.js", () => ({
  getValidMicrosoftAccessTokenForUser: token,
  MS_GRAPH_API_BASE: "https://graph.example.invalid",
}));
import User from "../src/models/user.model.js";
import CrmLead from "../src/models/crmLead.model.js";
import { runCrmFollowUpOutlookSync, syncCrmFollowUpOutlookEvent } from "../src/service/crmFollowUpOutlookService.js";
import { requestCrmFollowUpOutlookSync } from "../src/service/crmFollowUpService.js";
import { deleteReservedCrmLeads, releaseCrmLeadDeletion, reserveCrmLeadDeletion } from "../src/service/crmLeadDeletionService.js";

const NOW = new Date("2026-10-13T12:00:00Z");
let mongo: MongoMemoryServer;
let userId: mongoose.Types.ObjectId;
let leadId: mongoose.Types.ObjectId;
const load = () => CrmLead.findById(leadId).select("+followUpOutlookOperation").lean() as Promise<any>;
const sync = (now = NOW) => syncCrmFollowUpOutlookEvent(String(leadId), now);
const deferred = () => {
  let resolve!: (value: any) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function change(extra: Record<string, unknown> = {}) {
  const lead = await CrmLead.findById(leadId);
  lead!.set({ followUpDate: "2026-10-22", followUpAt: new Date("2026-10-22T06:00:00Z"), ...extra });
  requestCrmFollowUpOutlookSync(lead, NOW);
  await lead!.save();
}
async function existingEvent() {
  await CrmLead.updateOne({ _id: leadId }, { $set: { "followUpOutlook.eventId": "event-1", "followUpOutlook.userId": userId } });
}
beforeAll(async () => { mongo = await MongoMemoryServer.create(); await mongoose.connect(mongo.getUri()); });
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  vi.clearAllMocks();
  token.mockReset().mockResolvedValue("synthetic-token");
  graph.post.mockReset().mockResolvedValue({ status: 201, data: { id: "event-1" } });
  graph.patch.mockReset().mockResolvedValue({ status: 200, data: { id: "event-1" } });
  graph.delete.mockReset().mockResolvedValue({ status: 204 });
  userId = new mongoose.Types.ObjectId(); leadId = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: userId, msOutlookCalendarConnected: true, isBlocked: false, isCrmAgent: true } as any);
  await CrmLead.collection.insertOne({
    _id: leadId, assignedTo: userId, assignedBy: userId, status: "contacted", clientName: "Synthetic follow-up",
    followUpDate: "2026-10-20", followUpTimeZone: "America/Regina", followUpAt: new Date("2026-10-20T06:00:00Z"),
    followUpOutlook: { version: 1, changeId: "original", syncPending: true, nextAttemptAt: NOW },
  } as any);
});

it("serializes an old in-flight create and a newer manual/sweep request without orphaning either receipt", async () => {
  const first = deferred(); graph.post.mockImplementationOnce(() => first.promise);
  const older = sync();
  await vi.waitFor(() => expect(graph.post).toHaveBeenCalledTimes(1));
  await change();
  expect(await sync()).toMatchObject({ status: "pending" });
  await runCrmFollowUpOutlookSync({ now: NOW });
  expect(graph.post).toHaveBeenCalledTimes(1);
  first.resolve({ data: { id: "event-1" } });
  expect(await older).toMatchObject({ status: "synced", eventId: "event-1" });
  expect(graph.post).toHaveBeenCalledTimes(1);
  expect(graph.patch).toHaveBeenCalledTimes(1);
  expect(graph.patch.mock.calls[0][1].start.dateTime).toBe("2026-10-22T00:00:00");
  expect((await load()).followUpOutlook).toMatchObject({ version: 2, eventId: "event-1", syncPending: false });
});

it("never lets a later patch overtake a paused earlier patch", async () => {
  await existingEvent();
  const first = deferred(); graph.patch.mockImplementationOnce(() => first.promise);
  const older = sync();
  await vi.waitFor(() => expect(graph.patch).toHaveBeenCalledTimes(1));
  await change();
  expect(await sync()).toMatchObject({ status: "pending" });
  expect(graph.patch).toHaveBeenCalledTimes(1);
  first.resolve({ data: { id: "event-1" } });
  await older;
  expect(graph.patch).toHaveBeenCalledTimes(2);
  expect(graph.patch.mock.calls[1][1].start.dateTime).toBe("2026-10-22T00:00:00");
  expect((await load()).followUpOutlook.syncPending).toBe(false);
});

it.each([{ msOutlookCalendarConnected: false }, { isBlocked: true }, { isCrmAgent: false }, { isReviewAccount: true }])(
  "does not admit a provider write if access changes during token refresh: %j", async changed => {
    const refresh = deferred(); token.mockImplementationOnce(() => refresh.promise);
    const pending = sync();
    await vi.waitFor(() => expect(token).toHaveBeenCalledTimes(1));
    await User.collection.updateOne({ _id: userId }, { $set: changed });
    refresh.resolve("synthetic-token");
    expect(await pending).toMatchObject({ status: "failed", error: expect.stringContaining("access changed") });
    expect(graph.post).not.toHaveBeenCalled();
    expect((await load()).followUpOutlookOperation.state).toBe("prepared");
  }
);

it("never pairs an old owner's webLink with another worker's newer event receipt", async () => {
  const nextOwner = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: nextOwner, msOutlookCalendarConnected: true, isCrmAgent: true } as any);
  const first = deferred(); graph.post.mockImplementationOnce(() => first.promise)
    .mockResolvedValue({ data: { id: "new-owner-event", webLink: "https://outlook.test/new-owner" } });
  const older = sync();
  await vi.waitFor(() => expect(graph.post).toHaveBeenCalledTimes(1));
  await change({ assignedTo: nextOwner });
  const original = CrmLead.updateOne.bind(CrmLead);
  const write = vi.spyOn(CrmLead, "updateOne").mockImplementation(((filter: any, update: any) => {
    const execution = original(filter, update);
    if (update.$set?.["followUpOutlook.eventId"] === "old-owner-event" && !filter.assignedTo) {
      return execution.then(async result => { await sync(); return result; });
    }
    return execution;
  }) as any);
  try {
    first.resolve({ data: { id: "old-owner-event", webLink: "https://outlook.test/old-owner" } });
    expect(await older).toEqual({ status: "synced", eventId: "new-owner-event", userId: String(nextOwner), webLink: undefined });
    expect(graph.post).toHaveBeenCalledTimes(2);
    expect(graph.delete).toHaveBeenCalledTimes(1);
  } finally { write.mockRestore(); }
});

it("keeps the old owner's delete receipt until deletion finishes, then creates for the new owner", async () => {
  await existingEvent();
  const nextOwner = new mongoose.Types.ObjectId();
  await User.collection.insertOne({ _id: nextOwner, msOutlookCalendarConnected: true, isCrmAgent: true } as any);
  await change({ assignedTo: nextOwner });
  const removal = deferred(); graph.delete.mockImplementationOnce(() => removal.promise);
  graph.post.mockResolvedValue({ data: { id: "new-owner-event" } });
  const first = sync();
  await vi.waitFor(() => expect(graph.delete).toHaveBeenCalledTimes(1));
  await change({ followUpDate: "2026-10-23" });
  expect(await sync()).toMatchObject({ status: "pending" });
  expect((await load()).followUpOutlook.eventId).toBe("event-1");
  expect(graph.post).not.toHaveBeenCalled();
  removal.resolve({ status: 204 });
  await first;
  const saved = await load();
  expect(saved.followUpOutlook.eventId).toBe("new-owner-event");
  expect(String(saved.followUpOutlook.userId)).toBe(String(nextOwner));
  expect(graph.delete).toHaveBeenCalledTimes(1);
  expect(graph.post).toHaveBeenCalledTimes(1);
});

it("records a create that completes after clear, then deletes that exact event without recreating it", async () => {
  const first = deferred(); graph.post.mockImplementationOnce(() => first.promise);
  const creating = sync();
  await vi.waitFor(() => expect(graph.post).toHaveBeenCalledTimes(1));
  await change({ followUpDate: undefined, followUpAt: undefined });
  expect(await sync()).toMatchObject({ status: "pending" });
  first.resolve({ data: { id: "event-1" } });
  await creating;
  expect(graph.delete.mock.calls[0][0]).toMatch(/\/event-1$/);
  expect((await load()).followUpOutlook).toMatchObject({ syncPending: false });
  expect((await load()).followUpOutlook.eventId).toBeUndefined();
});

it("does not reclaim an expired sending operation, but accepts the original late receipt safely", async () => {
  const first = deferred(); graph.post.mockImplementationOnce(() => first.promise);
  const sending = sync();
  await vi.waitFor(() => expect(graph.post).toHaveBeenCalledTimes(1));
  await change();
  expect(await sync(new Date(NOW.getTime() + 11 * 60_000))).toMatchObject({ status: "pending", message: expect.stringContaining("did not confirm") });
  expect((await load()).followUpOutlookOperation.state).toBe("uncertain");
  expect(graph.post).toHaveBeenCalledTimes(1);
  first.resolve({ data: { id: "event-1" } });
  await sending;
  expect((await load()).followUpOutlookOperation).toBeUndefined();
  expect(graph.patch).toHaveBeenCalledTimes(1);
});

it.each(["create", "update", "delete"])("retains uncertain %s operations across a desired change and repeated sweeps", async (kind) => {
  if (kind !== "create") await existingEvent();
  if (kind === "delete") await change({ followUpDate: undefined, followUpAt: undefined });
  const mock = kind === "create" ? graph.post : kind === "update" ? graph.patch : graph.delete;
  mock.mockRejectedValueOnce(new Error("socket closed after sending"));
  expect(await sync()).toMatchObject({ status: "pending", message: expect.stringContaining("did not confirm") });
  const original = (await load()).followUpOutlookOperation;
  await change();
  await sync();
  await runCrmFollowUpOutlookSync({ now: new Date(NOW.getTime() + 86_400_000) });
  const retained = (await load()).followUpOutlookOperation;
  expect(retained).toMatchObject({ id: original.id, state: "uncertain", kind });
  expect(mock).toHaveBeenCalledTimes(1);
  expect((await load()).followUpOutlook.syncPending).toBe(true);
});

it.each([{}, { id: "" }])("does not count a malformed successful create receipt as synchronized: %j", async (data) => {
  graph.post.mockResolvedValueOnce({ data });
  expect(await sync()).toMatchObject({ status: "pending" });
  expect(await load()).toMatchObject({ followUpOutlook: { syncPending: true }, followUpOutlookOperation: { state: "uncertain" } });
  expect((await load()).followUpOutlook.eventId).toBeUndefined();
});

it("rejects an update receipt for a different event and retains the known event", async () => {
  await existingEvent(); graph.patch.mockResolvedValueOnce({ data: { id: "wrong-event" } });
  expect(await sync()).toMatchObject({ status: "pending" });
  expect(await load()).toMatchObject({ followUpOutlook: { eventId: "event-1" }, followUpOutlookOperation: { state: "uncertain" } });
});

it("retries a definite rate rejection using the same durable create identity", async () => {
  graph.post.mockRejectedValueOnce(Object.assign(new Error("rate limited"), { response: { status: 429 } }));
  expect(await sync()).toMatchObject({ status: "failed" });
  const id = (await load()).followUpOutlookOperation.id;
  await sync(new Date(NOW.getTime() + 6 * 60_000));
  expect(graph.post).toHaveBeenCalledTimes(2);
  expect(graph.post.mock.calls[1][1].transactionId).toBe(graph.post.mock.calls[0][1].transactionId);
  expect(graph.post.mock.calls[1][1].transactionId).toContain(id);
  expect((await load()).followUpOutlook.syncPending).toBe(false);
});

it("retires a definitely rejected unsent intent when a newer clear supersedes it", async () => {
  graph.post.mockRejectedValueOnce(Object.assign(new Error("rate limited"), { response: { status: 429 } }));
  await sync();
  await change({ followUpDate: undefined, followUpAt: undefined });
  expect(await sync()).toMatchObject({ status: "synced" });
  expect(graph.post).toHaveBeenCalledTimes(1);
  expect((await load()).followUpOutlookOperation).toBeUndefined();
});

it("does not forget a known event when its owner disconnected before reassignment cleanup", async () => {
  await existingEvent();
  await User.updateOne({ _id: userId }, { $set: { msOutlookCalendarConnected: false } });
  await change({ followUpDate: undefined, followUpAt: undefined });
  expect(await sync()).toMatchObject({ status: "failed", error: expect.stringContaining("original Outlook") });
  expect(await load()).toMatchObject({ followUpOutlook: { eventId: "event-1", syncPending: true }, followUpOutlookOperation: { kind: "delete" } });
  expect(graph.delete).not.toHaveBeenCalled();
});

it("fences simultaneous document saves even when both use the same numeric version", async () => {
  const firstDoc = await CrmLead.findById(leadId); const secondDoc = await CrmLead.findById(leadId);
  requestCrmFollowUpOutlookSync(firstDoc, NOW); await firstDoc!.save();
  const first = deferred(); graph.post.mockImplementationOnce(() => first.promise);
  const sending = sync(); await vi.waitFor(() => expect(graph.post).toHaveBeenCalledTimes(1));
  secondDoc!.set("followUpDate", "2026-10-24"); requestCrmFollowUpOutlookSync(secondDoc, NOW); await secondDoc!.save();
  expect(firstDoc!.followUpOutlook!.version).toBe(secondDoc!.followUpOutlook!.version);
  expect(firstDoc!.followUpOutlook!.changeId).not.toBe(secondDoc!.followUpOutlook!.changeId);
  first.resolve({ data: { id: "event-1" } }); await sending;
  expect(graph.patch.mock.calls[0][1].start.dateTime).toBe("2026-10-24T00:00:00");
});

it("keeps operation payloads out of ordinary lead reads", async () => {
  graph.post.mockRejectedValueOnce(new Error("lost receipt")); await sync();
  const ordinary: any = await CrmLead.findById(leadId).lean();
  expect(ordinary.followUpOutlookOperation).toBeUndefined();
  expect((await load()).followUpOutlookOperation.payload).toBeDefined();
});

it("refuses lead and whole-batch deletion while a follow-up or unresolved operation exists", async () => {
  const clean = await CrmLead.create({ clientName: "Other retained lead", assignedTo: userId, assignedBy: userId });
  expect(await reserveCrmLeadDeletion([leadId])).toBeUndefined();
  expect(await reserveCrmLeadDeletion([clean._id, leadId])).toBeUndefined();
  expect(await CrmLead.countDocuments()).toBe(2);
  expect((await CrmLead.findById(clean._id).select("+crmDeletionToken").lean())!.crmDeletionToken).toBeUndefined();
  graph.post.mockRejectedValueOnce(new Error("lost receipt")); await sync();
  await change({ followUpDate: undefined, followUpAt: undefined });
  expect(await reserveCrmLeadDeletion([leadId])).toBeUndefined();
  expect((await load()).followUpOutlookOperation.state).toBe("uncertain");
});

it("fences a stale follow-up save and provider admission while admin deletion owns the exact row", async () => {
  await CrmLead.updateOne({ _id: leadId }, { $unset: { followUpDate: 1, followUpAt: 1, followUpOutlook: 1 } });
  const stale = await CrmLead.findById(leadId);
  const token = await reserveCrmLeadDeletion([leadId]);
  expect(token).toBeDefined();
  stale!.set({ followUpDate: "2026-10-20", followUpAt: new Date("2026-10-20T06:00:00Z") });
  requestCrmFollowUpOutlookSync(stale, NOW);
  await expect(stale!.save()).rejects.toThrow();
  expect(await sync()).toMatchObject({ status: "pending" });
  expect(graph.post).not.toHaveBeenCalled();
  expect(await deleteReservedCrmLeads([leadId], "wrong-token")).toBe(0);
  expect(await deleteReservedCrmLeads([leadId], token!)).toBe(1);
  await releaseCrmLeadDeletion(token!);
});

it("deletes only the reserved batch snapshot, retaining new rows that arrive later", async () => {
  await CrmLead.updateOne({ _id: leadId }, { $unset: { followUpDate: 1, followUpAt: 1, followUpOutlook: 1 } });
  const token = await reserveCrmLeadDeletion([leadId]);
  const later = await CrmLead.create({ clientName: "Later lead", assignedTo: userId, assignedBy: userId });
  expect(await deleteReservedCrmLeads([leadId], token!)).toBe(1);
  expect(await CrmLead.exists({ _id: later._id })).toBeTruthy();
});
