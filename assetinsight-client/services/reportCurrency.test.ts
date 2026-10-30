import { beforeEach, expect, it, vi } from "vitest";
import { convertPreviewCurrency } from "./reportCurrency";
const mocks = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/api", () => ({ default: mocks }));
const data = { preview_data: { currency: "USD", currency_conversion: { token: "opaque-quote" } }, quote: { fromCurrency: "CAD", toCurrency: "USD", rate: .75 } };
beforeEach(() => { mocks.post.mockReset().mockResolvedValue({ data: { data } }); });
it.each(["asset", "lot-listing"] as const)("uses the authenticated %s preview conversion endpoint", async kind => {
  const snapshot = { currency: "CAD", lots: [] }; const signal = new AbortController().signal;
  expect(await convertPreviewCurrency(kind, "report-1", "USD", snapshot, { signal })).toEqual(data);
  expect(mocks.post).toHaveBeenCalledWith(`/${kind}/report-1/preview/currency-conversion`,
    { targetCurrency: "USD", preview_data: snapshot }, { signal, timeout: 65_000 });
});
it("uses assigned-approver authorization rather than owner routing", async () => {
  await convertPreviewCurrency("asset", "report-1", "USD", { currency: "CAD" }, { assignedApproval: true });
  expect(mocks.post.mock.calls[0][0]).toBe("/reports/assigned-approvals/report-1/preview/currency-conversion");
});
it.each([0, -1, NaN, Infinity])("refuses invalid rate %s instead of relabeling values", async rate => {
  mocks.post.mockResolvedValue({ data: { data: { ...data, quote: { ...data.quote, rate } } } });
  await expect(convertPreviewCurrency("asset", "report-1", "USD", { currency: "CAD" })).rejects.toThrow("could not be verified");
});
it("refuses an unsigned currency relabel", async () => {
  mocks.post.mockResolvedValue({ data: { data: { ...data, preview_data: { currency: "USD" } } } });
  await expect(convertPreviewCurrency("asset", "report-1", "USD", { currency: "CAD" })).rejects.toThrow("could not be verified");
});
