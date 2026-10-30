import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { useExclusivePreviewMutation } from "./useExclusivePreviewMutation";
import { usePreviewCurrencyConversion } from "./usePreviewCurrencyConversion";
import PreviewCurrencyControl from "./PreviewCurrencyControl";
import { advanceAuthSession } from "@/lib/auth-storage";

const mocks = vi.hoisted(() => ({ convert: vi.fn(), error: vi.fn(), info: vi.fn(), success: vi.fn(), save: vi.fn() }));
vi.mock("@/services/reportCurrency", () => ({ convertPreviewCurrency: mocks.convert }));
vi.mock("@/components/ui/toast", () => ({ toast: mocks }));
const initial = { currency: "CAD", lots: [{ title: "Edited lot", estimated_value: "CAD 10000", image_urls: ["kept.jpg"] }] };
const result = { preview_data: { ...initial, currency: "USD", lots: [{ ...initial.lots[0], estimated_value: "USD 7500" }], currency_conversion: { signed: "opaque-quote" } },
  quote: { fromCurrency: "CAD", toCurrency: "USD", rate: .75, asOf: "2026-10-30", sourceUrl: "https://www.bankofcanada.ca/rates/", sourceTitle: "Bank of Canada", quotedAt: "2026-10-30T09:00:00Z" } };
function Harness({ reportId = "report-A", open = true, assignedApproval = false }) {
  const [previewData, setPreviewData] = useState<any>(initial);
  const mutations = useExclusivePreviewMutation();
  const { convertCurrency, currencyQuote } = usePreviewCurrencyConversion({
    kind: "asset", reportId, contextKey: reportId, isOpen: open, assignedApproval, disabled: false,
    previewData, setPreviewData, ...mutations,
  });
  return <>
    <PreviewCurrencyControl key={`${reportId}:${previewData.currency}`} currency={previewData.currency}
      busy={mutations.activeMutation === "currency"} disabled={mutations.activeMutation !== null}
      onConvert={convertCurrency} quote={currencyQuote} />
    <output data-testid="data">{JSON.stringify(previewData)}</output>
    <output>{mutations.hasChanges ? "Changed" : "Unchanged"}</output>
    <button onClick={() => void convertCurrency("USD")}>Direct convert</button>
    <button onClick={() => { const lease = mutations.beginMutation("submit"); if (lease) { mocks.save(previewData); mutations.finishMutation(lease); } }}>Save</button>
    <button onClick={() => { setPreviewData({ ...previewData, note: "new local edit" }); mutations.setHasChanges(true); }}>Concurrent edit</button>
  </>;
}
function defer() { let resolve!: (value: typeof result) => void; let reject!: (error: Error) => void;
  const promise = new Promise<typeof result>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
beforeEach(() => { for (const fn of Object.values(mocks)) fn.mockReset(); mocks.convert.mockResolvedValue(result); });

it("selecting currency does not relabel amounts, and Save carries the signed conversion", async () => {
  render(<Harness assignedApproval />);
  fireEvent.change(screen.getByLabelText("Currency"), { target: { value: "USD" } });
  expect(mocks.convert).not.toHaveBeenCalled();
  expect(screen.getByTestId("data")).toHaveTextContent('"currency":"CAD"');
  fireEvent.click(screen.getByRole("button", { name: "Convert amounts" }));
  await screen.findByText("Changed");
  expect(screen.getByTestId("data")).toHaveTextContent("USD 7500");
  expect(screen.getByRole("link", { name: "Bank of Canada" })).toHaveAttribute("href", result.quote.sourceUrl);
  expect(screen.getByText(/1 CAD = 0.75 USD/)).toBeInTheDocument();
  expect(mocks.convert.mock.calls[0][4].assignedApproval).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(mocks.save).toHaveBeenCalledWith(result.preview_data);
});

it("serializes conversion with Save and ignores duplicate clicks", async () => {
  const pending = defer(); mocks.convert.mockReturnValue(pending.promise);
  render(<Harness />);
  fireEvent.click(screen.getByText("Direct convert")); fireEvent.click(screen.getByText("Direct convert"));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(mocks.convert).toHaveBeenCalledTimes(1); expect(mocks.save).not.toHaveBeenCalled();
  await act(async () => pending.resolve(result));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(mocks.save).toHaveBeenCalledWith(result.preview_data);
});

it("keeps original currency, values and unsaved edits on a rate lookup failure", async () => {
  mocks.convert.mockRejectedValue(new Error("No current exchange rate is available")); render(<Harness />);
  fireEvent.click(screen.getByText("Direct convert"));
  await waitFor(() => expect(mocks.error).toHaveBeenCalledWith("No current exchange rate is available"));
  expect(screen.getByTestId("data")).toHaveTextContent(JSON.stringify(initial));
  expect(screen.getByText("Unchanged")).toBeInTheDocument();
});

it("rejects stale results after report A-B-A navigation or closing", async () => {
  const pending = defer(); mocks.convert.mockReturnValue(pending.promise);
  const view = render(<Harness />); fireEvent.click(screen.getByText("Direct convert"));
  view.rerender(<Harness reportId="report-B" />); view.rerender(<Harness open={false} />); view.rerender(<Harness />);
  await act(async () => pending.resolve(result));
  expect(mocks.convert.mock.calls[0][4].signal.aborted).toBe(true);
  expect(screen.getByTestId("data")).toHaveTextContent(JSON.stringify(initial));
  expect(mocks.success).not.toHaveBeenCalled();
});

it("does not overwrite an edit that arrives during conversion", async () => {
  const pending = defer(); mocks.convert.mockReturnValue(pending.promise); render(<Harness />);
  fireEvent.click(screen.getByText("Direct convert")); fireEvent.click(screen.getByText("Concurrent edit"));
  await act(async () => pending.resolve(result));
  expect(screen.getByTestId("data")).toHaveTextContent('"currency":"CAD"');
  expect(screen.getByTestId("data")).toHaveTextContent("new local edit");
  expect(mocks.info).toHaveBeenCalled();
});

it("drops a late conversion after the account session changes", async () => {
  const pending = defer(); mocks.convert.mockReturnValue(pending.promise); render(<Harness />);
  fireEvent.click(screen.getByText("Direct convert")); advanceAuthSession();
  await act(async () => pending.resolve(result));
  expect(screen.getByTestId("data")).toHaveTextContent(JSON.stringify(initial));
  expect(mocks.success).not.toHaveBeenCalled();
});
