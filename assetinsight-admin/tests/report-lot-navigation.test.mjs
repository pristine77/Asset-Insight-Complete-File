import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { reportLotNavigation } from "../lib/reportLotNavigation.ts";

test("142 loaded lots remain reachable through the final lot without a 20-lot cutoff", () => {
  let index = 0;
  const visited = [];
  while (index !== null) {
    const state = reportLotNavigation(142, index);
    visited.push(state.selected);
    assert.equal(state.total, 142);
    assert.equal(state.loaded, "All 142 lots are loaded");
    index = state.next;
  }
  assert.deepEqual(visited, Array.from({ length: 142 }, (_, i) => i));
  assert.deepEqual(reportLotNavigation(142, 141), {
    total: 142, selected: 141, previous: 140, next: null,
    position: "Viewing lot 142 of 142", loaded: "All 142 lots are loaded",
  });
  assert.equal(reportLotNavigation(142, 0).previous, null);
});

test("summary, empty reports, stale selection and single lots have bounded navigation", () => {
  assert.equal(reportLotNavigation(142, -1, true).next, 0);
  assert.equal(reportLotNavigation(142, 0, true).previous, -1);
  assert.equal(reportLotNavigation(142, 999).selected, 141);
  assert.equal(reportLotNavigation(142, -99).selected, 0);
  assert.equal(reportLotNavigation(142, NaN).selected, 0);
  assert.equal(reportLotNavigation(0, 42).next, null);
  assert.equal(reportLotNavigation(0, 42).previous, null);
  assert.equal(reportLotNavigation(1, 0).loaded, "All 1 lot is loaded");
});

test("view-only navigation leaves all 142 lots, 1824 photos and edited details intact", () => {
  const lots = Array.from({ length: 142 }, (_, i) => ({
    lot_number: i === 141 ? "last-duplicate-safe" : String(i + 1),
    description: `Reviewed description ${i}`,
    specs: i === 20 ? {} : { width: "20 ft" },
    image_urls: Array.from({ length: i < 120 ? 13 : 12 }, (_, p) => `https://example.test/${i}/${p}.jpg`),
  }));
  const before = JSON.stringify(lots);
  for (const index of [0, 19, 20, 141, 0]) reportLotNavigation(lots.length, index);
  assert.equal(JSON.stringify(lots), before);
  assert.equal(lots.reduce((total, lot) => total + lot.image_urls.length, 0), 1824);
});

test("preview and saved-report data show top and bottom controls without slicing or changing request code", () => {
  for (const path of ["app/components/preview-reports/PreviewReportDrawer.tsx", "app/components/reports/ReportDataPage.tsx"]) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(source, /ReportLotNavigationControls[^\n]*placement="top"/);
    assert.match(source, /ReportLotNavigationControls[^\n]*placement="bottom"/);
    assert.doesNotMatch(source, /lots\.slice\(/);
    assert.match(source, /scrollIntoView\(\{ block: "start" \}\)/);
    assert.match(source, /lotDetailsTop\.current\?\.focus\(\{ preventScroll: true \}\)/);
    assert.match(source, /ref=\{lotDetailsTop\} tabIndex=\{-1\}/);
  }
  const controls = readFileSync(new URL("../app/components/reports/ReportLotNavigationControls.tsx", import.meta.url), "utf8");
  assert.match(controls, /Jump to lot/);
  assert.match(controls, /lots\.map\(/);
  assert.doesNotMatch(controls, /fetch\(|JSON\.stringify|\.splice\(|\.slice\(/);
});
