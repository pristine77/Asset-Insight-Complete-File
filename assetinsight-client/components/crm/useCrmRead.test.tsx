import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCrmRead } from "./useCrmRead";

afterEach(cleanup);
function Consumer({ id, read }: { id: string; read: (signal: AbortSignal) => Promise<string> }) {
  const result = useCrmRead("crm:owner:test", read);
  return <div data-testid={id}>{result.error ? "error" : result.data || "loading"}</div>;
}
describe("owner-scoped CRM reads", () => {
  it("survives StrictMode effect replay without cancelling the first read", async () => {
    let resolve!: (value: string) => void;
    const read = vi.fn((_signal: AbortSignal) => new Promise<string>((done) => { resolve = done; }));
    render(<StrictMode><SWRConfig value={{ provider: () => new Map() }}><Consumer id="one" read={read} /></SWRConfig></StrictMode>);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(read.mock.calls[0][0].aborted).toBe(false);
    await act(async () => resolve("ready"));
    expect(screen.getByTestId("one")).toHaveTextContent("ready");
  });
  it("does not abort a shared request when one of two consumers leaves", async () => {
    let resolve!: (value: string) => void;
    const read = vi.fn((_signal: AbortSignal) => new Promise<string>((done) => { resolve = done; }));
    const cache = new Map();
    const view = (first: boolean) => <SWRConfig value={{ provider: () => cache }}>{first && <Consumer id="one" read={read} />}<Consumer id="two" read={read} /></SWRConfig>;
    const rendered = render(view(true));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    rendered.rerender(view(false));
    await act(async () => { await Promise.resolve(); });
    expect(read.mock.calls[0][0].aborted).toBe(false);
    await act(async () => resolve("ready"));
    expect(screen.getByTestId("two")).toHaveTextContent("ready");
  });
});
