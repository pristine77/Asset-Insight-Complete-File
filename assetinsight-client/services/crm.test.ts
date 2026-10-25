import { beforeEach, describe, expect, it, vi } from "vitest";
import API from "@/lib/api";
import {
  CrmService, CRM_READ_TIMEOUT_MS, crmErrorMessage, crmStatusChange,
  escapeCrmSearchQuery, isCrmId, safeCrmUrl,
} from "./crm";

vi.mock("@/lib/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() },
}));

const taskId = "69209256be08b81c6d33e76f";
const updateId = "69209256be08b81c6d33e770";
const agentId = "69209256be08b81c6d33e771";
const item = { _id: taskId, clientName: "A (Plant) + B", status: "contacted", updateCount: 201 };
const page = {
  items: [item], total: 240, page: 1, limit: 20,
  statusCounts: [{ _id: "contacted", count: 200 }],
  leadSourceCounts: { total: 240, generic: 210, organic: 30 },
};

beforeEach(() => vi.resetAllMocks());

describe("CRM read contracts", () => {
  it("requests bounded summaries with literal search and preserves all server totals", async () => {
    vi.mocked(API.get).mockResolvedValueOnce({ data: page });
    const controller = new AbortController();
    const result = await CrmService.getMyTasks({ q: " A (Plant) + B ", status: "all", limit: 20 }, { signal: controller.signal });
    expect(API.get).toHaveBeenCalledExactlyOnceWith("/crm/tasks/my", {
      signal: controller.signal, timeout: CRM_READ_TIMEOUT_MS,
      params: { q: "A \\(Plant\\) \\+ B", status: "all", page: 1, limit: 20, view: "summary" },
    });
    expect(result).toEqual(page);
    expect(result.leadSourceCounts?.organic).toBe(30);
    expect(result.items[0].updateCount).toBe(201);
  });

  it("leaves unavailable aggregate counts unknown instead of deriving them from one page", async () => {
    vi.mocked(API.get).mockResolvedValueOnce({ data: { items: [item], total: 240, page: 1, limit: 20 } });
    const result = await CrmService.getMyTasks();
    expect(result.statusCounts).toBeUndefined();
    expect(result.leadSourceCounts).toBeUndefined();
  });

  it("bounds the list size and reads details without loading history", async () => {
    vi.mocked(API.get).mockResolvedValueOnce({ data: page }).mockResolvedValueOnce({ data: { item: { ...item, importData: { evidence: "saved" } } } });
    await CrmService.getMyTasks({ page: -10, limit: 10_000 });
    const controller = new AbortController();
    const detail = await CrmService.getTask(taskId, { signal: controller.signal });
    expect(vi.mocked(API.get).mock.calls[0][1]?.params).toMatchObject({ page: 1, limit: 200, view: "summary" });
    expect(API.get).toHaveBeenLastCalledWith(`/crm/tasks/${taskId}`, { signal: controller.signal, timeout: CRM_READ_TIMEOUT_MS });
    expect(detail.importData).toEqual({ evidence: "saved" });
    expect(detail.updates).toBeUndefined();
    expect(API.get).toHaveBeenCalledTimes(2);
  });

  it("keeps paginated history order, deletion tombstones, author and total exactly as served", async () => {
    const history = { items: [
      { _id: updateId, status: "contacted", createdAt: "2026-09-23T12:00:00Z", isDeleted: true, createdBy: { _id: agentId } },
      { _id: taskId, status: "new_lead", createdAt: "2026-09-22T12:00:00Z", comment: "Previous note", attachmentUrls: ["https://media.example.test/original.jpg"] },
    ], total: 201, page: 3, limit: 50 };
    vi.mocked(API.get).mockResolvedValueOnce({ data: history });
    const controller = new AbortController();
    await expect(CrmService.getTaskUpdates(taskId, { page: 3, limit: 1000 }, { signal: controller.signal })).resolves.toEqual(history);
    expect(API.get).toHaveBeenCalledExactlyOnceWith(`/crm/tasks/${taskId}/updates`, {
      signal: controller.signal, timeout: CRM_READ_TIMEOUT_MS, params: { page: 3, limit: 50 },
    });
  });

  it.each([{}, { items: [], total: "0", page: 1, limit: 20 }, { items: [], total: -1, page: 1, limit: 20 }])("rejects an incomplete page instead of showing zero tasks: %j", async (data) => {
    vi.mocked(API.get).mockResolvedValueOnce({ data });
    await expect(CrmService.getMyTasks()).rejects.toThrow("incomplete CRM page");
  });

  it("passes through access loss without retries or pretending the task is empty", async () => {
    const failure = { response: { status: 403, data: { message: "CRM access is not enabled" } } };
    vi.mocked(API.get).mockRejectedValueOnce(failure);
    await expect(CrmService.getTask(taskId)).rejects.toBe(failure);
    expect(API.get).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe task identifiers before making requests", async () => {
    await expect(CrmService.getTask("../admin/users")).rejects.toThrow("Invalid CRM record ID");
    await expect(CrmService.getTaskUpdates("x?userId=other")).rejects.toThrow("Invalid CRM record ID");
    expect(API.get).not.toHaveBeenCalled();
  });
});

describe("CRM writes", () => {
  it("uploads original browser files in order and omits unchanged workflow fields", async () => {
    vi.mocked(API.patch).mockResolvedValueOnce({ data: { item } });
    const first = new File(["first"], "first.jpg", { type: "image/jpeg" });
    const second = new File(["second"], "second.pdf", { type: "application/pdf" });
    const recording = new File(["voice"], "voice.webm", { type: "audio/webm" });
    await CrmService.submitTaskUpdate(taskId, {
      comment: "  Contact called back.  ", ...crmStatusChange("contacted", "contacted"),
      attachments: [first, second], recording,
    });
    const [url, form, config] = vi.mocked(API.patch).mock.calls[0];
    expect(url).toBe(`/crm/tasks/${taskId}/update`);
    expect(form).toBeInstanceOf(FormData);
    expect((form as FormData).get("comment")).toBe("Contact called back.");
    expect((form as FormData).has("status")).toBe(false);
    expect((form as FormData).has("lostReason")).toBe(false);
    expect((form as FormData).getAll("attachments").map((file) => (file as File).name)).toEqual(["first.jpg", "second.pdf"]);
    expect(((form as FormData).get("recording") as File).name).toBe("voice.webm");
    expect(config).toEqual({ _retry: true });
    expect(config?.headers).toBeUndefined();
  });

  it("refuses excess and empty attachments before upload", async () => {
    const file = new File(["photo"], "photo.jpg");
    await expect(CrmService.submitTaskUpdate(taskId, { attachments: Array.from({ length: 11 }, () => file) })).rejects.toThrow("no more than 10");
    await expect(CrmService.submitTaskUpdate(taskId, { recording: new File([], "empty.webm") })).rejects.toThrow("nonempty");
    expect(API.patch).not.toHaveBeenCalled();
  });

  it.each([401, 409, 500])("does not retry quick-add after status %s", async (status) => {
    const failure = { response: { status, data: { message: "Not accepted" } } };
    vi.mocked(API.post).mockRejectedValueOnce(failure);
    const payload = { name: "Prospect", phone: "4035550123", specialization: "others" as const };
    await expect(CrmService.quickAddLead(payload)).rejects.toBe(failure);
    expect(API.post).toHaveBeenCalledExactlyOnceWith("/crm/tasks/quick-add", payload, { _retry: true });
  });

  it("edits comments without introducing status and removes only explicitly selected media", async () => {
    vi.mocked(API.patch).mockResolvedValueOnce({ data: { item } });
    vi.mocked(API.delete).mockResolvedValue({ data: { item } });
    const url = "https://media.example.test/original.jpg?signature=original%2Fvalue";
    await CrmService.editTaskUpdate(taskId, updateId, { comment: "Corrected spelling" });
    await CrmService.deleteTaskUpdateAttachments(taskId, updateId, [url]);
    await CrmService.deleteTaskUpdateRecording(taskId, updateId);
    await CrmService.deleteTaskUpdate(taskId, updateId);
    expect(API.patch).toHaveBeenCalledExactlyOnceWith(`/crm/tasks/${taskId}/updates/${updateId}`, { comment: "Corrected spelling" }, { _retry: true });
    expect(API.delete).toHaveBeenNthCalledWith(1, `/crm/tasks/${taskId}/updates/${updateId}/attachments`, { _retry: true, data: { urls: [url] } });
    expect(API.delete).toHaveBeenNthCalledWith(2, `/crm/tasks/${taskId}/updates/${updateId}/recording`, { _retry: true });
    expect(API.delete).toHaveBeenNthCalledWith(3, `/crm/tasks/${taskId}/updates/${updateId}`, { _retry: true });
  });

  it("never treats an empty attachment selection as remove-all", async () => {
    await expect(CrmService.deleteTaskUpdateAttachments(taskId, updateId, [])).rejects.toThrow("Select the attachment");
    expect(API.delete).not.toHaveBeenCalled();
  });

  it("returns transcription/rewrite only on explicit calls and forwards cancellation without retries", async () => {
    vi.mocked(API.post).mockResolvedValueOnce({ data: { text: " Transcribed note " } }).mockResolvedValueOnce({ data: { subject: " Proposal ", body: " Hello client. " } });
    const audio = new File(["voice"], "note.webm", { type: "audio/webm" });
    const controller = new AbortController();
    await expect(CrmService.transcribeCommentAudio({ audio }, { signal: controller.signal })).resolves.toBe("Transcribed note");
    await expect(CrmService.rewriteEmailWithAI({ body: "Hello", subject: "Draft" }, { signal: controller.signal })).resolves.toEqual({ subject: "Proposal", body: "Hello client." });
    expect(API.post).toHaveBeenNthCalledWith(1, "/crm/tasks/comment/transcribe", expect.any(FormData), { _retry: true, signal: controller.signal });
    expect(API.post).toHaveBeenNthCalledWith(2, "/crm/tasks/email/rewrite", { body: "Hello", subject: "Draft" }, { _retry: true, signal: controller.signal });
    expect(API.post).toHaveBeenCalledTimes(2);
    expect(API.patch).not.toHaveBeenCalled();
  });

  it("does not invent a completed draft or record after a malformed mutation response", async () => {
    vi.mocked(API.post).mockResolvedValue({ data: {} });
    await expect(CrmService.quickAddLead({ name: "Prospect", phone: "4035550123", specialization: "others" })).rejects.toThrow("Refresh to check");
    await expect(CrmService.rewriteEmailWithAI({ body: "Original body" })).rejects.toThrow("did not return an email draft");
    expect(API.post).toHaveBeenCalledTimes(2);
  });

  it("updates only coverage and returns the canonical profile without another auth request", async () => {
    const profile = { _id: agentId, email: "agent@example.test", isCrmAgent: true, crmAddress: "Calgary", crmQuadrant: "NW,NE", crmSpecializations: ["others"] };
    vi.mocked(API.put).mockResolvedValueOnce({ data: profile });
    const input = { crmAddress: "Calgary", crmQuadrant: ["NW", "NE"], crmSpecializations: ["others"] };
    await expect(CrmService.updateCoverage(input)).resolves.toEqual(profile);
    expect(API.put).toHaveBeenCalledExactlyOnceWith("/user", input, { _retry: true });
    expect(API.get).not.toHaveBeenCalled();
  });
});

describe("CRM transfers and calendar", () => {
  it("bounds transfer reads and sends explicit request and response actions once", async () => {
    vi.mocked(API.get).mockResolvedValue({ data: { items: [{ _id: agentId }] } });
    vi.mocked(API.post).mockResolvedValue({ data: { item: { _id: updateId, status: "pending" } } });
    vi.mocked(API.patch).mockResolvedValue({ data: { item: { _id: updateId, status: "accepted" } } });
    const controller = new AbortController();
    await CrmService.listTransferAgents({ signal: controller.signal });
    await CrmService.getMyTransferRequests({ status: "pending" }, { signal: controller.signal });
    await CrmService.requestTaskTransfer(taskId, { toUserId: agentId, note: "Closer to agent" });
    await CrmService.respondToTransferRequest(updateId, "accept");
    expect(API.get).toHaveBeenNthCalledWith(1, "/crm/tasks/transfer/agents", { signal: controller.signal, timeout: CRM_READ_TIMEOUT_MS });
    expect(API.get).toHaveBeenNthCalledWith(2, "/crm/tasks/transfers/my", { signal: controller.signal, timeout: CRM_READ_TIMEOUT_MS, params: { status: "pending" } });
    expect(API.post).toHaveBeenCalledExactlyOnceWith(`/crm/tasks/${taskId}/transfer`, { toUserId: agentId, note: "Closer to agent" }, { _retry: true });
    expect(API.patch).toHaveBeenCalledExactlyOnceWith(`/crm/tasks/transfers/${updateId}`, { action: "accept" }, { _retry: true });
  });

  it("reuses Outlook connection endpoints with bounded reads and accepts only HTTP links", async () => {
    vi.mocked(API.get).mockResolvedValueOnce({ data: { connected: true, configured: true } }).mockResolvedValueOnce({ data: { authUrl: "https://login.microsoftonline.com/authorize?state=abc" } });
    vi.mocked(API.delete).mockResolvedValueOnce({ data: {} });
    vi.mocked(API.post).mockResolvedValueOnce({ data: { eventId: "event", webLink: "javascript:alert(1)" } });
    const controller = new AbortController();
    await CrmService.getOutlookCalendarStatus({ signal: controller.signal });
    expect(await CrmService.getOutlookCalendarAuthUrl({ signal: controller.signal })).toContain("https://login.microsoftonline.com/");
    await CrmService.disconnectOutlookCalendar();
    await expect(CrmService.addTaskToOutlookCalendar(taskId)).resolves.toEqual({ eventId: "event", webLink: undefined });
    expect(API.get).toHaveBeenNthCalledWith(1, "/crm/calendar/ms/outlook/status", { signal: controller.signal, timeout: CRM_READ_TIMEOUT_MS });
    expect(API.delete).toHaveBeenCalledExactlyOnceWith("/crm/calendar/ms/outlook/disconnect", { _retry: true });
    expect(API.post).toHaveBeenCalledExactlyOnceWith(`/crm/tasks/${taskId}/calendar/ms/outlook`, undefined, { _retry: true });
  });

  it("keeps partial bulk calendar results and never expands beyond selected task IDs", async () => {
    const result = { createdCount: 1, failedCount: 1, created: [{ taskId, eventId: "event", webLink: "https://outlook.office.com/calendar/item/1" }], failed: [{ taskId: updateId, reason: "Missing due date" }] };
    vi.mocked(API.post).mockResolvedValueOnce({ data: result });
    await expect(CrmService.addTasksToOutlookCalendarBulk([taskId, updateId])).resolves.toEqual(result);
    expect(API.post).toHaveBeenCalledExactlyOnceWith("/crm/tasks/calendar/ms/outlook/bulk", { taskIds: [taskId, updateId] }, { _retry: true });
    await expect(CrmService.addTasksToOutlookCalendarBulk([])).rejects.toThrow("between 1 and 100");
    await expect(CrmService.addTasksToOutlookCalendarBulk(Array.from({ length: 101 }, () => taskId))).rejects.toThrow("between 1 and 100");
    expect(API.post).toHaveBeenCalledTimes(1);
  });

  it("keeps an accepted Outlook sync pending without inventing an event or retrying", async () => {
    vi.mocked(API.post).mockResolvedValueOnce({ status: 202, data: { pending: true, message: "This follow-up is already queued for Outlook." } });
    await expect(CrmService.addTaskToOutlookCalendar(taskId)).resolves.toEqual({ pending: true, message: "This follow-up is already queued for Outlook." });
    expect(API.post).toHaveBeenCalledExactlyOnceWith(`/crm/tasks/${taskId}/calendar/ms/outlook`, undefined, { _retry: true });
  });

  it.each([
    { status: 202, data: {} },
    { status: 200, data: { pending: true } },
    { status: 202, data: { pending: "true" } },
    { status: 202, data: { pending: true, eventId: "not-confirmed" } },
    { status: 202, data: { pending: true, webLink: "https://outlook.office.com/event" } },
  ])("rejects contradictory pending receipts without confirming or replaying: %j", async (response) => {
    vi.mocked(API.post).mockResolvedValueOnce(response);
    await expect(CrmService.addTaskToOutlookCalendar(taskId)).rejects.toThrow("Check your calendar before trying again");
    expect(API.post).toHaveBeenCalledOnce();
  });

  it("accounts for pending bulk tasks separately from confirmed events", async () => {
    const result = { createdCount: 1, failedCount: 0, pendingCount: 1,
      created: [{ taskId, eventId: "confirmed-event", webLink: undefined }], failed: [],
      pending: [{ taskId: updateId, reason: "Sync already queued" }] };
    vi.mocked(API.post).mockResolvedValueOnce({ data: result });
    await expect(CrmService.addTasksToOutlookCalendarBulk([taskId, updateId])).resolves.toEqual(result);
    expect(API.post).toHaveBeenCalledOnce();
  });

  it.each([
    { pendingCount: 2, pending: [{ taskId, reason: "Queued" }] },
    { pendingCount: 1, pending: [{ taskId: agentId, reason: "Queued" }] },
    { pendingCount: 2, pending: [{ taskId, reason: "Queued" }, { taskId, reason: "Queued" }] },
    { pendingCount: 1, pending: [{ taskId, reason: "" }] },
    { pendingCount: 1, pending: [{ taskId, reason: "Queued", eventId: "unexpected" }] },
    { pendingCount: 1, pending: [{ taskId, reason: "Queued", webLink: "https://outlook.office.com/event" }] },
    { pendingCount: 1 },
    { pending: [] },
    { createdCount: 1, created: [{ taskId, eventId: "event" }], pendingCount: 1, pending: [{ taskId, reason: "Queued" }] },
  ])("rejects invalid or overlapping pending bulk receipts: %j", async (pending) => {
    vi.mocked(API.post).mockResolvedValueOnce({ data: { createdCount: 0, failedCount: 0, created: [], failed: [], ...pending } });
    await expect(CrmService.addTasksToOutlookCalendarBulk([taskId, updateId])).rejects.toThrow("calendar");
    expect(API.post).toHaveBeenCalledOnce();
  });

  it.each([
    {}, { connected: "false", configured: true }, { connected: false, configured: "true" },
    { connected: true }, { configured: false }, null,
  ])("rejects an invalid Outlook status instead of inventing connected/configured values: %j", async (data) => {
    vi.mocked(API.get).mockResolvedValueOnce({ data });
    await expect(CrmService.getOutlookCalendarStatus()).rejects.toThrow("invalid Outlook calendar status");
  });

  it.each([{}, { eventId: {} }, { eventId: "javascript:alert(1)", webLink: "javascript:alert(1)" }, { eventId: "\n", webLink: "//untrusted.test" }])("does not confirm a single calendar event without a valid identifier or link: %j", async (data) => {
    vi.mocked(API.post).mockResolvedValueOnce({ data });
    await expect(CrmService.addTaskToOutlookCalendar(taskId)).rejects.toThrow("Check your calendar before trying again");
    expect(API.post).toHaveBeenCalledOnce();
  });

  it.each([
    { createdCount: 2, failedCount: 0, created: [{ taskId, eventId: "event" }], failed: [] },
    { createdCount: 0, failedCount: 2, created: [], failed: [{ taskId, reason: "Rejected" }] },
    { createdCount: 1, failedCount: 0, created: [{ taskId: agentId, eventId: "event" }], failed: [] },
    { createdCount: 2, failedCount: 0, created: [{ taskId, eventId: "event" }, { taskId, eventId: "other" }], failed: [] },
    { createdCount: 1, failedCount: 1, created: [{ taskId, eventId: "event" }], failed: [{ taskId, reason: "Duplicated" }] },
    { createdCount: 1, failedCount: 0, created: [{ taskId }], failed: [] },
    { createdCount: 0, failedCount: 1, created: [], failed: [{ taskId, reason: { message: "object" } }] },
    { createdCount: 0, failedCount: 1, created: [], failed: [{ taskId, reason: "" }] },
    { createdCount: 1, failedCount: 0, created: [null], failed: [] },
  ])("rejects untrustworthy batch receipts without retrying: %j", async (data) => {
    vi.mocked(API.post).mockResolvedValueOnce({ data });
    await expect(CrmService.addTasksToOutlookCalendarBulk([taskId, updateId])).rejects.toThrow("calendar");
    expect(API.post).toHaveBeenCalledOnce();
  });

  it("preserves omitted IDs as unknown and accepts an event with only a safe link", async () => {
    vi.mocked(API.post).mockResolvedValueOnce({ data: { createdCount: 1, failedCount: 0, created: [{ taskId, webLink: "https://outlook.office.com/calendar/item/1" }], failed: [] } });
    const result = await CrmService.addTasksToOutlookCalendarBulk([taskId, updateId]);
    expect(result.createdCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(result.created).toEqual([{ taskId, eventId: undefined, webLink: "https://outlook.office.com/calendar/item/1" }]);
  });

  it("rejects duplicate selected calendar IDs before sending", async () => {
    await expect(CrmService.addTasksToOutlookCalendarBulk([taskId, taskId])).rejects.toThrow("only once");
    expect(API.post).not.toHaveBeenCalled();
  });
});

describe("CRM safety and workflow helpers", () => {
  it("escapes all regular expression operators so search matches the literal input", () => {
    const query = "A.*+?^${}()|[]\\B";
    const expression = new RegExp(escapeCrmSearchQuery(query));
    expect(expression.test(query)).toBe(true);
    expect(expression.test("Anything else B")).toBe(false);
  });

  it("omits unchanged stages including Lost and requires a reason for a new Lost decision", () => {
    expect(crmStatusChange("contacted", "contacted")).toEqual({});
    expect(crmStatusChange("lost", "lost", "competitor")).toEqual({});
    expect(crmStatusChange("contacted", "won", "timing")).toEqual({ status: "won" });
    expect(crmStatusChange("contacted", "lost", "timing")).toEqual({ status: "lost", lostReason: "timing" });
    expect(() => crmStatusChange("contacted", "lost")).toThrow("Select a reason");
  });

  it.each(["javascript:alert(1)", "data:text/html,evil", "//example.test", "https://user:secret@example.test", "/local", "https:\\example.test", "https://example.test/\nnext"])("does not render unsafe link %s", (value) => {
    expect(safeCrmUrl(value)).toBeUndefined();
  });

  it("accepts ordinary media links without accepting path-shaped record IDs", () => {
    expect(safeCrmUrl("https://media.example.test/photo.jpg?download=1")).toBe("https://media.example.test/photo.jpg?download=1");
    expect(isCrmId(taskId)).toBe(true);
    expect(isCrmId("tasks/other")).toBe(false);
  });

  it("keeps safe full error text and codes without rendering response objects", () => {
    const message = "Correct the requested stage.\n".repeat(100);
    expect(crmErrorMessage({ response: { data: { error: { message, code: "CRM_CONFLICT" } } } })).toBe(`${message.trim()} (CRM_CONFLICT)`);
    expect(crmErrorMessage({ response: { data: { message: { secret: "hidden" }, error: ["bad"] } } }, "Please retry")).toBe("Please retry");
    expect(crmErrorMessage({ response: { data: { message: "CRM_CONFLICT: already changed", code: "CRM_CONFLICT" } } })).toBe("CRM_CONFLICT: already changed");
  });
});
