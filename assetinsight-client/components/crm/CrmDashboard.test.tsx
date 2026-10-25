import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CRM_STATUSES, type CrmDashboardSnapshot } from "@/services/crm";
import CrmDashboard from "./CrmDashboard";

const getDashboard = vi.hoisted(() => vi.fn());
vi.mock("@/services/crm", async (original) => ({ ...await original<typeof import("@/services/crm")>(), CrmService: { getDashboard } }));
const ownerId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const firstId = "bbbbbbbbbbbbbbbbbbbbbbbb";
const secondId = "cccccccccccccccccccccccc";
function fixture(): CrmDashboardSnapshot {
  const values = [32, 25, 18, 10, 13, 12, 6, 8];
  return { asOf: "2026-09-23T12:00:00.000Z", total: 124,
    statusCounts: CRM_STATUSES.map((_id, index) => ({ _id, count: values[index] })),
    leadSourceCounts: { total: 124, generic: 84, organic: 40 }, dueCounts: { overdue: 1, upcoming: 1 },
    overdueTasks: [{ _id: firstId, clientName: "Alex Morgan", companyName: "Prairie Equipment", status: "inspection_required", dueDate: "2026-09-20T12:00:00.000Z" }],
    upcomingTasks: [{ _id: secondId, clientName: "Jordan Lee", companyName: "Regional Equipment", status: "contacted", dueDate: "2026-09-24T12:00:00.000Z" }],
  };
}
function setup() {
  const cache = new Map();
  const onOpenTask = vi.fn();
  const onAddLead = vi.fn();
  const node = (id: string) => <SWRConfig value={{ provider: () => cache, revalidateOnFocus: false }}><CrmDashboard ownerId={id} onOpenTask={onOpenTask} onAddLead={onAddLead} /></SWRConfig>;
  const result = render(node(ownerId));
  return { ...result, onOpenTask, onAddLead, changeOwner: (id: string) => result.rerender(node(id)) };
}
beforeEach(() => { getDashboard.mockReset().mockResolvedValue(fixture()); });
afterEach(() => vi.restoreAllMocks());

describe("CRM dashboard", () => {
  it("uses whole-portfolio metrics and exact total-normalized bars with direct labels", async () => {
    setup();
    const totals = await screen.findByRole("navigation", { name: "CRM lead totals" });
    expect(within(totals).getByRole("link", { name: "Total leads 124" })).toHaveAttribute("href", "/crm/tasks?status=all");
    expect(within(totals).getByRole("link", { name: "Imported 84" })).toHaveAttribute("href", "/crm/tasks?status=all&leadSource=generic");
    expect(within(totals).getByRole("link", { name: "Organic 40" })).toHaveAttribute("href", "/crm/tasks?status=all&leadSource=organic");
    expect(within(totals).getByRole("link", { name: "Next 7 days 1" })).toHaveAttribute("href", "/crm/tasks?status=all&due=upcoming");
    expect(within(totals).getByRole("link", { name: "Lost 8" })).toHaveAttribute("href", "/crm/tasks?status=lost");
    const stage = screen.getByRole("link", { name: "New Lead: 32 of 124 leads" });
    expect(stage).toHaveAttribute("href", "/crm/tasks?status=new_lead");
    expect(stage.querySelector('[aria-hidden="true"] > span')).toHaveStyle({ width: `${32 / 124 * 100}%` });
    expect(screen.getAllByRole("link", { name: /of 124 leads$/ })).toHaveLength(8);
  });
  it("switches the bounded follow-up preview without additional reads and opens the selected task", async () => {
    const { onOpenTask, onAddLead } = setup();
    const task = await screen.findByRole("button", { name: "Open task for Alex Morgan" });
    expect(task).toHaveAccessibleDescription(/Prairie Equipment\. Stage: Inspection Required\. Due:/);
    fireEvent.click(task);
    expect(onOpenTask).toHaveBeenCalledWith(firstId);
    fireEvent.click(screen.getByRole("tab", { name: "Next 7 days 1" }));
    expect(screen.queryByText("Alex Morgan")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open task for Jordan Lee" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View upcoming tasks" })).toHaveAttribute("href", "/crm/tasks?status=all&due=upcoming");
    fireEvent.click(screen.getByRole("button", { name: "Add lead" }));
    expect(onAddLead).toHaveBeenCalledTimes(1);
    expect(getDashboard).toHaveBeenCalledTimes(1);
  });
  it("supports keyboard follow-up tabs without changing the loaded snapshot", async () => {
    setup();
    const overdue = await screen.findByRole("tab", { name: "Overdue 1" });
    overdue.focus();
    fireEvent.keyDown(overdue, { key: "ArrowRight" });
    const upcoming = screen.getByRole("tab", { name: "Next 7 days 1" });
    expect(upcoming).toHaveFocus();
    expect(upcoming).toHaveAttribute("aria-selected", "true");
    expect(overdue).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(upcoming, { key: "Home" });
    expect(overdue).toHaveFocus();
    expect(screen.getByText("Alex Morgan")).toBeInTheDocument();
    expect(getDashboard).toHaveBeenCalledTimes(1);
  });
  it("shows loading then error as unavailable rather than fabricated empty counts", async () => {
    let reject!: (error: Error) => void;
    getDashboard.mockReturnValue(new Promise((_resolve, fail) => { reject = fail; }));
    setup();
    expect(screen.getByText("Loading CRM dashboard…")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "CRM lead totals" })).not.toBeInTheDocument();
    await act(async () => reject(new Error("Temporarily unavailable")));
    expect(await screen.findByRole("alert")).toHaveTextContent("Temporarily unavailable");
    expect(screen.getByText("Dashboard unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No overdue tasks.")).not.toBeInTheDocument();
  });
  it("renders legitimate empty data as zeros and zero-width bars", async () => {
    getDashboard.mockResolvedValue({ ...fixture(), total: 0, statusCounts: CRM_STATUSES.map((_id) => ({ _id, count: 0 })), leadSourceCounts: { total: 0, generic: 0, organic: 0 }, dueCounts: { overdue: 0, upcoming: 0 }, overdueTasks: [], upcomingTasks: [] });
    setup();
    const stage = await screen.findByRole("link", { name: "New Lead: 0 of 0 leads" });
    expect(stage.querySelector('[aria-hidden="true"] > span')).toHaveStyle({ width: "0%" });
    expect(screen.getByText("No overdue tasks.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Total leads 0" })).toBeInTheDocument();
  });
  it("keeps snapshot time and selected tab after a transient refresh failure", async () => {
    setup();
    fireEvent.click(await screen.findByRole("tab", { name: "Next 7 days 1" }));
    getDashboard.mockRejectedValue(new Error("Network interrupted"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Network interrupted");
    expect(screen.getByText(/Showing the last loaded dashboard/)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Next 7 days 1" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Open task for Jordan Lee" })).toBeInTheDocument();
    expect(screen.getByText(/Last loaded/).querySelector("time")).toHaveAttribute("datetime", fixture().asOf);
  });
  it("removes cached evidence and task actions when refreshed access is denied", async () => {
    setup();
    await screen.findByRole("button", { name: "Open task for Alex Morgan" });
    getDashboard.mockRejectedValue({ response: { status: 403, data: { message: "CRM access removed" } } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("CRM access removed");
    expect(screen.queryByText("Alex Morgan")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "CRM lead totals" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add lead" })).toBeDisabled();
  });
  it("does not show another owner's cached dashboard while new reads are pending", async () => {
    const { changeOwner } = setup();
    await screen.findByText("Alex Morgan");
    getDashboard.mockReturnValue(new Promise(() => undefined));
    changeOwner("dddddddddddddddddddddddd");
    expect(screen.queryByText("Alex Morgan")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "CRM lead totals" })).not.toBeInTheDocument();
    expect(screen.getByText("Loading CRM dashboard…")).toBeInTheDocument();
  });
  it("keeps StrictMode initial reads alive and shares one bounded request", async () => {
    let resolve!: (value: CrmDashboardSnapshot) => void;
    getDashboard.mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<StrictMode><SWRConfig value={{ provider: () => new Map() }}><CrmDashboard ownerId={ownerId} onOpenTask={vi.fn()} /></SWRConfig></StrictMode>);
    await waitFor(() => expect(getDashboard).toHaveBeenCalledTimes(1));
    expect(getDashboard.mock.calls[0][0].signal.aborted).toBe(false);
    await act(async () => resolve(fixture()));
    expect(await screen.findByText("Alex Morgan")).toBeInTheDocument();
  });
  it("labels retained evidence offline and disables network-dependent actions", async () => {
    setup();
    await screen.findByText("Alex Morgan");
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    fireEvent(window, new Event("offline"));
    expect(screen.getByText(/You're offline/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add lead" })).toBeDisabled();
    expect(screen.getByText("Alex Morgan")).toBeInTheDocument();
  });
});
