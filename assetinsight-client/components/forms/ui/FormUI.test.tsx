import { useState } from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  DraftSaveProgressPanel,
  DraftStatusIndicator,
  FormField,
  FormSection,
  FormTransferProgressScreen,
} from "./FormUI";

function MultiSectionHarness() {
  const [open, setOpen] = useState({ first: true, second: false });
  return (
    <>
      <FormSection
        id="first"
        title="First section"
        open={open.first}
        onOpenChange={(next) =>
          setOpen((current) => ({ ...current, first: next }))
        }
      >
        <p>First content</p>
      </FormSection>
      <FormSection
        id="second"
        title="Second section"
        open={open.second}
        onOpenChange={(next) =>
          setOpen((current) => ({ ...current, second: next }))
        }
      >
        <p>Second content</p>
      </FormSection>
    </>
  );
}

describe("FormSection", () => {
  it("uses native disclosure buttons and allows multiple sections to stay open", () => {
    render(<MultiSectionHarness />);

    const first = screen.getByRole("button", { name: /first section/i });
    const second = screen.getByRole("button", { name: /second section/i });
    expect(first.tagName).toBe("BUTTON");
    expect(first).toHaveAttribute("aria-expanded", "true");
    expect(second).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(second);
    expect(first).toHaveAttribute("aria-expanded", "true");
    expect(second).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Second content").parentElement).not.toHaveAttribute(
      "hidden"
    );
  });

  it("reveals a newly invalid section and focuses its first invalid control", async () => {
    const requestAnimationFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    function Harness() {
      const [invalid, setInvalid] = useState(false);
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setInvalid(true)}>
            Validate
          </button>
          <FormSection
            id="details"
            title="Details"
            open={open}
            onOpenChange={setOpen}
            status={invalid ? "error" : "default"}
            errorSummary={invalid ? "One field needs attention" : undefined}
          >
            <FormField
              id="required-name"
              label="Name"
              required
              error={invalid ? "Enter a name" : undefined}
            >
              <input />
            </FormField>
          </FormSection>
        </>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Validate" }));

    const sectionButton = screen.getByRole("button", { name: /details/i });
    const input = screen.getByLabelText(/name/i);
    await waitFor(() => expect(sectionButton).toHaveAttribute("aria-expanded", "true"));
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Enter a name");

    requestAnimationFrame.mockRestore();
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      });
    } else {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown })
        .scrollIntoView;
    }
  });
});

describe("shared form semantics", () => {
  it("associates labels, hints, required state, and errors with controls", () => {
    render(
      <FormField
        id="currency"
        label="Currency"
        required
        hint="Use an ISO code"
        error="Currency is invalid"
      >
        <input />
      </FormField>
    );

    const input = screen.getByLabelText(/currency/i);
    expect(input).toHaveAttribute("aria-required", "true");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(
      "Use an ISO code Currency is invalid"
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Currency is invalid");
  });

  it("announces honest header draft status", () => {
    const { rerender } = render(<DraftStatusIndicator status="saving" />);
    expect(screen.getByRole("status")).toHaveTextContent("Saving draft");

    rerender(
      <DraftStatusIndicator status="partial" label="Saved on this device only" />
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Saved on this device only"
    );
  });

  it("shows server draft media progress and tells the user to wait", () => {
    render(
      <DraftSaveProgressPanel
        progress={{
          phase: "uploading",
          percent: 42,
          message: "Saving draft media 4 of 10",
          totalFiles: 10,
          uploadedFiles: 4,
          totalBytes: 10 * 1024 * 1024,
          uploadedBytes: 4 * 1024 * 1024,
        }}
      />
    );

    expect(screen.getByRole("progressbar", { name: /draft save progress/i }))
      .toHaveAttribute("aria-valuenow", "42");
    expect(screen.getByText(/4 of 10 files/i)).toBeInTheDocument();
    expect(screen.getByText(/keep this form open/i)).toBeInTheDocument();
  });

  it("shows a responsive draft-save-only screen with recoverability guidance", () => {
    const onCancel = vi.fn();
    render(
      <FormTransferProgressScreen
        mode="draft-save"
        percent={42}
        message="Saving draft media 4 of 10"
        totalFiles={10}
        transferredFiles={4}
        totalBytes={10 * 1024 * 1024}
        transferredBytes={4 * 1024 * 1024}
        onCancel={onCancel}
      />
    );

    expect(
      screen.getByRole("dialog", { name: "Saving your draft" })
    ).toHaveAttribute("aria-modal", "true");
    expect(
      screen.getByRole("progressbar", { name: "Draft save progress" })
    ).toHaveAttribute("aria-valuenow", "42");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Saving draft media 4 of 10"
    );
    expect(screen.getByText("4 of 10")).toBeInTheDocument();
    expect(screen.getByText("4.0 MB of 10.0 MB")).toBeInTheDocument();
    expect(
      screen.getByText(/if you leave before saving finishes/i)
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel save" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("supports report upload totals and an accessible stopping state", () => {
    const onCancel = vi.fn();
    render(
      <FormTransferProgressScreen
        mode="report-upload"
        percent={140}
        message="Uploading listing media"
        totalFiles={8}
        totalBytes={2 * 1024 * 1024}
        cancelling
        onCancel={onCancel}
      />
    );

    expect(
      screen.getByRole("dialog", { name: "Uploading your report" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: "Report upload progress" })
    ).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByRole("status")).toHaveTextContent("Stopping upload");
    expect(screen.getByText("8 total")).toBeInTheDocument();
    expect(screen.getByText("2.0 MB")).toBeInTheDocument();
    expect(
      screen.getByText(/leaving before the upload finishes/i)
    ).toBeInTheDocument();

    const stopButton = screen.getByRole("button", { name: "Stopping upload…" });
    expect(stopButton).toBeDisabled();
    fireEvent.click(stopButton);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("traps focus, cancels with Escape, disables cancellation while finalizing, and restores focus", async () => {
    const previouslyFocused = document.createElement("button");
    previouslyFocused.textContent = "Open transfer";
    document.body.appendChild(previouslyFocused);
    previouslyFocused.focus();
    const onCancel = vi.fn();
    const requestAnimationFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback) => {
        callback(0);
        return 1;
      });
    const cancelAnimationFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation(() => undefined);
    const transfer = render(
      <FormTransferProgressScreen
        mode="report-upload"
        percent={55}
        message="Uploading report media"
        onCancel={onCancel}
      />
    );
    let unmounted = false;

    try {
      const cancelButton = screen.getByRole("button", { name: "Stop upload" });
      await waitFor(() => expect(cancelButton).toHaveFocus());

      previouslyFocused.focus();
      fireEvent.keyDown(document, { key: "Tab" });
      expect(cancelButton).toHaveFocus();

      fireEvent.keyDown(document, { key: "Escape" });
      expect(onCancel).toHaveBeenCalledOnce();
      onCancel.mockClear();

      transfer.rerender(
        <FormTransferProgressScreen
          mode="report-upload"
          percent={100}
          message="Upload accepted"
          finalizing
          onCancel={onCancel}
        />
      );

      const dialog = screen.getByRole("dialog", {
        name: "Uploading your report",
      });
      await waitFor(() => expect(dialog).toHaveFocus());
      expect(
        screen.queryByRole("button", { name: /stop upload/i })
      ).not.toBeInTheDocument();
      expect(screen.getAllByText("Report accepted · finalizing…")).not.toHaveLength(0);

      fireEvent.keyDown(document, { key: "Escape" });
      expect(onCancel).not.toHaveBeenCalled();
      previouslyFocused.focus();
      fireEvent.keyDown(document, { key: "Tab" });
      expect(dialog).toHaveFocus();

      transfer.unmount();
      unmounted = true;
      expect(previouslyFocused).toHaveFocus();
    } finally {
      if (!unmounted) transfer.unmount();
      requestAnimationFrame.mockRestore();
      cancelAnimationFrame.mockRestore();
      previouslyFocused.remove();
    }
  });
});
