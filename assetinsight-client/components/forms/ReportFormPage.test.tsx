import { StrictMode, useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuctioneerWorkItemSetup } from "@/services/auctioneer";
import ReportFormPage from "./ReportFormPage";

const mocks = vi.hoisted(() => ({
  dynamicIndex: 0,
  routerPush: vi.fn(),
  continueWorkItem: vi.fn(),
  getSetup: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.routerPush }),
}));

vi.mock("@/services/auctioneer", () => ({
  AuctioneerService: { continueWorkItem: mocks.continueWorkItem, getSetup: mocks.getSetup },
}));

vi.mock("next/dynamic", () => ({
  default: () => {
    const kind = mocks.dynamicIndex++ === 0 ? "asset" : "lot-listing";
    function DeferredReportForm({
      auctioneer,
      onAcceptedAndContinue,
      onSuccess,
      onDraftStatusChange,
      resumeDraft,
      resumeLocalDraftScopeId,
      continuationDetails,
    }: {
      auctioneer?: AuctioneerWorkItemSetup;
      onAcceptedAndContinue?: (reportId: string | undefined, details?: { location: string; currency: string }) => void;
      continuationDetails?: { location?: string; currency?: string };
      onSuccess?: () => void;
      onDraftStatusChange?: (status: "dirty", label?: string) => void;
      resumeDraft?: unknown;
      resumeLocalDraftScopeId?: string;
    }) {
      const [mediaCount, setMediaCount] = useState(0);
      return (
        <div data-testid={`${kind}-handoff`}>
          {auctioneer?.contract.contractNo || "No imported contract"}
          <span data-testid="work-item">{auctioneer?.workItemId}</span>
          <span data-testid="submission">{auctioneer?.clientSubmissionId}</span>
          <span data-testid="contract-metadata">{JSON.stringify(auctioneer?.contract)}</span>
          <span data-testid="source-lots">{auctioneer?.lots.length}</span>
          <span data-testid="media-count">{mediaCount}</span>
          <span data-testid="carried-details">{JSON.stringify(continuationDetails)}</span>
          <span data-testid="resume-state">{resumeDraft || resumeLocalDraftScopeId ? "resume" : "fresh"}</span>
          <button onClick={() => {
            setMediaCount((count) => count + 1);
            onDraftStatusChange?.("dirty", "Unsaved changes");
          }}>Add mock photo</button>
          <button onClick={onSuccess}>Normal submit accepted</button>
          {onAcceptedAndContinue ? <>
            <button onClick={() => onAcceptedAndContinue("accepted-report-1", { location: "Edited yard", currency: "USD" })}>Continue accepted report</button>
            <button onClick={() => onAcceptedAndContinue(undefined)}>Continue missing receipt</button>
          </> : null}
        </div>
      );
    }
    return DeferredReportForm;
  },
}));

const importedSetup: AuctioneerWorkItemSetup = {
  workItemId: "work-100",
  cycleKey: "cycle-100",
  kind: "scheduleA",
  reportType: "asset",
  clientSubmissionId: "submission-100",
  status: "claimed",
  contract: {
    id: "contract-100",
    contractNo: "CV-E2E-100",
    customerName: "Northfield Plant Ltd",
    eventId: "event-100",
    eventTitle: "Fleet dispersal",
    eventDate: "2026-08-12T10:00:00.000Z",
    location: "Leeds",
  },
  lots: [{ sourceKey: "locked-source", lotId: "lot-100" }],
};

function seedHandoff(kind: "asset" | "lot-listing" = "asset") {
  const auctioneer = {
    ...importedSetup,
    reportType: kind === "asset" ? "asset" as const : "lotListing" as const,
  };
  window.sessionStorage.setItem("cv:report-form-handoff:v1", JSON.stringify({
    version: 1, kind, returnTo: "/incoming", auctioneer,
    resumeLocalDraftScopeId: "old-scope",
  }));
  return auctioneer;
}

function freshSuccessor(previous = importedSetup): AuctioneerWorkItemSetup {
  return { ...previous, workItemId: "work-101", clientSubmissionId: "submission-101", kind: "unknown", lots: [] };
}

function seedServerDraft(workItemId: unknown = "work-101") {
  window.sessionStorage.setItem("cv:report-form-handoff:v1", JSON.stringify({
    version: 1, kind: "asset", returnTo: "/previews",
    resumeDraft: {
      _id: "saved-draft-101", type: "asset", clientDraftId: "submission-101",
      contractNo: "CV-E2E-100", formData: { auctioneerWorkItemId: workItemId, clientSubmissionId: "submission-101" },
    },
  }));
}

describe("ReportFormPage handoff", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    mocks.routerPush.mockReset();
    mocks.continueWorkItem.mockReset();
    mocks.getSetup.mockReset();
  });

  it("preserves a single-use incoming handoff when Strict Mode replays effects", async () => {
    seedHandoff();
    render(<StrictMode><ReportFormPage kind="asset" /></StrictMode>);
    expect(await screen.findByTestId("asset-handoff")).toHaveTextContent("CV-E2E-100");
    expect(window.sessionStorage.getItem("cv:report-form-handoff:v1")).toBeNull();
  });

  it.each(["asset", "lot-listing"] as const)("remounts a fresh %s form after continuation without prior media or draft scope", async (kind) => {
    const previous = seedHandoff(kind);
    mocks.continueWorkItem.mockResolvedValueOnce(freshSuccessor(previous));
    render(<ReportFormPage kind={kind} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add mock photo" }));
    expect(screen.getByTestId("media-count")).toHaveTextContent("1");
    expect(screen.getByTestId("resume-state")).toHaveTextContent("resume");
    fireEvent.click(screen.getByRole("button", { name: "Continue accepted report" }));
    await waitFor(() => expect(screen.getByTestId("work-item")).toHaveTextContent("work-101"));
    expect(screen.getByTestId("submission")).toHaveTextContent("submission-101");
    expect(screen.getByTestId("media-count")).toHaveTextContent("0");
    expect(screen.getByTestId("carried-details")).toHaveTextContent(JSON.stringify({ location: "Edited yard", currency: "USD" }));
    expect(screen.getByTestId("resume-state")).toHaveTextContent("fresh");
    expect(screen.getByTestId("contract-metadata")).toHaveTextContent(JSON.stringify(previous.contract));
    expect(screen.getByTestId("source-lots")).toHaveTextContent("0");
    expect(screen.getByTestId(`${kind}-handoff`)).toHaveTextContent("CV-E2E-100");
    expect(screen.getByRole("status")).toHaveTextContent("Fresh lot for contract CV-E2E-100");
    expect(screen.getByRole("status")).toHaveClass("freshLotDescription");
    expect(screen.getByRole("status").closest("header")).toHaveClass("freshLotHeader");
    expect(mocks.continueWorkItem).toHaveBeenCalledExactlyOnceWith("work-100", "accepted-report-1");
    expect(mocks.routerPush).not.toHaveBeenCalled();
    // The continuation commits the new form before its focus effect runs.
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Add mock photo" }));
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    expect(screen.getByRole("status").closest("header")).toHaveClass("freshLotHeader");
  });

  it("retries only continuation with the same accepted receipt, with a single-flight lock", async () => {
    seedHandoff();
    mocks.continueWorkItem.mockRejectedValueOnce(new Error("Connection unavailable"));
    let resolveRetry!: (setup: AuctioneerWorkItemSetup) => void;
    mocks.continueWorkItem.mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve; }));
    render(<ReportFormPage kind="asset" />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue accepted report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection unavailable");
    expect(screen.getByRole("heading", { name: "Report accepted" })).toHaveFocus();
    expect(screen.queryByTestId("asset-handoff")).not.toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Retry open new form" });
    act(() => { retry.click(); retry.click(); });
    expect(mocks.continueWorkItem).toHaveBeenCalledTimes(2);
    expect(mocks.continueWorkItem.mock.calls).toEqual([
      ["work-100", "accepted-report-1"], ["work-100", "accepted-report-1"],
    ]);
    await act(async () => { resolveRetry(freshSuccessor()); });
    await waitFor(() => expect(screen.getByTestId("work-item")).toHaveTextContent("work-101"));
    expect(screen.getByTestId("carried-details")).toHaveTextContent(JSON.stringify({ location: "Edited yard", currency: "USD" }));
  });

  it("keeps acceptance visible without resubmission when the response omitted reportId", async () => {
    seedHandoff();
    render(<ReportFormPage kind="asset" />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue missing receipt" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("did not return its report ID");
    expect(screen.queryByRole("button", { name: "Retry open new form" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open previews" })).toHaveAttribute("href", "/previews");
    expect(mocks.continueWorkItem).not.toHaveBeenCalled();
  });

  it.each(["asset", "lot-listing"] as const)("keeps a genuine assignment denial visible for %s until the same-pair handoff succeeds", async (kind) => {
    const previous = seedHandoff(kind);
    const message = "This contract is no longer assigned to you in Incoming. Your accepted report is unchanged.";
    mocks.continueWorkItem.mockRejectedValueOnce({ response: { status: 409, data: {
      code: "auctioneer_continuation_assignment_unavailable", message,
    } } }).mockResolvedValueOnce(freshSuccessor(previous));
    render(<ReportFormPage kind={kind} />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue accepted report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.getByText(/accepted upload will not be submitted again/i)).toBeInTheDocument();
    expect(screen.queryByTestId(`${kind}-handoff`)).not.toBeInTheDocument();
    expect(mocks.routerPush).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry open new form" }));
    await waitFor(() => expect(screen.getByTestId("work-item")).toHaveTextContent("work-101"));
    expect(mocks.continueWorkItem.mock.calls).toEqual([
      [previous.workItemId, "accepted-report-1"], [previous.workItemId, "accepted-report-1"],
    ]);
    expect(screen.getByTestId("media-count")).toHaveTextContent("0");
    expect(screen.getByTestId("source-lots")).toHaveTextContent("0");
  });

  it("does not open an empty form for an already-used successor", async () => {
    seedHandoff();
    mocks.continueWorkItem.mockResolvedValueOnce({ ...freshSuccessor(), status: "report_created", reportId: "report-101" });
    render(<ReportFormPage kind="asset" />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue accepted report" }));
    expect(await screen.findByRole("link", { name: "Open reports" })).toHaveAttribute("href", "/reports");
    expect(screen.getByRole("status")).toHaveTextContent("next form already has a report");
    expect(screen.queryByTestId("asset-handoff")).not.toBeInTheDocument();
  });

  it("rejects an unsafe continuation payload while keeping the accepted boundary", async () => {
    seedHandoff();
    mocks.continueWorkItem.mockResolvedValueOnce({ ...freshSuccessor(), lots: importedSetup.lots });
    render(<ReportFormPage kind="asset" />);
    fireEvent.click(await screen.findByRole("button", { name: "Continue accepted report" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("fresh form could not be confirmed");
    expect(screen.queryByTestId("asset-handoff")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry open new form" })).toBeInTheDocument();
  });

  it("keeps ordinary accepted submission navigation unchanged", async () => {
    seedHandoff();
    render(<ReportFormPage kind="asset" />);
    expect(await screen.findByText("Complete details, organize media, and save or submit when ready.")).not.toHaveClass("freshLotDescription");
    expect(screen.getByRole("heading", { level: 1 }).closest("header")).not.toHaveClass("freshLotHeader");
    fireEvent.click(await screen.findByRole("button", { name: "Normal submit accepted" }));
    expect(mocks.routerPush).toHaveBeenCalledExactlyOnceWith("/previews");
    expect(mocks.continueWorkItem).not.toHaveBeenCalled();
  });

  it("verifies an imported server draft before mounting it with the same submission identity", async () => {
    seedServerDraft();
    let resolveSetup!: (setup: AuctioneerWorkItemSetup) => void;
    mocks.getSetup.mockImplementationOnce(() => new Promise((resolve) => { resolveSetup = resolve; }));
    render(<ReportFormPage kind="asset" />);
    await waitFor(() => expect(mocks.getSetup).toHaveBeenCalledOnce());
    expect(screen.queryByTestId("asset-handoff")).not.toBeInTheDocument();
    await act(async () => { resolveSetup(freshSuccessor()); });
    expect(await screen.findByTestId("work-item")).toHaveTextContent("work-101");
    expect(screen.getByTestId("submission")).toHaveTextContent("submission-101");
    expect(screen.getByTestId("resume-state")).toHaveTextContent("resume");
    expect(screen.getByRole("button", { name: "Continue accepted report" })).toBeInTheDocument();
  });

  it("keeps an unavailable imported draft closed and retries only its setup GET", async () => {
    seedServerDraft();
    mocks.getSetup.mockRejectedValueOnce(new Error("Setup unavailable")).mockResolvedValueOnce(freshSuccessor());
    render(<ReportFormPage kind="asset" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Setup unavailable");
    expect(screen.queryByTestId("asset-handoff")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry imported draft" }));
    expect(await screen.findByTestId("work-item")).toHaveTextContent("work-101");
    expect(mocks.getSetup).toHaveBeenCalledTimes(2);
    expect(mocks.continueWorkItem).not.toHaveBeenCalled();
  });

  it("reopens a saved interrupted upload only when the backend confirms that same report is unaccepted", async () => {
    seedServerDraft();
    mocks.getSetup.mockResolvedValueOnce({
      ...freshSuccessor(), status: "report_created", reportId: "upload-placeholder-101", canResumeUpload: true,
    });
    render(<ReportFormPage kind="asset" />);
    expect(await screen.findByTestId("work-item")).toHaveTextContent("work-101");
    expect(screen.getByTestId("submission")).toHaveTextContent("submission-101");
    expect(screen.getByTestId("resume-state")).toHaveTextContent("resume");
    expect(mocks.continueWorkItem).not.toHaveBeenCalled();
  });

  it.each([
    { type: "lotListing" },
    { clientDraftId: "different-draft" },
    { contractNo: "" },
    { formData: { auctioneerWorkItemId: "work-101", clientSubmissionId: "different-submission" } },
    { formData: { auctioneerWorkItemId: "work-101" } },
  ])("does not apply an upload-resume capability to mismatched saved context: %j", async (change) => {
    seedServerDraft();
    const handoff = JSON.parse(window.sessionStorage.getItem("cv:report-form-handoff:v1")!);
    Object.assign(handoff.resumeDraft, change);
    window.sessionStorage.setItem("cv:report-form-handoff:v1", JSON.stringify(handoff));
    mocks.getSetup.mockResolvedValueOnce({ ...freshSuccessor(), status: "report_created", reportId: "upload-placeholder-101", canResumeUpload: true });
    render(<ReportFormPage kind="asset" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("can no longer be opened as a new report");
    expect(screen.queryByTestId("asset-handoff")).not.toBeInTheDocument();
  });

  it.each([
    { status: "report_created" },
    { status: "report_created", reportId: "accepted-report", canResumeUpload: false },
    { status: "report_created", canResumeUpload: true },
    { status: "claimed", reportId: "linked-report" },
    { status: "sent" },
    { status: "abandoned" },
    { status: undefined },
    { clientSubmissionId: "other-submission" },
    { workItemId: "other-work" },
    { reportType: "lotListing" },
    { contract: { ...importedSetup.contract, contractNo: "other-contract" } },
  ])("does not reopen an integrated draft after its setup changed: %j", async (change) => {
    seedServerDraft();
    mocks.getSetup.mockResolvedValueOnce({ ...freshSuccessor(), ...change });
    render(<ReportFormPage kind="asset" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("can no longer be opened as a new report");
    expect(screen.queryByTestId("asset-handoff")).not.toBeInTheDocument();
  });

  it("fails closed for an invalid imported draft reference", async () => {
    seedServerDraft(123);
    render(<ReportFormPage kind="asset" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("reference is invalid");
    expect(mocks.getSetup).not.toHaveBeenCalled();
    expect(screen.queryByTestId("asset-handoff")).not.toBeInTheDocument();
  });

  it("does not request Auctioneer setup for ordinary drafts", async () => {
    seedServerDraft();
    const ordinary = JSON.parse(window.sessionStorage.getItem("cv:report-form-handoff:v1")!);
    ordinary.resumeDraft.formData = {};
    window.sessionStorage.setItem("cv:report-form-handoff:v1", JSON.stringify(ordinary));
    render(<ReportFormPage kind="asset" />);
    expect(await screen.findByTestId("asset-handoff")).toHaveTextContent("No imported contract");
    expect(mocks.getSetup).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Continue accepted report" })).not.toBeInTheDocument();
  });

  it("aborts setup verification when the draft page is left", async () => {
    seedServerDraft();
    mocks.getSetup.mockReturnValueOnce(new Promise(() => {}));
    const { unmount } = render(<ReportFormPage kind="asset" />);
    await waitFor(() => expect(mocks.getSetup).toHaveBeenCalledOnce());
    const signal = mocks.getSetup.mock.calls[0][1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });
});
