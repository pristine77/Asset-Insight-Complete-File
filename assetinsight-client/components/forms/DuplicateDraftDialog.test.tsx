import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DuplicateDraftDialog from "./DuplicateDraftDialog";

describe("DuplicateDraftDialog", () => {
  it("shows the recovery action and opens the draft callback", () => {
    const onCheckDraft = vi.fn();
    render(
      <DuplicateDraftDialog
        open
        message="This lot number already exists under the same contract."
        onClose={vi.fn()}
        onCheckDraft={onCheckDraft}
      />
    );

    expect(
      screen.getByRole("heading", { name: "Duplicate Detected" })
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Check Draft Report" })
    );
    expect(onCheckDraft).toHaveBeenCalledTimes(1);
  });

  it("closes with Escape", () => {
    const onClose = vi.fn();
    render(
      <DuplicateDraftDialog
        open
        message="A matching draft exists."
        onClose={onClose}
        onCheckDraft={vi.fn()}
      />
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
