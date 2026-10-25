import { describe, expect, it, vi } from "vitest";
import { saveManualDraftOnly } from "./manualDraftSave";

describe("saveManualDraftOnly", () => {
  it("persists a draft and reports success without invoking report processing", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const onCommitted = vi.fn();

    await expect(
      saveManualDraftOnly(persist, onCommitted)
    ).resolves.toBe(true);

    expect(persist).toHaveBeenCalledOnce();
    expect(onCommitted).toHaveBeenCalledOnce();
  });

  it("does not report success when the durable revision was not committed", async () => {
    const onCommitted = vi.fn();

    await expect(
      saveManualDraftOnly(
        vi.fn().mockResolvedValue(false),
        onCommitted
      )
    ).resolves.toBe(false);

    expect(onCommitted).not.toHaveBeenCalled();
  });

  it("propagates persistence failures without reporting success", async () => {
    const onCommitted = vi.fn();

    await expect(
      saveManualDraftOnly(
        vi.fn().mockRejectedValue(new Error("draft upload failed")),
        onCommitted
      )
    ).rejects.toThrow("draft upload failed");

    expect(onCommitted).not.toHaveBeenCalled();
  });
});
