/**
 * Drafts window: a draft kept after its upload was accepted shows again only
 * when its report stopped without a preview, with the reason (2026-11-05).
 */
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import InputsHistoryModal from "./InputsHistoryModal";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/context/AuthContext", () => ({ useAuthContext: () => ({ user: { _id: "user-1" } }) }));
vi.mock("@/components/forms/drafts/storage", () => ({
  deleteScopedDraft: vi.fn(),
  listScopedDrafts: vi.fn(async () => []),
}));
vi.mock("@/components/forms/smartUpload/storage", () => ({ deleteSmartUploadDraft: vi.fn() }));
vi.mock("@/services/reportDrafts", () => ({
  ReportDraftService: { list: mocks.list, remove: vi.fn() },
  draftKindForRecord: (draft: any) => (draft.type === "lotListing" ? "lot-listing" : "asset"),
}));
vi.mock("@/services/reportFormNavigation", () => ({ navigateToReportForm: vi.fn() }));
vi.mock("@/services/savedInputs", () => ({ SavedInputService: { getAll: vi.fn(async () => []) } }));
vi.mock("@/components/ui/toast", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const base = {
  user: "user-1", type: "asset", storageMode: "r2_media", revision: 3, contractNo: "95200", formData: {},
  lots: [{}, {}], media: [], createdAt: "2026-11-04T15:00:00.000Z", updatedAt: "2026-11-04T15:05:00.000Z",
};

describe("Drafts window", () => {
  beforeEach(() => mocks.list.mockReset());

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
