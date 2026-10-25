import { beforeEach, describe, expect, it, vi } from "vitest";
import API from "@/lib/api";
import { CrmService, CRM_READ_TIMEOUT_MS, CRM_STATUSES, parseCrmDashboard, type CrmDashboardSnapshot } from "./crm";

vi.mock("@/lib/api", () => ({ default: { get: vi.fn() } }));
const firstId = "aaaaaaaaaaaaaaaaaaaaaaaa";
const secondId = "bbbbbbbbbbbbbbbbbbbbbbbb";
function fixture(): CrmDashboardSnapshot {
  return {
    asOf: "2026-09-23T12:00:00.000Z", total: 4,
    statusCounts: CRM_STATUSES.map((_id) => ({ _id, count: _id === "new_lead" ? 3 : _id === "won" ? 1 : 0 })),
    leadSourceCounts: { total: 4, generic: 3, organic: 1 }, dueCounts: { overdue: 1, upcoming: 1 },
    overdueTasks: [{ _id: firstId, clientName: "Alex", status: "new_lead", dueDate: "2026-09-22T12:00:00.000Z" }],
    upcomingTasks: [{ _id: secondId, clientName: "Jordan", companyName: "Equipment", status: "new_lead", dueDate: "2026-09-24T12:00:00.000Z", taskStartDate: "2026-09-20T12:00:00.000Z" }],
  };
}
beforeEach(() => vi.resetAllMocks());

describe("CRM dashboard snapshot contract", () => {
  it("reads one bounded snapshot with cancellation and no list query arguments", async () => {
    vi.mocked(API.get).mockResolvedValueOnce({ data: fixture() });
    const controller = new AbortController();
    await expect(CrmService.getDashboard({ signal: controller.signal })).resolves.toEqual(fixture());
    expect(API.get).toHaveBeenCalledExactlyOnceWith("/crm/tasks/dashboard", { timeout: CRM_READ_TIMEOUT_MS, signal: controller.signal });
  });
  it("preserves real zero counts and canonical stage ordering", () => {
    const snapshot = fixture();
    snapshot.total = 0;
    snapshot.statusCounts = CRM_STATUSES.toReversed().map((_id) => ({ _id, count: 0 }));
    snapshot.leadSourceCounts = { total: 0, generic: 0, organic: 0 };
    snapshot.dueCounts = { overdue: 0, upcoming: 0 };
    snapshot.overdueTasks = []; snapshot.upcomingTasks = [];
    expect(parseCrmDashboard(snapshot).statusCounts).toEqual(CRM_STATUSES.map((_id) => ({ _id, count: 0 })));
  });
  it.each([
    ["missing snapshot", () => ({})],
    ["missing stage", () => ({ ...fixture(), statusCounts: fixture().statusCounts.slice(1) })],
    ["duplicate stage", () => ({ ...fixture(), statusCounts: fixture().statusCounts.map((entry) => ({ ...entry, _id: "new_lead" })) })],
    ["string count", () => ({ ...fixture(), total: "4" })],
    ["negative count", () => ({ ...fixture(), dueCounts: { overdue: -1, upcoming: 1 } })],
    ["fraction count", () => ({ ...fixture(), total: 4.5 })],
    ["mismatched stages", () => ({ ...fixture(), total: 5, leadSourceCounts: { total: 5, generic: 4, organic: 1 } })],
    ["mismatched sources", () => ({ ...fixture(), leadSourceCounts: { total: 4, generic: 4, organic: 1 } })],
    ["due total exceeds open portfolio", () => ({ ...fixture(), dueCounts: { overdue: 4, upcoming: 1 } })],
    ["invalid asOf", () => ({ ...fixture(), asOf: "not-a-date" })],
    ["missing due preview", () => ({ ...fixture(), overdueTasks: [] })],
    ["foreign format id", () => ({ ...fixture(), overdueTasks: [{ ...fixture().overdueTasks[0], _id: "../private" }] })],
    ["duplicate preview id", () => ({ ...fixture(), upcomingTasks: [{ ...fixture().upcomingTasks[0], _id: firstId }] })],
    ["closed due preview", () => ({ ...fixture(), overdueTasks: [{ ...fixture().overdueTasks[0], status: "lost" }] })],
    ["future overdue preview", () => ({ ...fixture(), overdueTasks: [{ ...fixture().overdueTasks[0], dueDate: "2026-09-24T12:00:00.000Z" }] })],
    ["beyond next7days", () => ({ ...fixture(), upcomingTasks: [{ ...fixture().upcomingTasks[0], dueDate: "2026-10-01T12:00:00.000Z" }] })],
  ])("rejects %s without inventing totals", (_label, build) => {
    expect(() => parseCrmDashboard(build())).toThrow("incomplete CRM dashboard");
  });
  it("accepts both exact upcoming window boundaries and strips unneeded row fields", () => {
    const snapshot = fixture();
    snapshot.upcomingTasks[0].dueDate = snapshot.asOf;
    expect(parseCrmDashboard(snapshot).upcomingTasks[0].dueDate).toBe(snapshot.asOf);
    snapshot.upcomingTasks[0].dueDate = "2026-09-30T12:00:00.000Z";
    const value = { ...snapshot, overdueTasks: [{ ...snapshot.overdueTasks[0], updates: ["private history"] }] };
    expect(parseCrmDashboard(value).overdueTasks[0]).not.toHaveProperty("updates");
  });
  it("treats legacy null optional fields as absent without inventing task dates", () => {
    const value = { ...fixture(), overdueTasks: [{ ...fixture().overdueTasks[0], title: null, companyName: null, taskStartDate: null, lostReason: null }] };
    expect(parseCrmDashboard(value).overdueTasks[0]).toEqual(fixture().overdueTasks[0]);
  });
  it("passes through permission failures without retrying", async () => {
    const error = { response: { status: 403 } };
    vi.mocked(API.get).mockRejectedValueOnce(error);
    await expect(CrmService.getDashboard()).rejects.toBe(error);
    expect(API.get).toHaveBeenCalledTimes(1);
  });
});
