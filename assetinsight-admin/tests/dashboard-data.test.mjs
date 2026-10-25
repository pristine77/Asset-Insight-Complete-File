import assert from "node:assert/strict";
import test from "node:test";
import { formatCount, isDesktopDashboard, prepareActivity, reportStatus, reportTypeLabel, validateDashboardRange } from "../lib/dashboardData.ts";

test("date ranges reject reversed or impossible dates and accept leap days", () => {
  assert.equal(validateDashboardRange({ from: "2024-02-29", to: "2024-03-01" }), null);
  for (const range of [{ from: "2025-02-29", to: "2025-03-01" }, { from: "2026-09-15", to: "2026-09-14" }, { from: "", to: "2026-09-14" }, { from: "2026-01-32", to: "2026-02-10" }]) assert.ok(validateDashboardRange(range));
});

test("counts preserve known zero while missing or invalid values remain unknown", () => {
  assert.equal(formatCount(0), "0");
  for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, "0"]) assert.equal(formatCount(value), "—");
});

test("report statuses distinguish failures, pending and unknown from success", () => {
  assert.deepEqual(reportStatus({}), { label: "Unknown", tone: "default" });
  assert.deepEqual(reportStatus({ status: "unexpected_stage" }), { label: "Unexpected stage", tone: "default" });
  assert.deepEqual(reportStatus({ status: "pending_approval" }), { label: "Pending approval", tone: "warning" });
  assert.deepEqual(reportStatus({ status: "failed", releaseStatus: "released" }), { label: "Failed", tone: "error" });
  assert.deepEqual(reportStatus({ status: "rejected" }), { label: "Declined", tone: "error" });
  assert.deepEqual(reportStatus({ status: "approved", releaseStatus: "released" }), { label: "Released", tone: "success" });
  assert.equal(reportTypeLabel("LotListing"), "Lot Listing");
  assert.equal(reportTypeLabel("RealEstate"), "Real Estate");
});

test("legacy release flags do not make nonterminal or unknown reports look released", () => {
  for (const status of ["preview", "processing", "pending_approval", "draft", "unknown", undefined]) {
    const result = reportStatus({ status, releaseStatus: "released" });
    assert.notEqual(result.label, "Released");
    assert.notEqual(result.tone, "success");
  }
  for (const status of ["error", "failed", "rejected", "declined"]) {
    assert.equal(reportStatus({ status, releaseStatus: "released" }).tone, "error");
  }
  for (const status of ["approved", "completed", "released"]) {
    assert.deepEqual(reportStatus({ status, releaseStatus: "released" }), { label: "Released", tone: "success" });
  }
});

test("activity bins retain known zero, aggregate duplicate days and mark absent days unknown", () => {
  const result = prepareActivity([
    { date: "2026-09-01", value: 0 },
    { date: "2026-09-02", value: 3 },
    { date: "2026-09-02", value: 4 },
    { date: "2026-08-31", value: 100 },
    { date: "invalid", value: 100 },
  ], { from: "2026-09-01", to: "2026-09-03" });
  assert.deepEqual(result.map((point) => point.value), [0, 7, null]);
});

test("bounded aggregation preserves totals and date coverage for complete ranges", () => {
  const activity = Array.from({ length: 30 }, (_, index) => ({ date: `2026-09-${String(index + 1).padStart(2, "0")}`, value: index + 1 }));
  const result = prepareActivity(activity, { from: "2026-09-01", to: "2026-09-30" }, 7);
  assert.ok(result.length <= 7);
  assert.equal(result[0].date, "2026-09-01");
  assert.equal(result.at(-1).endDate, "2026-09-30");
  assert.equal(result.reduce((sum, point) => sum + point.value, 0), 465);
});

test("invalid or missing data makes an aggregate unknown without hiding the other bins", () => {
  const result = prepareActivity([
    { date: "2026-09-01", value: 5 }, { date: "2026-09-02", value: null },
    { date: "2026-09-03", value: 3 }, { date: "2026-09-04", value: 4 },
  ], { from: "2026-09-01", to: "2026-09-04" }, 2);
  assert.deepEqual(result.map((point) => point.value), [null, 7]);
  assert.deepEqual(prepareActivity([], { from: "2026-09-02", to: "2026-09-01" }), []);
});

test("broken dashboard envelopes are rejected instead of becoming zero dashboards", () => {
  const valid = { range: { from: "2026-09-01", to: "2026-09-14" }, kpis: { reports: { value: 0 }, lots: { value: 0 }, lotListings: { value: 0 }, users: { value: 0 }, pending: 0, released: 0 }, queue: { preparingPreview: 0, previewReady: 0, generatingFiles: 0, awaitingApproval: 0, awaitingRelease: 0, releasedToday: 0, items: [] }, activity: [], byType: ["Asset", "LotListing", "RealEstate", "Salvage"].map((type) => ({ type, value: 0 })), recentReports: [] };
  assert.equal(isDesktopDashboard(valid), true);
  for (const value of [null, {}, { ...valid, activity: null }, { ...valid, queue: {} }, { ...valid, range: { from: "invalid", to: "2026-09-14" } }, { ...valid, byType: [{}] }]) assert.equal(isDesktopDashboard(value), false);
});
