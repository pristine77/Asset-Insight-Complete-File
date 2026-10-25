import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrmService, type CrmTasksResponse } from "@/services/crm";
import CrmTaskList, { crmDate, crmSource } from "./CrmTaskList";

vi.mock("@/services/crm", async (original) => ({ ...await original<typeof import("@/services/crm")>(), CrmService: { getMyTasks: vi.fn() } }));
const row = { _id: "a".repeat(24), clientName: "Alex Morgan", companyName: "Prairie Equipment", status: "contacted" as const, leadSource: "generic" as const, updateCount: 2041, createdAt: "2026-09-23", updatedAt: "2026-09-23" };
const response: CrmTasksResponse = { items: [row], total: 124, page: 1, limit: 20 };
function mount(ownerId = "owner-a") {
  return render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, revalidateOnFocus: false }}><CrmTaskList ownerId={ownerId} onOpenTask={vi.fn()} /></SWRConfig>);
}
beforeEach(() => { vi.mocked(CrmService.getMyTasks).mockResolvedValue(response); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("compact CRM list", () => {
  it("accepts route-backed filters and emits history-preserving filter and page changes", async () => {
    const onQueryChange = vi.fn();
    const query = { q: "Alex", status: "all" as const, leadSource: "organic" as const, due: "overdue" as const, page: 1, limit: 50 };
    render(<SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false }}><CrmTaskList ownerId="route-owner" query={query} onQueryChange={onQueryChange} onOpenTask={vi.fn()} /></SWRConfig>);
    await screen.findByText("Alex Morgan");
    expect(CrmService.getMyTasks).toHaveBeenCalledWith(query, expect.anything());
    expect(screen.getByRole("searchbox")).toHaveValue("Alex");
    expect(screen.getByLabelText("Task stage")).toHaveValue("all");
    fireEvent.change(screen.getByLabelText("Task stage"), { target: { value: "lost" } });
    expect(onQueryChange).toHaveBeenLastCalledWith({ ...query, status: "lost", page: 1 }, { replace: false });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onQueryChange).toHaveBeenLastCalledWith({ ...query, page: 2 }, { replace: false });
  });
  it("restores back/forward URL state and cancels a pending search without losing focus on typing", async () => {
    const cache = new Map();
    const onQueryChange = vi.fn();
    const props = { ownerId: "history-owner", onOpenTask: vi.fn(), onQueryChange };
    const query = { q: "current", status: "all" as const, page: 1, limit: 20 };
    const view = render(<SWRConfig value={{ provider: () => cache, revalidateOnFocus: false }}><CrmTaskList {...props} query={query} /></SWRConfig>);
    await screen.findByText("Alex Morgan");
    const search = screen.getByRole("searchbox"); search.focus();
    fireEvent.change(search, { target: { value: "pending" } });
    expect(search).toHaveFocus();
    view.rerender(<SWRConfig value={{ provider: () => cache, revalidateOnFocus: false }}><CrmTaskList {...props} query={{ ...query, q: "previous", status: "won" }} /></SWRConfig>);
    await waitFor(() => expect(search).toHaveValue("previous"));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
    expect(onQueryChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Task stage")).toHaveValue("won");
  });
  it("debounces route search as a replace instead of adding an entry per keystroke", async () => {
    const onQueryChange = vi.fn();
    render(<SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false }}><CrmTaskList ownerId="search-owner" query={{ status: "all", page: 1, limit: 20 }} onQueryChange={onQueryChange} onOpenTask={vi.fn()} /></SWRConfig>);
    await screen.findByText("Alex Morgan");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Smith (+1)" } });
    await waitFor(() => expect(onQueryChange).toHaveBeenCalledWith({ q: "Smith (+1)", status: "all", page: 1, limit: 20 }, { replace: true }));
    expect(CrmService.getMyTasks).toHaveBeenCalledTimes(1);
  });
  it("does not re-request an invalid URL page while its replacement navigation is pending", async () => {
    const onQueryChange = vi.fn();
    vi.mocked(CrmService.getMyTasks).mockResolvedValue({ ...response, items: [], page: 3, total: 20 });
    render(<SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false }}><CrmTaskList ownerId="recovery-owner" query={{ page: 3, limit: 20 }} onQueryChange={onQueryChange} onOpenTask={vi.fn()} /></SWRConfig>);
    await waitFor(() => expect(onQueryChange).toHaveBeenCalledWith({ page: 1, limit: 20 }, { replace: true }));
    expect(CrmService.getMyTasks).toHaveBeenCalledTimes(1);
  });
  it("cancels a pending URL search when a visible task is opened", async () => {
    const onQueryChange = vi.fn(); const onOpenTask = vi.fn();
    render(<SWRConfig value={{ provider: () => new Map(), revalidateOnFocus: false }}><CrmTaskList ownerId="open-owner" query={{ page: 1, limit: 20 }} onQueryChange={onQueryChange} onOpenTask={onOpenTask} /></SWRConfig>);
    await screen.findByText("Alex Morgan");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "not yet applied" } });
    fireEvent.click(screen.getByRole("button", { name: "Alex Morgan" }));
    expect(onOpenTask).toHaveBeenCalledWith(row._id);
    expect(screen.getByRole("searchbox")).toHaveValue("");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
    expect(onQueryChange).not.toHaveBeenCalled();
  });
  it("cancels pending search for task-only navigation such as a notification link", async () => {
    const cache = new Map(); const onQueryChange = vi.fn();
    const props = { ownerId: "notification-owner", query: { page: 1, limit: 20 }, onQueryChange, onOpenTask: vi.fn() };
    const view = render(<SWRConfig value={{ provider: () => cache, revalidateOnFocus: false }}><CrmTaskList {...props} navigationKey="" /></SWRConfig>);
    await screen.findByText("Alex Morgan");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "not yet applied" } });
    view.rerender(<SWRConfig value={{ provider: () => cache, revalidateOnFocus: false }}><CrmTaskList {...props} navigationKey={`task=${row._id}`} /></SWRConfig>);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
    expect(onQueryChange).not.toHaveBeenCalled();
    expect(screen.getByRole("searchbox")).toHaveValue("");
  });
  it("requests only a 20-row summary and uses server totals", async () => {
    mount();
    expect(await screen.findByText("124 matching tasks")).toBeInTheDocument();
    expect(CrmService.getMyTasks).toHaveBeenCalledWith(expect.objectContaining({ page: 1, limit: 20 }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.queryByText("2041")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
  });
  it("fetches the next server page and resets to page one for filters", async () => {
    mount(); await screen.findByText("Alex Morgan");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(CrmService.getMyTasks).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }), expect.anything()));
    fireEvent.change(screen.getByLabelText("Task stage"), { target: { value: "won" } });
    await waitFor(() => expect(CrmService.getMyTasks).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1, status: "won" }), expect.anything()));
  });
  it("debounces search and keeps literal user input for service escaping", async () => {
    mount(); await screen.findByText("Alex Morgan");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Smith (+1)" } });
    expect(CrmService.getMyTasks).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(CrmService.getMyTasks).toHaveBeenLastCalledWith(expect.objectContaining({ q: "Smith (+1)" }), expect.anything()));
  });
  it("returns to the final valid page when the last task leaves the current page", async () => {
    vi.mocked(CrmService.getMyTasks).mockImplementation(async (params) => params?.page === 2 ? { ...response, items: [], page: 2, total: 20 } : response);
    mount(); await screen.findByText("Alex Morgan");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(CrmService.getMyTasks).toHaveBeenCalledTimes(3));
    expect(CrmService.getMyTasks).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 }), expect.anything());
    expect(screen.queryByText("21–20 of 20")).not.toBeInTheDocument();
  });
  it("shows a readable error without automatic retries", async () => {
    vi.mocked(CrmService.getMyTasks).mockRejectedValue(new Error("CRM agent access required"));
    mount(); expect(await screen.findByRole("alert")).toHaveTextContent("CRM agent access required");
    expect(CrmService.getMyTasks).toHaveBeenCalledTimes(1);
  });
  it("aborts an abandoned owner read and ignores its late result", async () => {
    let resolve!: (value: CrmTasksResponse) => void;
    vi.mocked(CrmService.getMyTasks).mockReturnValue(new Promise((done) => { resolve = done; }));
    const first = mount();
    await waitFor(() => expect(CrmService.getMyTasks).toHaveBeenCalled());
    const signal = vi.mocked(CrmService.getMyTasks).mock.calls[0][1]?.signal;
    first.unmount(); await waitFor(() => expect(signal?.aborted).toBe(true));
    await act(async () => resolve(response));
    expect(screen.queryByText("Alex Morgan")).not.toBeInTheDocument();
  });
  it("handles empty lists, missing dates and legacy source classification", async () => {
    vi.mocked(CrmService.getMyTasks).mockResolvedValue({ ...response, items: [], total: 0 });
    mount(); expect(await screen.findByText("No matching tasks")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(crmDate("invalid")).toBe("Not set");
    expect(crmDate()).toBe("Not set");
    expect(crmSource({ title: "Quick Add - Alex", leadSource: "generic" })).toBe("Organic");
    expect(crmSource({})).toBe("Not recorded");
  });
});
