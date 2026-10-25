import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "@/services/auth";
import CrmWorkspace from "./CrmWorkspace";

const state = vi.hoisted(() => ({
  user: null as AuthUser | null, loading: false, loggingOut: false, deviceAccess: null,
  pathname: "/crm", search: new URLSearchParams(), push: vi.fn(), replace: vi.fn(), mutate: vi.fn(),
  taskProps: vi.fn(),
}));
vi.mock("@/context/AuthContext", () => ({ useAuthContext: () => state }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push, replace: state.replace }), usePathname: () => state.pathname, useSearchParams: () => state.search }));
vi.mock("swr", () => ({ useSWRConfig: () => ({ mutate: state.mutate }) }));
vi.mock("./useCrmRead", () => ({ useCrmOnline: () => true }));
vi.mock("./CrmTaskList", () => ({ default: (props: Record<string, unknown>) => {
  state.taskProps(props);
  return <button onClick={() => (props.onQueryChange as (query: unknown) => void)({ status: "lost", page: 1, limit: 20 })}>Tasks list</button>;
} }));
vi.mock("next/dynamic", () => ({ default: (loader: () => unknown) => {
  const name = /(Crm(?:Dashboard|TaskDetail|LeadForm|CoverageScreen|Transfers|Outlook))/.exec(String(loader))?.[1] || "Dynamic CRM";
  return (props: { onClose?: () => void; onOpenTask?: (id: string) => void; onAddLead?: () => void; onCreated?: (id: string) => void; onChanged?: () => void }) => <section aria-label={name}>
    {name === "CrmDashboard" ? <h1>CRM dashboard</h1> : name}
    {props.onOpenTask && <button onClick={() => props.onOpenTask?.("a".repeat(24))}>Open fixture task</button>}
    {props.onClose && <button onClick={props.onClose}>Close fixture panel</button>}
    {props.onAddLead && <button onClick={props.onAddLead}>Add dashboard lead</button>}
    {props.onCreated && <button onClick={() => props.onCreated?.("a".repeat(24))}>Save fixture lead</button>}
    {props.onChanged && <button onClick={props.onChanged}>Change fixture task</button>}
  </section>;
} }));

beforeEach(() => {
  state.user = { _id: "owner-a", email: "agent@example.test", isCrmAgent: true, role: "user" } as AuthUser;
  state.loading = false; state.loggingOut = false; state.pathname = "/crm"; state.search = new URLSearchParams();
  state.mutate.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("separate CRM route workspace", () => {
  it.each([false, undefined, "true"])("requires explicit CRM capability %s", (isCrmAgent) => {
    state.user = { ...state.user!, isCrmAgent } as AuthUser;
    render(<CrmWorkspace />);
    expect(screen.getByRole("heading", { name: "CRM access required" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "CrmDashboard" })).not.toBeInTheDocument();
    expect(state.taskProps).not.toHaveBeenCalled();
  });
  it("waits for actual access before mounting CRM readers", () => {
    state.loading = true;
    render(<CrmWorkspace page="tasks" />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading your CRM access");
    expect(state.taskProps).not.toHaveBeenCalled();
  });
  it("mounts dashboard alone without a duplicate page heading or old tabs", () => {
    render(<CrmWorkspace />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { name: "CRM dashboard" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "CRM views" })).not.toBeInTheDocument();
    expect(state.taskProps).not.toHaveBeenCalled();
  });
  it.each([["view=outlook", "/crm/outlook"], ["view=transfers", "/crm/transfers"], [`task=${"a".repeat(24)}`, `/crm/tasks?task=${"a".repeat(24)}`]])("redirects legacy %s before any dashboard content mounts", async (query, href) => {
    state.search = new URLSearchParams(query);
    render(<CrmWorkspace />);
    await waitFor(() => expect(state.replace).toHaveBeenCalledWith(href, { scroll: false }));
    expect(screen.queryByRole("region", { name: "CrmDashboard" })).not.toBeInTheDocument();
    expect(state.taskProps).not.toHaveBeenCalled();
  });
  it("passes canonical task drill-down filters and pushes filter navigation", () => {
    state.pathname = "/crm/tasks"; state.search = new URLSearchParams("status=all&leadSource=organic&due=overdue&q=Alex&page=2&limit=50");
    render(<CrmWorkspace page="tasks" />);
    expect(state.taskProps).toHaveBeenCalledWith(expect.objectContaining({ query: { status: "all", leadSource: "organic", due: "overdue", q: "Alex", page: 2, limit: 50 } }));
    fireEvent.click(screen.getByRole("button", { name: "Tasks list" }));
    expect(state.push).toHaveBeenCalledWith("/crm/tasks?status=lost", { scroll: false });
  });
  it("closes detail without dropping task filters", () => {
    state.pathname = "/crm/tasks"; state.search = new URLSearchParams(`status=lost&page=2&task=${"a".repeat(24)}`);
    render(<CrmWorkspace page="tasks" />);
    fireEvent.click(screen.getByRole("button", { name: "Close fixture panel" }));
    expect(state.replace).toHaveBeenCalledWith("/crm/tasks?status=lost&page=2", { scroll: false });
  });
  it.each(["outlook", "transfers", "coverage"] as const)("mounts only the selected %s screen", (page) => {
    state.pathname = `/crm/${page}`;
    render(<CrmWorkspace page={page} />);
    expect(screen.queryByRole("region", { name: "CrmDashboard" })).not.toBeInTheDocument();
    expect(state.taskProps).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: page === "outlook" ? "CrmOutlook" : page === "transfers" ? "CrmTransfers" : "CrmCoverageScreen" })).toBeInTheDocument();
  });
  it("invalidates only the current owner's dashboard after a lead is created", () => {
    render(<CrmWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "Add dashboard lead" }));
    fireEvent.click(screen.getByRole("button", { name: "Save fixture lead" }));
    expect(state.mutate).toHaveBeenCalledWith("crm:dashboard:owner-a", undefined, { revalidate: true });
    expect(state.push).toHaveBeenCalledWith(`/crm/tasks?task=${"a".repeat(24)}`, { scroll: false });
  });
});
