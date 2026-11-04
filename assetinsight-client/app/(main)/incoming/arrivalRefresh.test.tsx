import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SWRConfig, useSWRConfig, unstable_serialize } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import IncomingPage from "./page";
import { advanceAuthSession, captureAuthSession } from "@/lib/auth-storage";
import { arrivalPhotoListKey, invalidateArrivalPhotoLists } from "@/services/arrivalPhotoCache";

const mocks = vi.hoisted(() => ({
  waiting: vi.fn(), completed: vi.fn(), incoming: vi.fn(), status: vi.fn(),
  owner: "user-1", search: "tab=arrival", replace: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mocks.search),
  useRouter: () => ({ push: vi.fn(), replace: mocks.replace }),
}));
vi.mock("@/context/AuthContext", () => ({
  useAuthContext: () => ({ user: { _id: mocks.owner }, loading: false }),
}));
vi.mock("@/services/auctioneer", async (original) => ({
  ...await original<typeof import("@/services/auctioneer")>(),
  default: { getIncoming: mocks.incoming, getStatus: mocks.status,
    getArrivalPhotoRequests: mocks.waiting, getCompletedArrivalPhotoRequests: mocks.completed },
}));
const request = {
  requestId: "sent-request", requestedAt: "2026-11-04T18:00:00Z", requestedBy: "Office",
  receivedAt: "2026-11-04T19:00:00Z", photoCount: 3, officeOnlyPhotoCount: 0,
  lotId: "lot-1", lotNumber: "900", description: "Synthetic received photos", contractNumber: "QA-1",
};
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
function cacheOptions() {
  const cache = new Map();
  return { cache, options: { provider: () => cache, dedupingInterval: 10_000,
    keepPreviousData: true, shouldRetryOnError: false, revalidateOnFocus: false, revalidateOnReconnect: false } };
}
function ConfirmedSend({ done }: { done: () => void }) {
  const { mutate } = useSWRConfig();
  return <button onClick={async () => {
    await invalidateArrivalPhotoLists(mutate, mocks.owner, captureAuthSession());
    done();
  }}>Confirmed send</button>;
}
beforeEach(() => {
  mocks.owner = "user-1"; mocks.search = "tab=arrival";
  mocks.waiting.mockReset().mockResolvedValue([]);
  mocks.completed.mockReset().mockResolvedValue([]);
  mocks.incoming.mockReset().mockResolvedValue([]);
  mocks.status.mockReset().mockResolvedValue({ enabled: true, configured: true });
  mocks.replace.mockReset();
});

describe("Arrival list refresh", () => {
  it("discards held pre-send reads and refetches both lists in the same provider after navigation", async () => {
    const oldCompleted = deferred<unknown[]>();
    const oldWaiting = deferred<unknown[]>();
    mocks.completed.mockReturnValueOnce(oldCompleted.promise).mockResolvedValue([request]);
    mocks.waiting.mockReturnValueOnce(oldWaiting.promise).mockResolvedValue([]);
    const { options } = cacheOptions();
    const view = render(<SWRConfig value={options}><IncomingPage /></SWRConfig>);
    await waitFor(() => expect(mocks.completed).toHaveBeenCalledTimes(1));
    const done = vi.fn();
    view.rerender(<SWRConfig value={options}><ConfirmedSend done={done} /></SWRConfig>);
    fireEvent.click(screen.getByRole("button", { name: "Confirmed send" }));
    await waitFor(() => expect(done).toHaveBeenCalledOnce());
    mocks.search = "tab=arrival&view=completed";
    view.rerender(<SWRConfig value={options}><IncomingPage /></SWRConfig>);
    await screen.findByText(request.description);
    expect(mocks.completed).toHaveBeenCalledTimes(2);
    expect(mocks.waiting).toHaveBeenCalledTimes(2);
    await act(async () => { oldCompleted.resolve([]); oldWaiting.resolve([request]); });
    expect(screen.getByText(request.description)).toBeInTheDocument();
    expect(screen.queryByText("No arrival photos sent yet")).not.toBeInTheDocument();
    const tabs = screen.getByRole("tablist", { name: "Arrival photo requests" });
    expect(within(tabs).getByRole("tab", { name: /Waiting 0/ })).toBeInTheDocument();
    expect(within(tabs).getByRole("tab", { name: /Completed 1/ })).toBeInTheDocument();
  });

  it.each(["waiting", "completed"] as const)("Refresh fetches the selected %s Arrival list, not contracts", async (selected) => {
    mocks.search = `tab=arrival&view=${selected}`;
    const { options } = cacheOptions();
    render(<SWRConfig value={options}><IncomingPage /></SWRConfig>);
    const refresh = await screen.findByRole("button", { name: "Refresh" });
    await waitFor(() => expect(refresh).toBeEnabled());
    const selectedRead = selected === "completed" ? mocks.completed : mocks.waiting;
    const otherRead = selected === "completed" ? mocks.waiting : mocks.completed;
    await waitFor(() => expect(mocks.completed).toHaveBeenCalledTimes(1));
    const newRead = deferred<unknown[]>();
    selectedRead.mockReturnValueOnce(newRead.promise);
    fireEvent.click(refresh);
    await waitFor(() => expect(selectedRead).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Refreshing…" })).toBeDisabled();
    expect(otherRead).toHaveBeenCalledTimes(1);
    expect(mocks.incoming).toHaveBeenCalledTimes(1);
    await act(async () => newRead.resolve([request]));
    await screen.findByText(request.description);
  });

  it.each(["account", "new login"])("does not display or adopt previous Arrival results after a %s change", async (change) => {
    mocks.search = "tab=arrival&view=completed";
    mocks.completed.mockResolvedValueOnce([request]);
    const { options } = cacheOptions();
    const view = render(<SWRConfig value={options}><IncomingPage /></SWRConfig>);
    await screen.findByText(request.description);
    const oldRead = deferred<unknown[]>();
    mocks.completed.mockReturnValueOnce(oldRead.promise);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(mocks.completed).toHaveBeenCalledTimes(2));
    const currentRead = deferred<unknown[]>();
    mocks.completed.mockReturnValueOnce(currentRead.promise);
    if (change === "account") mocks.owner = "user-2";
    advanceAuthSession();
    view.rerender(<SWRConfig value={options}><IncomingPage /></SWRConfig>);
    await waitFor(() => expect(mocks.completed).toHaveBeenCalledTimes(3));
    expect(screen.queryByText(request.description)).not.toBeInTheDocument();
    await act(async () => oldRead.resolve([{ ...request, description: "Late previous account" }]));
    expect(screen.queryByText("Late previous account")).not.toBeInTheDocument();
    await act(async () => currentRead.resolve([{ ...request, description: "Current account photos" }]));
    await screen.findByText("Current account photos");
    expect(screen.queryByText(request.description)).not.toBeInTheDocument();
  });

  it("does not invalidate another owner or a newer login when an old receipt arrives", async () => {
    const oldSession = captureAuthSession();
    advanceAuthSession();
    const currentSession = captureAuthSession();
    const { cache, options } = cacheOptions();
    const currentKey = unstable_serialize(arrivalPhotoListKey("user-1", currentSession.revision, "completed"));
    cache.set(currentKey, { data: [request] });
    const done = vi.fn();
    function StaleReceipt() {
      const { mutate } = useSWRConfig();
      return <button onClick={async () => {
        await invalidateArrivalPhotoLists(mutate, "user-1", oldSession); done();
      }}>Stale receipt</button>;
    }
    render(<SWRConfig value={options}><StaleReceipt /></SWRConfig>);
    fireEvent.click(screen.getByRole("button", { name: "Stale receipt" }));
    await waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(cache.get(currentKey).data).toEqual([request]);
    expect(mocks.completed).not.toHaveBeenCalled();
  });
});
