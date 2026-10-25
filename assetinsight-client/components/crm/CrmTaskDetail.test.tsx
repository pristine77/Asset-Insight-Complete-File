import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CrmTaskItem, CrmTaskUpdateEntry } from "@/services/crm";
import CrmTaskDetail, { type CrmTaskDetailProps } from "./CrmTaskDetail";

const service = vi.hoisted(() => ({
  getTask: vi.fn(), getTaskUpdates: vi.fn(), submitTaskUpdate: vi.fn(), editTaskUpdate: vi.fn(),
  deleteTaskUpdate: vi.fn(), deleteTaskUpdateAttachments: vi.fn(), deleteTaskUpdateRecording: vi.fn(),
  listTransferAgents: vi.fn(), requestTaskTransfer: vi.fn(), getOutlookCalendarStatus: vi.fn(),
  addTaskToOutlookCalendar: vi.fn(), transcribeCommentAudio: vi.fn(), rewriteEmailWithAI: vi.fn(),
}));
vi.mock("@/services/crm", async (importOriginal) => ({ ...await importOriginal<typeof import("@/services/crm")>(), default: service }));

const ownerId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const taskId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const updateId = "cccccccccccccccccccccccc";
const otherId = "dddddddddddddddddddddddd";
const task: CrmTaskItem = { _id: taskId, clientName: "Alex Morgan", companyName: "Prairie Equipment Ltd.", email: "alex@example.test", phoneRaw: "306-555-0123", status: "inspection_required", createdAt: "2026-09-20T12:00:00Z", updatedAt: "2026-09-21T12:00:00Z", callAttempts: 2, updateCount: 2, notes: "Original lead notes", importData: { campaign: "Equipment", volume: 0 } };
const ownEntry: CrmTaskUpdateEntry = { _id: updateId, status: "contacted", comment: "Own earlier comment", createdBy: { _id: ownerId, username: "Agent" }, createdAt: "2026-09-20T12:00:00Z", attachmentUrls: ["https://files.example.test/evidence.pdf"], recordingUrl: "https://files.example.test/note.webm" };
const otherEntry: CrmTaskUpdateEntry = { _id: "eeeeeeeeeeeeeeeeeeeeeeee", status: "inspection_required", comment: "Other agent's comment", createdBy: { _id: otherId, username: "Jordan Lee" }, createdAt: "2026-09-21T12:00:00Z" };

function setup(overrides: Partial<CrmTaskDetailProps> = {}) {
  const cache = new Map();
  const props: CrmTaskDetailProps = { taskId, ownerId, user: { id: ownerId, name: "Agent" }, onClose: vi.fn(), onChanged: vi.fn(), ...overrides };
  const node = (next: CrmTaskDetailProps) => <SWRConfig value={{ provider: () => cache, dedupingInterval: 0, errorRetryCount: 0, revalidateOnFocus: false }}><CrmTaskDetail {...next} /></SWRConfig>;
  const result = render(node(props));
  return { ...result, props, rerenderDetail: (next: Partial<CrmTaskDetailProps>) => result.rerender(node({ ...props, ...next })) };
}

beforeEach(() => {
  Object.values(service).forEach((mock) => mock.mockReset());
  service.getTask.mockResolvedValue(task);
  service.getTaskUpdates.mockResolvedValue({ items: [otherEntry, ownEntry], total: 2, page: 1, limit: 20 });
  service.submitTaskUpdate.mockResolvedValue({ ...task, updates: [otherEntry, ownEntry] });
  service.editTaskUpdate.mockResolvedValue({ ...task, updates: [otherEntry, ownEntry] });
  service.deleteTaskUpdate.mockResolvedValue({ ...task, updates: [otherEntry, { ...ownEntry, isDeleted: true }] });
  service.deleteTaskUpdateAttachments.mockResolvedValue({ ...task, updates: [otherEntry, { ...ownEntry, attachmentUrls: [] }] });
  service.listTransferAgents.mockResolvedValue([{ _id: otherId, username: "Receiving agent", crmAddress: "Saskatoon" }]);
  service.getOutlookCalendarStatus.mockResolvedValue({ connected: true });
  service.addTaskToOutlookCalendar.mockResolvedValue({ eventId: "event-1", webLink: "https://outlook.example.test/event" });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("CRM task detail", () => {
  it("keeps comment identity across stage edits and omits unchanged stage on a follow-up", async () => {
    const { props } = setup();
    const comment = await screen.findByRole("textbox", { name: "Comment" });
    comment.focus();
    fireEvent.change(comment, { target: { value: "First finding\nSecond finding" } });
    fireEvent.change(screen.getByLabelText("Stage"), { target: { value: "contacted" } });
    fireEvent.change(screen.getByLabelText("Stage"), { target: { value: "inspection_required" } });
    expect(screen.getByLabelText("Comment")).toBe(comment);
    expect(comment).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Save update" }));
    await waitFor(() => expect(service.submitTaskUpdate).toHaveBeenCalledTimes(1));
    expect(service.submitTaskUpdate.mock.calls[0][1]).toMatchObject({ comment: "First finding\nSecond finding" });
    expect(service.submitTaskUpdate.mock.calls[0][1]).not.toHaveProperty("status");
    await waitFor(() => expect(props.onChanged).toHaveBeenCalledTimes(1));
  });

  it("requires a lost reason and locks duplicate updates and drawer dismissal until acceptance", async () => {
    let resolve!: (value: CrmTaskItem) => void;
    service.submitTaskUpdate.mockReturnValue(new Promise((done) => { resolve = done; }));
    const { props } = setup();
    await screen.findByLabelText("Stage");
    fireEvent.change(screen.getByLabelText("Stage"), { target: { value: "lost" } });
    fireEvent.click(screen.getByRole("button", { name: "Save update" }));
    expect(service.submitTaskUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Select a reason");
    fireEvent.change(screen.getByLabelText("Lost reason"), { target: { value: "timing" } });
    fireEvent.submit(screen.getByRole("form", { name: "Log follow-up" }));
    fireEvent.submit(screen.getByRole("form", { name: "Log follow-up" }));
    expect(service.submitTaskUpdate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Close panel" })).toBeDisabled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => resolve({ ...task, status: "lost", lostReason: "timing", updates: [] }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Close panel" })).not.toBeDisabled());
    expect(service.submitTaskUpdate.mock.calls[0][1]).toMatchObject({ status: "lost", lostReason: "timing" });
  });

  it("retains comments and files after a failed request without automatically retrying", async () => {
    service.submitTaskUpdate.mockRejectedValue(new Error("Network interrupted"));
    setup();
    fireEvent.change(await screen.findByLabelText("Comment"), { target: { value: "Keep this note" } });
    const file = new File(["evidence"], "details.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("Attach files to update"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Save update" }));
    await screen.findByText("Network interrupted");
    expect(screen.getByText(/The request may already have completed/)).toBeInTheDocument();
    expect(screen.getByLabelText("Comment")).toHaveValue("Keep this note");
    expect(screen.getByText("details.pdf")).toBeInTheDocument();
    expect(service.submitTaskUpdate).toHaveBeenCalledTimes(1);
  });

  it("preserves a draft while opening details and bounds history reads to each requested page", async () => {
    service.getTaskUpdates.mockImplementation((_id, { page }: { page: number }) => Promise.resolve({ items: page === 1 ? [ownEntry] : [otherEntry], total: 21, page, limit: 20 }));
    setup();
    fireEvent.change(await screen.findByLabelText("Comment"), { target: { value: "Still editing" } });
    fireEvent.click(screen.getByRole("tab", { name: "Details" }));
    expect(screen.getByText("Original lead notes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Activity" }));
    expect(await screen.findByLabelText("Comment")).toHaveValue("Still editing");
    fireEvent.click(await screen.findByRole("button", { name: "Next activity page" }));
    await waitFor(() => expect(service.getTaskUpdates).toHaveBeenCalledWith(taskId, { page: 2, limit: 20 }, { signal: expect.any(AbortSignal) }));
    expect(await screen.findByText("Other agent's comment")).toBeInTheDocument();
  });

  it("keeps legacy source, contact, imported, and latest-media details readable", async () => {
    service.getTask.mockResolvedValue({ ...task, title: "Quick Add: Alex", leadSource: "generic", phoneRaw: "Researching...", companyAnnualRevenue: 0, companyStaffCount: 0,
      contactSocials: "instagram: @equipment", latestComment: "Last saved note", latestAttachmentUrls: ["javascript:alert(1)", "https://files.example.test/latest.pdf"], latestRecordingUrl: "https://files.example.test/latest.webm" });
    const { container } = setup();
    fireEvent.click(await screen.findByRole("tab", { name: "Details" }));
    expect(screen.getByText("Organic")).toBeInTheDocument();
    expect(screen.getByText("Researching...")).toBeInTheDocument();
    expect(screen.getAllByText("0")).toHaveLength(3);
    expect(screen.getByText("Last saved note")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "instagram.com" })).toHaveAttribute("href", "https://instagram.com/equipment");
    expect(screen.getByRole("link", { name: "Attachment 2" })).toHaveAttribute("href", "https://files.example.test/latest.pdf");
    expect(screen.getByLabelText("Latest saved recording")).toHaveAttribute("preload", "none");
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it("only edits owned history and does not reapply the old status when editing a comment", async () => {
    setup();
    await screen.findByText("Own earlier comment");
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit comment"), { target: { value: "Corrected earlier note" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(service.editTaskUpdate).toHaveBeenCalledWith(taskId, updateId, { comment: "Corrected earlier note" }));
  });

  it("requires an explicit confirmation before deleting an update or one exact attachment", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(service.deleteTaskUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel removal" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove attachment 1" }));
    expect(service.deleteTaskUpdateAttachments).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove attachment" }));
    await waitFor(() => expect(service.deleteTaskUpdateAttachments).toHaveBeenCalledWith(taskId, updateId, ["https://files.example.test/evidence.pdf"]));
    expect(service.deleteTaskUpdate).not.toHaveBeenCalled();
  });

  it("fences prior-owner content and ignores a mutation resolved after owner change", async () => {
    let resolveWrite!: (value: CrmTaskItem) => void;
    service.submitTaskUpdate.mockReturnValue(new Promise((done) => { resolveWrite = done; }));
    const { props, rerenderDetail } = setup();
    fireEvent.change(await screen.findByLabelText("Comment"), { target: { value: "Old private note" } });
    fireEvent.click(screen.getByRole("button", { name: "Save update" }));
    service.getTask.mockReturnValue(new Promise(() => undefined));
    service.getTaskUpdates.mockReturnValue(new Promise(() => undefined));
    rerenderDetail({ ownerId: otherId, user: { id: otherId } });
    expect(screen.queryByText("Alex Morgan")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("Old private note")).not.toBeInTheDocument();
    await act(async () => resolveWrite(task));
    expect(props.onChanged).not.toHaveBeenCalled();
    expect(screen.queryByText("Update saved.")).not.toBeInTheDocument();
  });

  it("loads transfer agents only on demand and sends the selected agent and note", async () => {
    service.requestTaskTransfer.mockResolvedValue({ _id: "ffffffffffffffffffffffff" });
    const { props } = setup();
    await screen.findByText("Alex Morgan");
    expect(service.listTransferAgents).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Transfer" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Receiving agent/ }));
    fireEvent.change(screen.getByLabelText("Transfer note (optional)"), { target: { value: "Near your area" } });
    fireEvent.click(screen.getByRole("button", { name: "Send transfer request" }));
    await waitFor(() => expect(service.requestTaskTransfer).toHaveBeenCalledWith(taskId, { toUserId: otherId, note: "Near your area" }));
    expect(props.onChanged).toHaveBeenCalled();
  });

  it("exports one Outlook event and prevents another click after confirmed creation", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Add to Outlook" }));
    await waitFor(() => expect(service.addTaskToOutlookCalendar).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "Added to Outlook" })).toBeDisabled();
    expect(screen.getByRole("link", { name: "Open event" })).toHaveAttribute("href", "https://outlook.example.test/event");
  });

  it("does not label a queued Outlook sync as added or allow an immediate duplicate", async () => {
    service.addTaskToOutlookCalendar.mockResolvedValue({ pending: true, message: "This follow-up is already queued for Outlook." });
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Add to Outlook" }));
    const pending = await screen.findByRole("button", { name: "Outlook sync pending" });
    expect(pending).toBeDisabled();
    expect(screen.getByText("This follow-up is already queued for Outlook.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Added to Outlook" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open event" })).not.toBeInTheDocument();
    fireEvent.click(pending);
    expect(service.addTaskToOutlookCalendar).toHaveBeenCalledTimes(1);
  });

  it("does not create an event after a late calendar connection response on a closed task", async () => {
    let resolveStatus!: (value: { connected: boolean }) => void;
    service.getOutlookCalendarStatus.mockReturnValue(new Promise((done) => { resolveStatus = done; }));
    const { unmount } = setup();
    fireEvent.click(await screen.findByRole("button", { name: "Add to Outlook" }));
    unmount();
    await act(async () => resolveStatus({ connected: true }));
    expect(service.addTaskToOutlookCalendar).not.toHaveBeenCalled();
  });

  it("loads detail and activity in StrictMode without aborting the shared initial requests", async () => {
    let resolveTask!: (value: CrmTaskItem) => void;
    let resolveHistory!: (value: { items: CrmTaskUpdateEntry[]; total: number; page: number; limit: number }) => void;
    service.getTask.mockReturnValue(new Promise((done) => { resolveTask = done; }));
    service.getTaskUpdates.mockReturnValue(new Promise((done) => { resolveHistory = done; }));
    render(<StrictMode><SWRConfig value={{ provider: () => new Map() }}><CrmTaskDetail taskId={taskId} ownerId={ownerId} user={{ id: ownerId }} onClose={vi.fn()} onChanged={vi.fn()} /></SWRConfig></StrictMode>);
    await waitFor(() => expect(service.getTask).toHaveBeenCalledTimes(1));
    expect(service.getTask.mock.calls[0][1].signal.aborted).toBe(false);
    expect(service.getTaskUpdates.mock.calls[0][2].signal.aborted).toBe(false);
    await act(async () => { resolveTask(task); resolveHistory({ items: [ownEntry], total: 1, page: 1, limit: 20 }); });
    expect(await screen.findByText("Alex Morgan")).toBeInTheDocument();
    expect(await screen.findByText("Own earlier comment")).toBeInTheDocument();
  });

  it("can reopen the same task after its in-flight reads were cancelled on close", async () => {
    service.getTask.mockImplementationOnce((_id, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Request cancelled", "AbortError")), { once: true });
    }));
    service.getTaskUpdates.mockImplementationOnce((_id, _query, { signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Request cancelled", "AbortError")), { once: true });
    }));
    const cache = new Map();
    const node = (open: boolean) => <SWRConfig value={{ provider: () => cache, revalidateOnFocus: false }}>{open ? <CrmTaskDetail taskId={taskId} ownerId={ownerId} user={{ id: ownerId }} onClose={vi.fn()} onChanged={vi.fn()} /> : null}</SWRConfig>;
    const { rerender } = render(node(true));
    await waitFor(() => expect(service.getTaskUpdates).toHaveBeenCalledTimes(1));
    await act(async () => { rerender(node(false)); });
    expect(service.getTask.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => { rerender(node(true)); });
    expect(await screen.findByText("Alex Morgan")).toBeInTheDocument();
    expect(await screen.findByText("Own earlier comment")).toBeInTheDocument();
    expect(service.getTask).toHaveBeenCalledTimes(2);
  });

  it("keeps unsaved task and email drafts until discard is explicitly confirmed", async () => {
    const { props } = setup();
    fireEvent.change(await screen.findByLabelText("Comment"), { target: { value: "Unsaved task note" } });
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(screen.getByRole("alertdialog", { name: "Discard unsaved changes" })).toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    fireEvent.click(screen.getByRole("button", { name: "Email" }));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Unsaved email" } });
    fireEvent.click(screen.getByRole("button", { name: "Back to task" }));
    expect(screen.getByLabelText("Message")).toHaveValue("Unsaved email");
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.getByLabelText("Comment")).toHaveValue("Unsaved task note");
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(service.submitTaskUpdate).not.toHaveBeenCalled();
  });

  it("requires discard confirmation before a dirty history edit is hidden", async () => {
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Edit comment"), { target: { value: "Unsaved correction" } });
    fireEvent.click(screen.getByRole("tab", { name: "Details" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByLabelText("Edit comment")).toHaveValue("Unsaved correction");
    expect(service.editTaskUpdate).not.toHaveBeenCalled();
  });

  it("keeps typing available offline while blocking saves, transfers, and calendar writes", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    setup();
    fireEvent.change(await screen.findByLabelText("Comment"), { target: { value: "Offline note" } });
    expect(screen.getByLabelText("Comment")).toHaveValue("Offline note");
    expect(screen.getByRole("button", { name: "Save update" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Transfer" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add to Outlook" })).toBeDisabled();
    fireEvent.submit(screen.getByRole("form", { name: "Log follow-up" }));
    expect(service.submitTaskUpdate).not.toHaveBeenCalled();
  });

  it("hides cached contact and history data when fresh history access is denied", async () => {
    service.getTaskUpdates.mockImplementation((_id, { page }: { page: number }) => page === 1
      ? Promise.resolve({ items: [ownEntry], total: 21, page, limit: 20 })
      : Promise.reject({ response: { status: 403, data: { message: "Access no longer available" } } }));
    setup();
    await screen.findByText("Own earlier comment");
    fireEvent.click(screen.getByRole("button", { name: "Next activity page" }));
    await screen.findByText("Access no longer available");
    expect(screen.queryByText("Alex Morgan")).not.toBeInTheDocument();
    expect(screen.queryByText("Own earlier comment")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save update" })).not.toBeInTheDocument();
  });
});
