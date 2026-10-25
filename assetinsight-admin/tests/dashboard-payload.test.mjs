import assert from "node:assert/strict";
import test from "node:test";
import { isDesktopDashboard, prepareActivity } from "../lib/dashboardData.ts";

function fixture() {
  return {
    range: { from: "2026-09-01T00:00:00.000Z", to: "2026-09-03T23:59:59.999Z" },
    kpis: { reports: { value: 4, percent: -20 }, lots: { value: 2, percent: 100 }, lotListings: { value: 1 }, users: { value: 0 }, pending: 0, released: 4 },
    activity: [{ date: "2026-09-01", value: 4 }, { date: "2026-09-02", value: 0 }, { date: "2026-09-03", value: 0 }],
    byType: ["Asset", "LotListing", "RealEstate", "Salvage"].map(type => ({ type, value: 1 })),
    queue: {
      preparingPreview: 0, previewReady: 1, generatingFiles: 0, awaitingApproval: 0, awaitingRelease: 0, releasedToday: 0,
      items: [{ id: "queue-report", reportType: "Asset", title: "Saved preview", creator: "Appraiser", lotCount: 2, workflowStage: "preview_ready", workflowMessage: "Preview ready for review", elapsedMinutes: 0, thumbnailUrl: null, error: null }],
    },
    recentReports: [{ _id: "recent-report", title: "Recent report", type: "Asset", lotCount: 2, createdAt: "2026-09-01T12:30:00.000Z", status: "preview", releaseStatus: "released", owner: null }],
  };
}

test("accepts complete current ISO payloads and explicit zero counts", () => {
  const payload = fixture();
  assert.equal(isDesktopDashboard(payload), true);
  payload.range = { from: "2026-09-01", to: "2026-09-03" };
  payload.byType = payload.byType.map(row => ({ ...row, value: 0 }));
  assert.equal(isDesktopDashboard(payload), true);
});

test("rejects missing sections and the previously accepted malformed envelope", () => {
  for (const section of ["range", "kpis", "queue", "activity", "byType", "recentReports"]) {
    for (const broken of [undefined, null, true, 1, "invalid"]) {
      assert.equal(isDesktopDashboard({ ...fixture(), [section]: broken }), false, `${section}: ${String(broken)}`);
    }
  }
  assert.equal(isDesktopDashboard({ range: { from: "2026-09-01", to: "2026-09-02" }, kpis: { reports: {}, users: {} }, queue: { items: [null] }, activity: [{ date: "2026-09-01", value: 1 }], byType: [{ type: "Asset", value: {} }], recentReports: [null] }), false);
  for (const broken of [null, undefined, true, 1, "payload", []]) assert.equal(isDesktopDashboard(broken), false);
});

test("requires every metric and stage count to be a finite nonnegative number", () => {
  const invalid = [undefined, null, "0", -1, Number.NaN, Infinity, {}, []];
  for (const name of ["reports", "lots", "lotListings", "users"]) {
    for (const broken of invalid) {
      const payload = fixture();
      payload.kpis[name] = { value: broken };
      assert.equal(isDesktopDashboard(payload), false, `${name}.value: ${String(broken)}`);
    }
    const payload = fixture();
    delete payload.kpis[name];
    assert.equal(isDesktopDashboard(payload), false, `missing ${name}`);
  }
  for (const [section, names] of [["kpis", ["pending", "released"]], ["queue", ["preparingPreview", "previewReady", "generatingFiles", "awaitingApproval", "awaitingRelease", "releasedToday"]]]) {
    for (const name of names) for (const broken of invalid) {
      const payload = fixture();
      payload[section][name] = broken;
      assert.equal(isDesktopDashboard(payload), false, `${section}.${name}: ${String(broken)}`);
    }
  }
  for (const broken of [null, "10", Infinity, Number.NaN]) {
    const payload = fixture();
    payload.kpis.reports.percent = broken;
    assert.equal(isDesktopDashboard(payload), false);
  }
});

test("requires four distinct known report types without inferring missing zeros", () => {
  for (const rows of [[], fixture().byType.slice(0, 3), [...fixture().byType, { type: "Other", value: 1 }], fixture().byType.map(row => ({ ...row, type: "Asset" })), [null, ...fixture().byType.slice(1)]]) {
    assert.equal(isDesktopDashboard({ ...fixture(), byType: rows }), false);
  }
  for (const broken of [undefined, null, "1", -1, Infinity, Number.NaN, {}]) {
    const payload = fixture();
    payload.byType[0].value = broken;
    assert.equal(isDesktopDashboard(payload), false);
  }
  const payload = fixture();
  payload.byType[0].type = "Other";
  assert.equal(isDesktopDashboard(payload), false);
});

test("validates complete dates instead of accepting valid-looking prefixes or rollover", () => {
  for (const date of ["2026-09-01garbage", "2026-02-29", "2026-02-29T00:00:00Z", "2026-09-01T24:00:00Z", "2026-09-01T00:60:00Z", "2026-09-01T00:00:00Zextra", "", null, 0]) {
    const payload = fixture();
    payload.range.from = date;
    assert.equal(isDesktopDashboard(payload), false, `invalid date ${String(date)}`);
  }
  const reversed = fixture();
  reversed.range = { from: "2026-09-01T12:00:00.000Z", to: "2026-09-01T11:00:00.000Z" };
  assert.equal(isDesktopDashboard(reversed), false);
  const leap = fixture();
  leap.range = { from: "2024-02-29T00:00:00Z", to: "2024-03-01T23:59:59.999Z" };
  assert.equal(isDesktopDashboard(leap), true);
});

test("permits explicit null activity and absent days while rejecting malformed activity rows", () => {
  const payload = fixture();
  payload.activity = [{ date: "2026-09-01", value: 4 }, { date: "2026-09-02", value: null }];
  assert.equal(isDesktopDashboard(payload), true);
  assert.deepEqual(prepareActivity(payload.activity, payload.range).map(row => row.value), [4, null, null]);
  assert.equal(isDesktopDashboard({ ...payload, activity: [] }), true);
  for (const row of [null, [], "row", {}, { date: "2026-09-01" }, { date: "2026-09-01", value: "1" }, { date: "2026-09-01", value: -1 }, { date: "2026-09-01", value: Infinity }, { date: "2026-09-01garbage", value: 1 }]) {
    assert.equal(isDesktopDashboard({ ...fixture(), activity: [row] }), false);
  }
});

test("rejects unsafe queue entries before the drawer filters or renders them", () => {
  for (const row of [null, [], "row", {}]) assert.equal(isDesktopDashboard({ ...fixture(), queue: { ...fixture().queue, items: [row] } }), false);
  for (const [key, value] of [["id", ""], ["reportType", null], ["title", {}], ["creator", []], ["contractNo", 42], ["creatorEmail", {}], ["lotCount", -1], ["workflowStage", "not_a_stage"], ["workflowMessage", {}], ["elapsedMinutes", Infinity], ["thumbnailUrl", {}], ["error", {}]]) {
    const payload = fixture();
    payload.queue.items[0][key] = value;
    assert.equal(isDesktopDashboard(payload), false, `invalid queue ${key}`);
  }
});

test("rejects unsafe recent rows while preserving deleted owners and unknown string statuses", () => {
  for (const row of [null, [], "row", {}]) assert.equal(isDesktopDashboard({ ...fixture(), recentReports: [row] }), false);
  for (const [key, value] of [["_id", ""], ["type", null], ["title", {}], ["lotCount", Number.NaN], ["createdAt", "2026-02-29T12:00:00Z"], ["status", {}], ["releaseStatus", []], ["contractNo", 42], ["lotNumberSummary", {}], ["thumbnailUrl", {}], ["owner", []], ["owner", { username: {} }]]) {
    const payload = fixture();
    payload.recentReports[0][key] = value;
    assert.equal(isDesktopDashboard(payload), false, `invalid recent ${key}`);
  }
  for (const owner of [null, undefined, "legacy-owner", {}, { username: "Appraiser", companyName: "Company", email: "appraiser@example.test" }]) {
    const payload = fixture();
    payload.recentReports[0].owner = owner;
    payload.recentReports[0].status = "future_workflow_status";
    assert.equal(isDesktopDashboard(payload), true);
  }
});

test("accepts nullable metadata forwarded from saved PdfReport and populated user records", () => {
  const payload = fixture();
  payload.recentReports[0] = {
    ...payload.recentReports[0],
    type: "Salvage",
    contractNo: null,
    lotNumberSummary: null,
    thumbnailUrl: null,
    status: null,
    releaseStatus: "released",
    owner: { username: "Appraiser", companyName: null, email: "appraiser@example.test" },
  };
  assert.equal(isDesktopDashboard(payload), true);
  payload.recentReports[0].owner = { username: null, companyName: null, email: null };
  payload.recentReports[0].releaseStatus = null;
  assert.equal(isDesktopDashboard(payload), true);
});
