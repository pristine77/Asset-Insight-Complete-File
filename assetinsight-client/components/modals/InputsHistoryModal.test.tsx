/**
 * Drafts window: a draft kept after its upload was accepted shows again only
 * when its report stopped without a preview, with the reason (2026-11-05).
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import InputsHistoryModal from "./InputsHistoryModal";

const mocks = vi.hoisted(() => ({ list: vi.fn(), delete: vi.fn(), localDelete: vi.fn(), smartDelete: vi.fn(), error: vi.fn(), success: vi.fn(), userId: "user-1" }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/context/AuthContext", () => ({ useAuthContext: () => ({ user: { _id: mocks.userId } }) }));
vi.mock("@/components/forms/drafts/storage", () => ({
  deleteScopedDraft: mocks.localDelete,
  listScopedDrafts: vi.fn(async () => []),
}));
vi.mock("@/components/forms/smartUpload/storage", () => ({ deleteSmartUploadDraft: mocks.smartDelete }));
vi.mock("@/services/reportDrafts", () => ({
  ReportDraftService: { list: mocks.list, delete: mocks.delete },
  draftKindForRecord: (draft: any) => (draft.type === "lotListing" ? "lot-listing" : "asset"),
}));
vi.mock("@/services/reportFormNavigation", () => ({ navigateToReportForm: vi.fn() }));
vi.mock("@/services/savedInputs", () => ({ SavedInputService: { getAll: vi.fn(async () => []) } }));
vi.mock("@/components/ui/toast", () => ({ toast: { error: mocks.error, success: mocks.success, info: vi.fn() } }));

const base = {
  user: "user-1", type: "asset", storageMode: "r2_media", revision: 3, contractNo: "95200", formData: {},
  lots: [{}, {}], media: [], createdAt: "2026-11-04T15:00:00.000Z", updatedAt: "2026-11-04T15:05:00.000Z",
};

describe("Drafts window", () => {
  beforeEach(() => {
    for (const value of Object.values(mocks)) if (typeof value === "function") value.mockReset();
    mocks.userId = "user-1";
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  const draft = { ...base, _id: "kept", clientDraftId: "kept", discardRevision: "a".repeat(64) };

  it("discards the displayed snapshot and clears local copies only after confirmation", async () => {
    mocks.list.mockResolvedValue([draft]);
    let done!: () => void;
    mocks.delete.mockReturnValue(new Promise<void>((resolve) => { done = resolve; }));
    render(<InputsHistoryModal isOpen onClose={vi.fn()} onLoadInput={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete 95200" }));
    expect(mocks.delete).toHaveBeenCalledExactlyOnceWith("kept", draft.discardRevision);
    expect(mocks.localDelete).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete 95200" })).toBeInTheDocument();
    done();
    await waitFor(() => expect(mocks.localDelete).toHaveBeenCalledExactlyOnceWith("user-1", "asset", "kept"));
    expect(mocks.smartDelete).toHaveBeenCalledExactlyOnceWith("user-1", "asset", "kept");
    expect(screen.queryByRole("button", { name: "Delete 95200" })).not.toBeInTheDocument();
  });

  it.each(["conflict", "uncertain"])("keeps the row and local photos on %s without fetching a newer token", async (failure) => {
    mocks.list.mockResolvedValue([draft]);
    mocks.delete.mockRejectedValue(failure === "conflict" ? { response: { status: 409, data: { message: "Draft changed. Reopen Drafts." } } } : new Error("Deletion unconfirmed"));
    render(<InputsHistoryModal isOpen onClose={vi.fn()} onLoadInput={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete 95200" }));
    await waitFor(() => expect(mocks.error).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Delete 95200" })).toBeInTheDocument();
    expect(mocks.localDelete).not.toHaveBeenCalled();
    expect(mocks.smartDelete).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("does not clear local copies for a late receipt after switching accounts", async () => {
    mocks.list.mockResolvedValue([draft]);
    let done!: () => void;
    mocks.delete.mockReturnValue(new Promise<void>((resolve) => { done = resolve; }));
    const props = { isOpen: true, onClose: vi.fn(), onLoadInput: vi.fn() };
    const view = render(<InputsHistoryModal {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete 95200" }));
    mocks.userId = "user-2";
    view.rerender(<InputsHistoryModal {...props} />);
    done();
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    expect(mocks.localDelete).not.toHaveBeenCalled();
    expect(mocks.smartDelete).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("notes a kept draft whose report stopped, and leaves ordinary drafts plain", async () => {
    mocks.list.mockResolvedValue([
      { ...base, _id: "kept", clientDraftId: "kept", title: "Dustin Hawkins",
        submission: { status: "failed", reportId: "r1", reportType: "asset", message: "Duplicate lot number 1.",
          sentAt: "2026-11-04T15:06:00.000Z", failedAt: "2026-11-04T15:09:00.000Z" } },
      { ...base, _id: "plain", clientDraftId: "plain", contractNo: "95201" },
    ]);
    render(<InputsHistoryModal isOpen onClose={vi.fn()} onLoadInput={vi.fn()} />);
    const list = await screen.findByRole("list", { name: "Report drafts" });
    const notes = within(list).getAllByTestId("draft-submission-failed");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toHaveTextContent("processing stopped: Duplicate lot number 1.");
    expect(notes[0]).toHaveTextContent("Use Retry on the report in Previews");
  });
});
