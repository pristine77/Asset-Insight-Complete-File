import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthUser } from "@/services/auth";
import { CrmService, type CrmTaskItem, type CrmTaskTransferItem } from "@/services/crm";
import CrmLeadForm from "./CrmLeadForm";
import CrmCoverageForm from "./CrmCoverageForm";
import CrmTransfers from "./CrmTransfers";
import { defaultCrmDueDate, parseCrmQuadrants } from "./crmAuxiliaryHelpers";

vi.mock("@/services/crm", async (original) => {
  const actual = await original<typeof import("@/services/crm")>();
  return { ...actual, CrmService: {
    quickAddLead: vi.fn(), updateCoverage: vi.fn(), getMyTransferRequests: vi.fn(), respondToTransferRequest: vi.fn(),
  } };
});

const ownerId = "69209256be08b81c6d33e76f";
const secondOwner = "69209256be08b81c6d33e770";
const taskId = "69209256be08b81c6d33e771";
const transferId = "69209256be08b81c6d33e772";
const user: AuthUser = { _id: ownerId, email: "agent@example.test", isCrmAgent: true, crmAddress: "Existing service address", crmQuadrant: "NW,NE", crmSpecializations: ["others"] };
const transfer: CrmTaskTransferItem = { _id: transferId, status: "pending", leadId: { _id: taskId, clientName: "Prospect One", status: "contacted" }, fromUserId: { username: "Pat Agent" }, note: "Contact near your service area", createdAt: "2026-09-23T11:00:00Z" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function enterLead() {
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New prospect" } });
  fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "4035550199" } });
  fireEvent.change(screen.getByLabelText("Specialization"), { target: { value: "others" } });
}
beforeEach(() => vi.resetAllMocks());

describe("CRM lead creation", () => {
  it("submits once under immediate duplicate events and locks closing until acceptance", async () => {
    const request = deferred<CrmTaskItem>();
    vi.mocked(CrmService.quickAddLead).mockReturnValue(request.promise);
    const onCreated = vi.fn(), onClose = vi.fn();
    const { container } = render(<CrmLeadForm ownerId={ownerId} onCreated={onCreated} onClose={onClose} />);
    enterLead();
    const form = screen.getByLabelText("Name").closest("form")!;
    fireEvent.submit(form); fireEvent.submit(form);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(CrmService.quickAddLead).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    expect(vi.mocked(CrmService.quickAddLead).mock.calls[0][0]).toMatchObject({ name: "New prospect", phone: "4035550199", specialization: "others" });
    await act(async () => request.resolve({ _id: taskId } as CrmTaskItem));
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(taskId);
    expect(CrmService.quickAddLead).toHaveBeenCalledTimes(1);
  });

  it("keeps entered fields after an uncertain result and never automatically retries", async () => {
    vi.mocked(CrmService.quickAddLead).mockRejectedValueOnce(new Error("Connection interrupted"));
    const onCreated = vi.fn();
    render(<CrmLeadForm ownerId={ownerId} onCreated={onCreated} onClose={vi.fn()} />);
    enterLead();
    fireEvent.change(screen.getByLabelText(/Notes/), { target: { value: "Saved locally in this form" } });
    fireEvent.click(screen.getByRole("button", { name: "Create lead" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Check your task list before trying again");
    expect(screen.getByLabelText("Name")).toHaveValue("New prospect");
    expect(screen.getByLabelText(/Notes/)).toHaveValue("Saved locally in this form");
    expect(CrmService.quickAddLead).toHaveBeenCalledTimes(1);
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("aborts and ignores an old owner's accepted request and clears their fields", async () => {
    const request = deferred<CrmTaskItem>();
    vi.mocked(CrmService.quickAddLead).mockReturnValue(request.promise);
    const onCreated = vi.fn();
    const { rerender } = render(<CrmLeadForm ownerId={ownerId} onCreated={onCreated} onClose={vi.fn()} />);
    enterLead();
    fireEvent.click(screen.getByRole("button", { name: "Create lead" }));
    const signal = vi.mocked(CrmService.quickAddLead).mock.calls[0][1]?.signal;
    rerender(<CrmLeadForm ownerId={secondOwner} onCreated={onCreated} onClose={vi.fn()} />);
    expect(signal?.aborted).toBe(true);
    expect(screen.getByLabelText("Name")).toHaveValue("");
    await act(async () => request.resolve({ _id: taskId } as CrmTaskItem));
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("validates required values even when a form submit bypasses browser constraints", () => {
    render(<CrmLeadForm ownerId={ownerId} onCreated={vi.fn()} onClose={vi.fn()} />);
    fireEvent.submit(screen.getByLabelText("Name").closest("form")!);
    expect(screen.getByRole("alert")).toHaveTextContent("name, phone number and specialization");
    expect(CrmService.quickAddLead).not.toHaveBeenCalled();
  });
});

describe("CRM coverage", () => {
  it("hydrates canonical quadrants, saves exact selected coverage once, and returns the saved profile", async () => {
    const request = deferred<AuthUser>();
    vi.mocked(CrmService.updateCoverage).mockReturnValue(request.promise);
    const onSaved = vi.fn();
    render(<CrmCoverageForm ownerId={ownerId} user={user} onClose={vi.fn()} onSaved={onSaved} />);
    expect(screen.getByRole("checkbox", { name: "North West" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "North East" })).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "North East" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "South East" }));
    const form = screen.getByLabelText("Service address").closest("form")!;
    fireEvent.submit(form); fireEvent.submit(form);
    expect(CrmService.updateCoverage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(CrmService.updateCoverage).mock.calls[0][0]).toEqual({ crmAddress: user.crmAddress, crmQuadrant: ["NW", "SE"], crmSpecializations: ["others"] });
    const saved = { ...user, crmQuadrant: "NW,SE" };
    await act(async () => request.resolve(saved));
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(saved);
  });

  it("requires coverage and retains edits after rejection without a session refresh", async () => {
    vi.mocked(CrmService.updateCoverage).mockRejectedValueOnce({ response: { status: 400, data: { message: "Address needs more detail" } } });
    render(<CrmCoverageForm ownerId={ownerId} user={user} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Others" }));
    fireEvent.click(screen.getByRole("button", { name: "Save coverage" }));
    expect(CrmService.updateCoverage).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("at least one");
    fireEvent.click(screen.getByRole("checkbox", { name: "Others" }));
    fireEvent.change(screen.getByLabelText("Service address"), { target: { value: "My edited address" } });
    fireEvent.click(screen.getByRole("button", { name: "Save coverage" }));
    expect(await screen.findByText("Address needs more detail")).toBeVisible();
    expect(screen.getByLabelText("Service address")).toHaveValue("My edited address");
    expect(CrmService.updateCoverage).toHaveBeenCalledTimes(1);
  });

  it("does not deliver an old profile after owner replacement", async () => {
    const request = deferred<AuthUser>();
    vi.mocked(CrmService.updateCoverage).mockReturnValue(request.promise);
    const onSaved = vi.fn();
    const { rerender } = render(<CrmCoverageForm ownerId={ownerId} user={user} onClose={vi.fn()} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole("button", { name: "Save coverage" }));
    const signal = vi.mocked(CrmService.updateCoverage).mock.calls[0][1]?.signal;
    rerender(<CrmCoverageForm ownerId={secondOwner} user={{ ...user, _id: secondOwner, crmAddress: "Second owner address" }} onClose={vi.fn()} onSaved={onSaved} />);
    await act(async () => request.resolve(user));
    expect(signal?.aborted).toBe(true);
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Service address")).toHaveValue("Second owner address");
  });

  it("requires a fresh page read to check an uncertain coverage save instead of claiming cached reopen is verification", async () => {
    vi.mocked(CrmService.updateCoverage).mockRejectedValueOnce(new Error("Response lost"));
    render(<CrmCoverageForm ownerId={ownerId} user={user} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Service address"), { target: { value: "New address that may have saved" } });
    fireEvent.click(screen.getByRole("button", { name: "Save coverage" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("reload the page to check saved coverage");
    expect(screen.getByLabelText("Service address")).toHaveValue("New address that may have saved");
    expect(screen.getByRole("alert")).not.toHaveTextContent("Reopen coverage");
    expect(CrmService.updateCoverage).toHaveBeenCalledOnce();
  });
});

describe("CRM transfer inbox", () => {
  it("only responds after a rejection confirmation and refreshes after acceptance", async () => {
    vi.mocked(CrmService.getMyTransferRequests).mockResolvedValueOnce([transfer]).mockResolvedValue([]);
    const request = deferred<CrmTaskTransferItem>();
    vi.mocked(CrmService.respondToTransferRequest).mockReturnValue(request.promise);
    const onChanged = vi.fn();
    render(<CrmTransfers ownerId={ownerId} onChanged={onChanged} onOpenTask={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    expect(CrmService.respondToTransferRequest).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: "Confirm transfer rejection" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Keep pending" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Reject" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(CrmService.respondToTransferRequest).toHaveBeenCalledTimes(1);
    expect(vi.mocked(CrmService.respondToTransferRequest).mock.calls[0]).toEqual([transferId, "accept", { signal: expect.any(AbortSignal) }]);
    await act(async () => request.resolve({ ...transfer, status: "accepted" }));
    expect(onChanged).toHaveBeenCalledOnce();
    expect(await screen.findByText("No pending transfer requests")).toBeVisible();
    await waitFor(() => expect(screen.getByLabelText("Transfer status")).toHaveFocus());
    expect(CrmService.getMyTransferRequests).toHaveBeenCalledTimes(2);
  });

  it("sends one confirmed rejection and no implicit acceptance", async () => {
    vi.mocked(CrmService.getMyTransferRequests).mockResolvedValueOnce([transfer]).mockResolvedValue([]);
    vi.mocked(CrmService.respondToTransferRequest).mockResolvedValue({ ...transfer, status: "rejected" });
    render(<CrmTransfers ownerId={ownerId} onChanged={vi.fn()} onOpenTask={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject transfer" }));
    await waitFor(() => expect(CrmService.respondToTransferRequest).toHaveBeenCalledOnce());
    expect(vi.mocked(CrmService.respondToTransferRequest).mock.calls[0][1]).toBe("reject");
  });

  it("ignores late data from a previous status and does not expose its action controls", async () => {
    const pending = deferred<CrmTaskTransferItem[]>();
    vi.mocked(CrmService.getMyTransferRequests).mockReturnValueOnce(pending.promise).mockResolvedValueOnce([{ ...transfer, status: "accepted" }]);
    const onOpenTask = vi.fn();
    render(<CrmTransfers ownerId={ownerId} onChanged={vi.fn()} onOpenTask={onOpenTask} />);
    fireEvent.change(screen.getByLabelText("Transfer status"), { target: { value: "accepted" } });
    expect(await screen.findByRole("button", { name: "Open task" })).toBeVisible();
    await act(async () => pending.resolve([transfer]));
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open task" }));
    expect(onOpenTask).toHaveBeenCalledExactlyOnceWith(taskId);
    expect(vi.mocked(CrmService.getMyTransferRequests).mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("aborts old-owner reads and does not reveal their response", async () => {
    const previous = deferred<CrmTaskTransferItem[]>();
    vi.mocked(CrmService.getMyTransferRequests).mockReturnValueOnce(previous.promise).mockResolvedValueOnce([]);
    const props = { onChanged: vi.fn(), onOpenTask: vi.fn() };
    const { rerender } = render(<CrmTransfers ownerId={ownerId} {...props} />);
    const signal = vi.mocked(CrmService.getMyTransferRequests).mock.calls[0][1]?.signal;
    rerender(<CrmTransfers ownerId={secondOwner} {...props} />);
    await act(async () => previous.resolve([transfer]));
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByText("Prospect One")).toBeNull();
    expect(await screen.findByText("No pending transfer requests")).toBeVisible();
  });

  it("does not apply an accepted transfer response after changing owners", async () => {
    vi.mocked(CrmService.getMyTransferRequests).mockResolvedValueOnce([transfer]).mockResolvedValue([]);
    const request = deferred<CrmTaskTransferItem>();
    vi.mocked(CrmService.respondToTransferRequest).mockReturnValue(request.promise);
    const onChanged = vi.fn();
    const { rerender } = render(<CrmTransfers ownerId={ownerId} onChanged={onChanged} onOpenTask={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    const signal = vi.mocked(CrmService.respondToTransferRequest).mock.calls[0][2]?.signal;
    rerender(<CrmTransfers ownerId={secondOwner} onChanged={onChanged} onOpenTask={vi.fn()} />);
    await act(async () => request.resolve({ ...transfer, status: "accepted" }));
    expect(signal?.aborted).toBe(true);
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.queryByText("Transfer accepted. The task is now assigned to you.")).toBeNull();
  });

  it("preserves an uncertain decision for manual reconciliation without an automatic retry", async () => {
    vi.mocked(CrmService.getMyTransferRequests).mockResolvedValue([transfer]);
    vi.mocked(CrmService.respondToTransferRequest).mockRejectedValue(new Error("Connection lost"));
    render(<CrmTransfers ownerId={ownerId} onChanged={vi.fn()} onOpenTask={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Refresh the requests before trying again");
    expect(CrmService.respondToTransferRequest).toHaveBeenCalledOnce();
    expect(CrmService.getMyTransferRequests).toHaveBeenCalledOnce();
  });
});

describe("CRM panel field helpers", () => {
  it("defaults to tomorrow at 17:00 on the local calendar including year rollover", () => {
    expect(defaultCrmDueDate(new Date(2026, 11, 31, 23, 59))).toBe("2027-01-01T17:00");
    const value = new Date(defaultCrmDueDate(new Date(2026, 2, 28, 12)));
    expect(value.getDate()).toBe(29);
    expect(value.getHours()).toBe(17);
  });
  it("parses canonical comma-separated quadrants without duplicates or unknown choices", () => {
    expect(parseCrmQuadrants("NW, ne, NW,unknown,CENTRAL")).toEqual(["NW", "NE", "CENTRAL"]);
  });
});
