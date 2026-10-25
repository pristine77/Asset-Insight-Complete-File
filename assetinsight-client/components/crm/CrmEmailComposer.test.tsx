import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CrmEmailComposer from "./CrmEmailComposer";

const rewriteEmail = vi.hoisted(() => vi.fn());
vi.mock("@/services/crm", async (importOriginal) => ({ ...await importOriginal<typeof import("@/services/crm")>(), default: { rewriteEmailWithAI: rewriteEmail, transcribeCommentAudio: vi.fn() } }));
beforeEach(() => rewriteEmail.mockReset());

describe("CRM email composer", () => {
  it("preserves editable multiline text and opens an encoded email draft without claiming delivery", () => {
    render(<CrmEmailComposer clientName="Alex" email="alex@example.test" user={{ id: "owner", name: "Agent", company: "Company" }} onBack={vi.fn()} />);
    const message = screen.getByLabelText("Message");
    message.focus();
    fireEvent.change(message, { target: { value: "First line\nSecond line" } });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "Review request" } });
    expect(screen.getByLabelText("Message")).toBe(message);
    expect(message).toHaveFocus();
    const link = screen.getByRole("link", { name: "Open email app" });
    expect(link).toHaveAttribute("href", expect.stringContaining("mailto:alex%40example.test?subject=Review%20request&body=First%20line%0ASecond%20line"));
    expect(screen.queryByText(/email sent/i)).not.toBeInTheDocument();
    expect(rewriteEmail).not.toHaveBeenCalled();
  });

  it("requires text for rewrite, locks repeat requests and turns returned HTML into editable plain text", async () => {
    let resolve!: (value: { subject: string; body: string }) => void;
    rewriteEmail.mockReturnValue(new Promise((done) => { resolve = done; }));
    const { container } = render(<CrmEmailComposer clientName="Alex" user={{ id: "owner" }} onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Software rewrite" }));
    expect(rewriteEmail).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Please review" } });
    fireEvent.click(screen.getByRole("button", { name: "Software rewrite" }));
    expect(screen.getByRole("button", { name: "Rewriting…" })).toBeDisabled();
    expect(screen.getByLabelText("Message")).toBeDisabled();
    await act(async () => resolve({ subject: "Review", body: '<p>Hello &amp; welcome</p><script>unsafe()</script><img src="https://example.test/pixel"><p>Review the details.</p>' }));
    await waitFor(() => expect(screen.getByLabelText("Message")).toHaveValue("Hello & welcome\n\nReview the details."));
    expect(container.querySelector("script,img")).toBeNull();
    expect(rewriteEmail).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight rewrite when the composer closes", async () => {
    let resolve!: (value: { subject: string; body: string }) => void;
    rewriteEmail.mockReturnValue(new Promise((done) => { resolve = done; }));
    const { unmount } = render(<CrmEmailComposer clientName="Alex" user={{ id: "owner" }} onBack={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Software rewrite" }));
    const signal = rewriteEmail.mock.calls[0][1].signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => resolve({ subject: "Late", body: "Late text" }));
  });
});
