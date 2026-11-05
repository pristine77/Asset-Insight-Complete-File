import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { advanceAuthSession } from "@/lib/auth-storage";
import { getInitialPreviewRetry, retryInitialPreview } from "@/services/initialPreviewRetry";
import InitialPreviewRetry from "./InitialPreviewRetry";
vi.mock("@/services/initialPreviewRetry", () => ({ getInitialPreviewRetry: vi.fn(), retryInitialPreview: vi.fn() }));
const eligible = { initialPreviewRetryEligible: true, initialPreviewRetryRevision: "a".repeat(64), initialPreviewRetryIneligibleReason: null };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(getInitialPreviewRetry).mockResolvedValue(eligible); });
describe("initial-preview recovery action", () => {
  it("does not allow a second click during an uncertain request and refreshes only on confirmed queueing", async () => {
    let finish!: (value: "queued") => void;
    vi.mocked(retryInitialPreview).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const queued = vi.fn(); render(<InitialPreviewRetry reportId="one" kind="asset" onQueued={queued} />);
    const button = await screen.findByRole("button", { name: "Retry preview processing" });
    fireEvent.click(button); fireEvent.click(button);
    expect(retryInitialPreview).toHaveBeenCalledOnce(); expect(queued).not.toHaveBeenCalled();
    await act(async () => finish("queued"));
    expect(queued).toHaveBeenCalledOnce(); expect(screen.getByRole("status")).toHaveTextContent("Preview processing queued");
  });
  it("keeps the report visible and requires a fresh capability after a conflict", async () => {
    vi.mocked(retryInitialPreview).mockRejectedValue({ response: { status: 409 } });
    render(<InitialPreviewRetry reportId="one" kind="asset" onQueued={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry preview processing" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("report changed");
    expect(screen.queryByRole("button", { name: "Retry preview processing" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh recovery status" }));
    expect(await screen.findByRole("button", { name: "Retry preview processing" })).toBeEnabled();
    expect(getInitialPreviewRetry).toHaveBeenCalledTimes(2);
  });
  it("does not claim recovery when availability failed", async () => {
    vi.mocked(getInitialPreviewRetry).mockRejectedValue(new Error("offline"));
    render(<InitialPreviewRetry reportId="one" kind="asset" onQueued={vi.fn()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be checked");
    expect(retryInitialPreview).not.toHaveBeenCalled();
  });
  it("does not act on a late response after switching accounts", async () => {
    let finish!: (value: "queued") => void;
    vi.mocked(retryInitialPreview).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const queued = vi.fn(); render(<InitialPreviewRetry reportId="one" kind="asset" onQueued={queued} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry preview processing" }));
    advanceAuthSession(); await act(async () => finish("queued"));
    expect(queued).not.toHaveBeenCalled();
  });
  it("aborts the request when leaving the report", async () => {
    vi.mocked(retryInitialPreview).mockReturnValue(new Promise(() => {}));
    const view = render(<InitialPreviewRetry reportId="one" kind="asset" onQueued={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry preview processing" }));
    const signal = vi.mocked(retryInitialPreview).mock.calls[0][3]; view.unmount();
    await waitFor(() => expect(signal.aborted).toBe(true));
  });
});
