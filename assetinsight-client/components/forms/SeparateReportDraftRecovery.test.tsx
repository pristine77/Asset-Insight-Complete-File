import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ upsert: vi.fn() }));
vi.mock("@/services/reportDrafts", () => ({ ReportDraftService: { upsertWithMedia: mocks.upsert }, createReportDraftClientId: () => "fresh-draft", getReportDraftDeviceId: () => "device" }));
import SeparateReportDraftRecovery from "./SeparateReportDraftRecovery";
import { advanceAuthSession } from "@/lib/auth-storage";

describe("explicit separate draft recovery", () => {
  beforeEach(() => { localStorage.clear(); mocks.upsert.mockReset(); });
  it.each(["asset", "lot-listing"] as const)("saves %s details/media under a durable fresh identity without submitting", async (kind) => {
    const file = new File(["original"], "photo.jpg", { type: "image/jpeg" });
    const lots = [{ id: "lot-7", files: [file], extraFiles: [], coverIndex: 0 }];
    mocks.upsert.mockResolvedValue({ _id: "new-server-draft", user: "owner", type: kind === "asset" ? "asset" : "lotListing", clientDraftId: "fresh-draft" });
    render(<SeparateReportDraftRecovery userId="owner" kind={kind} sourceSessionId="old-session" getSnapshot={() => ({ formData: { clientSubmissionId: "old-id", location: "Yard" }, contractNo: "94529", lots })} onBusyChange={vi.fn()} />);
    expect(mocks.upsert).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save separate draft" }));
    expect(await screen.findByRole("link", { name: /Open saved drafts/ })).toHaveAttribute("target", "_blank");
    expect(mocks.upsert.mock.calls[0][0]).toMatchObject({ clientDraftId: "fresh-draft", revision: 1, contractNo: "94529", formData: { clientSubmissionId: "fresh-draft", location: "Yard" } });
    expect(mocks.upsert.mock.calls[0][1][0].files[0]).toBe(file);
    expect(JSON.parse(localStorage.getItem("cv:separate-draft:v1:owner:old-session")!)).toEqual({ id: "fresh-draft", revision: 1 });
  });
  it("retains the same recovery identity after lost acknowledgement and reload", async () => {
    mocks.upsert.mockRejectedValue(new Error("Network Error"));
    const props = { userId: "owner", kind: "asset" as const, sourceSessionId: "old-session", getSnapshot: () => ({ formData: {}, contractNo: "94529", lots: [] }), onBusyChange: vi.fn() };
    const view = render(<SeparateReportDraftRecovery {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Save separate draft" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("could not be confirmed"));
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    view.unmount();
    render(<SeparateReportDraftRecovery {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Save separate draft" }));
    await waitFor(() => expect(mocks.upsert).toHaveBeenCalledTimes(2));
    expect(mocks.upsert.mock.calls.map(([input]) => input.clientDraftId)).toEqual(["fresh-draft", "fresh-draft"]);
    expect(mocks.upsert.mock.calls[1][0].revision).toBe(2);
  });
  it("never displays success for an incomplete save receipt", async () => {
    mocks.upsert.mockResolvedValue({});
    render(<SeparateReportDraftRecovery userId="owner" kind="asset" sourceSessionId="old-session" getSnapshot={() => ({ formData: {}, contractNo: "94529", lots: [] })} onBusyChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Save separate draft" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("could not be confirmed"));
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
  it.each(["owner", "unmount"])("cancels and ignores late progress/receipt after %s change", async (change) => {
    let resolve!: (value: unknown) => void;
    mocks.upsert.mockReturnValue(new Promise((done) => { resolve = done; }));
    const onBusyChange = vi.fn();
    const props = { userId: "owner", kind: "asset" as const, sourceSessionId: "old-session", getSnapshot: () => ({ formData: {}, contractNo: "94529", lots: [] }), onBusyChange };
    const view = render(<SeparateReportDraftRecovery {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Save separate draft" }));
    const [, , progress, signal, session] = mocks.upsert.mock.calls[0];
    expect(signal.aborted).toBe(false); expect(session).toHaveProperty("revision");
    if (change === "owner") view.rerender(<SeparateReportDraftRecovery {...props} userId="other-owner" />);
    else view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { progress(100, "Old user data saved"); resolve({ _id: "saved", user: "owner", type: "asset", clientDraftId: "fresh-draft" }); });
    expect(screen.queryByText("Old user data saved")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
    if (change === "owner") {
      const button = screen.getByRole("button", { name: "Save separate draft" });
      expect(button).toBeDisabled(); fireEvent.click(button);
      expect(mocks.upsert).toHaveBeenCalledTimes(1);
    }
  });
  it("blocks a stale owner render after the token session changes", async () => {
    render(<SeparateReportDraftRecovery userId="owner" kind="asset" sourceSessionId="old-session" getSnapshot={() => ({ formData: {}, contractNo: "94529", lots: [] })} onBusyChange={vi.fn()} />);
    advanceAuthSession();
    fireEvent.click(screen.getByRole("button", { name: "Save separate draft" }));
    expect(screen.getByRole("status")).toHaveTextContent("account session changed");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
  it("never rebinds the original form to a new owner before the first save", async () => {
    const getSnapshot = vi.fn(() => ({ formData: { privateNote: "Owner A data" }, contractNo: "94529", lots: [{ files: [new File(["original"], "A.jpg")] }] }));
    const props = { userId: "owner-A", kind: "asset" as const, sourceSessionId: "old-session", getSnapshot, onBusyChange: vi.fn() };
    const view = render(<SeparateReportDraftRecovery {...props} />);
    view.rerender(<SeparateReportDraftRecovery {...props} userId="owner-B" />);
    fireEvent.click(screen.getByRole("button", { name: "Save separate draft" }));
    expect(getSnapshot).not.toHaveBeenCalled(); expect(mocks.upsert).not.toHaveBeenCalled();
    view.rerender(<SeparateReportDraftRecovery {...props} />);
    expect(screen.getByRole("button", { name: "Save separate draft" })).toBeDisabled();
  });
  it("releases busy state without success after an in-flight session change", async () => {
    let resolve!: (value: unknown) => void;
    mocks.upsert.mockReturnValue(new Promise((done) => { resolve = done; }));
    const onBusyChange = vi.fn();
    render(<SeparateReportDraftRecovery userId="owner" kind="asset" sourceSessionId="old-session" getSnapshot={() => ({ formData: {}, contractNo: "94529", lots: [] })} onBusyChange={onBusyChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Save separate draft" }));
    advanceAuthSession();
    await act(async () => resolve({ _id: "saved", user: "owner", type: "asset", clientDraftId: "fresh-draft" }));
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("account session changed");
    expect(screen.getByRole("button", { name: "Save separate draft" })).toBeDisabled();
  });
});
