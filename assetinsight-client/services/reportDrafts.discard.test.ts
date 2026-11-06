import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ delete: vi.fn() }));
vi.mock("@/lib/api", () => ({ default: { delete: mocks.delete } }));
import { ReportDraftService } from "./reportDrafts";
import { advanceAuthSession } from "@/lib/auth-storage";

const revision = "a".repeat(64);

describe("explicit draft discard", () => {
  beforeEach(() => { mocks.delete.mockReset(); });

  it("sends only the displayed snapshot and requires an exact deletion receipt", async () => {
    mocks.delete.mockResolvedValue({ status: 200, data: { deleted: true, draftId: "draft-1" } });
    await ReportDraftService.delete("draft-1", revision);
    expect(mocks.delete).toHaveBeenCalledExactlyOnceWith("/report-drafts/draft-1", expect.objectContaining({
      data: { intent: "discard", baseRevision: revision }, _retry: true, timeout: 60_000,
      _authSession: expect.objectContaining({ revision: expect.any(Number) }),
    }));
  });

  it.each([undefined, "", "old", "A".repeat(64)])("refuses missing or malformed snapshot %s before a request", async (token) => {
    await expect(ReportDraftService.delete("draft-1", token)).rejects.toThrow("Reopen Drafts");
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it.each([
    { status: 200, data: { retained: true } },
    { status: 200, data: { deleted: true, draftId: "other" } },
    { status: 200, data: { deleted: false, draftId: "draft-1" } },
    { status: 200, data: { deleted: true, retained: true, draftId: "draft-1" } },
    { status: 202, data: { deleted: true, draftId: "draft-1" } },
  ])("refuses an uncertain receipt without another DELETE", async (response) => {
    mocks.delete.mockResolvedValue(response);
    await expect(ReportDraftService.delete("draft-1", revision)).rejects.toThrow("did not confirm");
    expect(mocks.delete).toHaveBeenCalledTimes(1);
  });

  it.each([409, 401, 503])("does not replay HTTP %s", async (status) => {
    mocks.delete.mockRejectedValue({ response: { status } });
    await expect(ReportDraftService.delete("draft-1", revision)).rejects.toMatchObject({ response: { status } });
    expect(mocks.delete).toHaveBeenCalledTimes(1);
  });

  it("rejects a late receipt after account/session change", async () => {
    mocks.delete.mockImplementation(async () => {
      advanceAuthSession();
      return { status: 200, data: { deleted: true, draftId: "draft-1" } };
    });
    await expect(ReportDraftService.delete("draft-1", revision)).rejects.toMatchObject({ code: "ERR_CANCELED" });
  });

  it("leaves automatic accepted-upload cleanup without discard intent", async () => {
    await ReportDraftService.deleteByClientId("client-1", "asset");
    expect(mocks.delete).toHaveBeenCalledExactlyOnceWith("/report-drafts/client/client-1", { params: { type: "asset" } });
  });
});
