import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SWRConfig } from "swr";
import { CrmService, type CrmBulkCalendarResponse, type CrmTaskSummary } from "@/services/crm";
import CrmOutlook from "./CrmOutlook";

vi.mock("@/services/crm", async (original) => ({ ...await original<typeof import("@/services/crm")>(), CrmService: { getOutlookCalendarStatus: vi.fn(), addTasksToOutlookCalendarBulk: vi.fn(), disconnectOutlookCalendar: vi.fn(), getOutlookCalendarAuthUrl: vi.fn() } }));
vi.mock("./CrmTaskList", () => ({ default: ({ selection }: { selection: { onToggle: (task: CrmTaskSummary) => void } }) => <button onClick={() => selection.onToggle({ _id: "a".repeat(24) } as CrmTaskSummary)}>Choose Alex</button> }));
function mount() { return render(<SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false }}><CrmOutlook ownerId="owner" onOpenTask={vi.fn()} /></SWRConfig>); }
beforeEach(() => { vi.mocked(CrmService.getOutlookCalendarStatus).mockResolvedValue({ connected: true, configured: true, email: "alex@example.test" }); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("explicit Outlook actions", () => {
  it("locks duplicate exports immediately and clears attempted selection", async () => {
    let resolve!: (value: CrmBulkCalendarResponse) => void;
    vi.mocked(CrmService.addTasksToOutlookCalendarBulk).mockReturnValue(new Promise((done) => { resolve = done; }));
    mount(); fireEvent.click(await screen.findByText("Choose Alex"));
    const button = screen.getByRole("button", { name: "Export selected" });
    fireEvent.click(button); fireEvent.click(button);
    expect(CrmService.addTasksToOutlookCalendarBulk).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ createdCount: 1, failedCount: 0, created: [{ taskId: "a".repeat(24), webLink: "https://outlook.office.com/test" }], failed: [] }));
    expect(screen.getByText("1 confirmed · 0 failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export selected" })).toBeDisabled();
  });
  it("does not replay uncertain exports or claim success", async () => {
    vi.mocked(CrmService.addTasksToOutlookCalendarBulk).mockRejectedValue(new Error("Network timeout"));
    mount(); fireEvent.click(await screen.findByText("Choose Alex"));
    fireEvent.click(screen.getByRole("button", { name: "Export selected" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Check your calendar");
    expect(CrmService.addTasksToOutlookCalendarBulk).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Export selected" })).toBeDisabled();
  });
  it("shows queued results as pending, not created or omitted", async () => {
    vi.mocked(CrmService.addTasksToOutlookCalendarBulk).mockResolvedValue({ createdCount: 0, failedCount: 0, pendingCount: 1, created: [], failed: [], pending: [{ taskId: "a".repeat(24), reason: "Follow-up sync is queued." }] });
    mount(); fireEvent.click(await screen.findByText("Choose Alex"));
    fireEvent.click(screen.getByRole("button", { name: "Export selected" }));
    expect(await screen.findByText("0 confirmed · 0 failed · 1 pending")).toBeInTheDocument();
    expect(screen.getByText(/No completed event is confirmed yet/)).toHaveTextContent("Follow-up sync is queued.");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open confirmed event" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export selected" })).toBeDisabled();
    expect(CrmService.addTasksToOutlookCalendarBulk).toHaveBeenCalledTimes(1);
  });
  it("warns when the server omits selected tasks", async () => {
    vi.mocked(CrmService.addTasksToOutlookCalendarBulk).mockResolvedValue({ createdCount: 0, failedCount: 0, created: [], failed: [] });
    mount(); fireEvent.click(await screen.findByText("Choose Alex")); fireEvent.click(screen.getByRole("button", { name: "Export selected" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Some selected tasks were not returned");
  });
  it("requires confirmation before disconnecting", async () => {
    mount(); fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(CrmService.disconnectOutlookCalendar).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep connected" }));
    expect(screen.queryByRole("button", { name: "Confirm disconnect" })).not.toBeInTheDocument();
  });
  it("shows unavailable configuration without exporting or connecting automatically", async () => {
    vi.mocked(CrmService.getOutlookCalendarStatus).mockResolvedValue({ connected: false, configured: false });
    mount(); expect(await screen.findByText(/not configured/)).toBeInTheDocument();
    expect(screen.queryByText("Choose Alex")).not.toBeInTheDocument();
    expect(CrmService.getOutlookCalendarAuthUrl).not.toHaveBeenCalled();
  });
});
