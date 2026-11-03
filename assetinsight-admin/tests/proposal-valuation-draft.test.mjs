// Unsaved Proposal Valuation edits survive someone else's save (owner,
// 2026-11-03, after Jay Francis lost the appraisal of file 95099).
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  assignCellValue,
  cellValue,
  changedCellKeys,
  describeCell,
  draftStorageKey,
  evaluatorCellKey,
  fileCellKey,
  parseStoredDraft,
  rebaseEdits,
  rowCellKey,
  sheetEdits,
  tableCellKey,
} from "../app/components/reports/proposalValuationDraft.ts";

const clone = (value) => JSON.parse(JSON.stringify(value));

function row(lotId, values = {}) {
  return {
    lot_id: lotId, asset_id: lotId.replace("lot-", ""), asset_category: "", year: "", make: "", model: "",
    serial_number: "", cr_details: "", condition_score: "", location: "", pictures: 0, picture_urls: [],
    market_check: {}, asset_insight: "", evaluator_values: { jay: null, riley: null, ...values },
    low_est_sale_value: null, high_est_sale_value: null, buyer_premium_percent: 15, buyer_premium_amount: null,
    total_expected_gross: null, allocated_value: null, notes: "", cleaning: null, lien_search: null,
    video_cost: null, lotting_fee: null, advertising: null,
  };
}

function sheet(lotCount = 3) {
  return {
    evaluator_columns: [
      { id: "jay", name: "Jay Francis", user_id: "u-jay" },
      { id: "riley", name: "Riley McChesney", user_id: "u-riley" },
    ],
    rows: Array.from({ length: lotCount }, (_, i) => row(`lot-${i + 1}`)),
    file_summary: { buyers_premium_basis: "uncapped", total_risk_weighted_value: null, file_risk_multiplier: null,
      commission_percent_no_guarantee: null, offer2_nmg_percent: 0.785, capped_threshold_percent: 0.1 },
  };
}

function priceAll(target, columnId, start) {
  target.rows.forEach((r, i) => { r.evaluator_values[columnId] = start + i * 1000; });
  return target;
}

test("Jay prices the whole file while Riley saves one value: every one of Jay's numbers is kept", () => {
  const opened = sheet(40);
  const jays = priceAll(clone(opened), "jay", 5000);
  const rileysSave = clone(opened);
  rileysSave.rows[7].evaluator_values.riley = 12000;

  const edits = sheetEdits(opened, jays);
  assert.equal(edits.length, 40);
  const merged = rebaseEdits(rileysSave, edits);
  assert.equal(merged.overlaps.length, 0);
  assert.equal(merged.dropped.length, 0);
  assert.equal(merged.pending.length, 40);
  merged.sheet.rows.forEach((r, i) => assert.equal(r.evaluator_values.jay, 5000 + i * 1000));
  assert.equal(merged.sheet.rows[7].evaluator_values.riley, 12000, "Riley's saved value stays");
});

test("a cell both people changed is kept as typed and reported with the other value", () => {
  const opened = sheet();
  const mine = clone(opened);
  mine.rows[0].notes = "Needs tires";
  mine.rows[1].evaluator_values.jay = 9000;
  const theirs = clone(opened);
  theirs.rows[0].notes = "Runs well";

  const merged = rebaseEdits(theirs, sheetEdits(opened, mine));
  assert.deepEqual(merged.overlaps, [{ key: rowCellKey("lot-1", "notes"), base: "", theirs: "Runs well", yours: "Needs tires" }]);
  assert.equal(merged.sheet.rows[0].notes, "Needs tires");
  assert.equal(merged.sheet.rows[1].evaluator_values.jay, 9000);
  // The pending edit is now relative to the newer copy.
  assert.deepEqual(merged.pending.find((e) => e.key === rowCellKey("lot-1", "notes")), { kind: "cell", key: rowCellKey("lot-1", "notes"), from: "Runs well", to: "Needs tires" });
});

test("the same value saved by someone else is not an overlap and nothing is left to save", () => {
  const opened = sheet();
  const mine = clone(opened);
  mine.rows[2].evaluator_values.jay = 7000;
  const theirs = clone(mine);
  const merged = rebaseEdits(theirs, sheetEdits(opened, mine));
  assert.equal(merged.overlaps.length, 0);
  assert.equal(merged.pending.length, 0);
});

test("an edit to a lot someone removed is reported as dropped, not applied", () => {
  const opened = sheet();
  const mine = clone(opened);
  mine.rows[2].make = "Kenworth";
  const theirs = clone(opened);
  theirs.rows.pop();
  const merged = rebaseEdits(theirs, sheetEdits(opened, mine));
  assert.equal(merged.dropped.length, 1);
  assert.equal(merged.pending.length, 0);
});

test("an evaluator added on this page carries its values; the same person added elsewhere receives them", () => {
  const opened = sheet();
  const mine = clone(opened);
  mine.evaluator_columns.push({ id: "eval_local", name: "Femi", user_id: "u-femi" });
  mine.rows.forEach((r, i) => { r.evaluator_values.eval_local = i === 0 ? 3000 : null; });

  const plain = rebaseEdits(clone(opened), sheetEdits(opened, mine));
  assert.ok(plain.sheet.evaluator_columns.some((c) => c.id === "eval_local"));
  assert.equal(plain.sheet.rows[0].evaluator_values.eval_local, 3000);

  const theirs = clone(opened);
  theirs.evaluator_columns.push({ id: "eval_server", name: "Femi", user_id: "u-femi" });
  theirs.rows.forEach((r) => { r.evaluator_values.eval_server = null; });
  const aliased = rebaseEdits(theirs, sheetEdits(opened, mine));
  assert.equal(aliased.sheet.evaluator_columns.filter((c) => c.user_id === "u-femi").length, 1);
  assert.equal(aliased.sheet.rows[0].evaluator_values.eval_server, 3000);
});

test("removing an evaluator removes the column and its values", () => {
  const opened = sheet();
  const mine = clone(opened);
  mine.evaluator_columns = mine.evaluator_columns.filter((c) => c.id !== "riley");
  mine.rows.forEach((r) => delete r.evaluator_values.riley);
  const merged = rebaseEdits(clone(opened), sheetEdits(opened, mine));
  assert.deepEqual(merged.sheet.evaluator_columns.map((c) => c.id), ["jay"]);
  assert.equal("riley" in merged.sheet.rows[0].evaluator_values, false);
});

test("blanks and the page's defaults compare equal, so opening a file creates no edits", () => {
  const opened = sheet();
  const stored = clone(opened);
  stored.file_summary = {};
  stored.rows[0].evaluator_values.jay = "";
  stored.rows[0].notes = undefined;
  assert.deepEqual(sheetEdits(stored, opened), []);
  assert.equal(changedCellKeys(stored, opened).size, 0);
});

test("other people's changes are found cell by cell for highlighting", () => {
  const opened = sheet();
  const theirs = clone(opened);
  theirs.rows[1].evaluator_values.riley = 4000;
  theirs.file_summary.buyers_premium_basis = "capped";
  assert.deepEqual([...changedCellKeys(opened, theirs)].sort(), [evaluatorCellKey("lot-2", "riley"), fileCellKey("buyers_premium_basis")].sort());
});

test("Keep theirs sets the cell back, and labels read like the page", () => {
  const theirs = sheet();
  const key = evaluatorCellKey("lot-1", "riley");
  assignCellValue(theirs, key, 2500);
  assert.equal(cellValue(theirs, key), 2500);
  assert.deepEqual(describeCell(theirs, key), { lot: "1", field: "Riley McChesney" });
  assert.deepEqual(describeCell(theirs, rowCellKey("lot-1", "cr_details")), { lot: "1", field: "CR Details" });
  assert.equal(tableCellKey("lot-1", "eval_riley"), key);
  assert.equal(tableCellKey("lot-1", "notes"), rowCellKey("lot-1", "notes"));
  assert.equal(tableCellKey("lot-1", "evaluator_average"), null);
});

test("the browser copy is read back only for the same report, recent and well formed", () => {
  const now = Date.parse("2026-11-03T18:00:00Z");
  const draft = { version: 1, reportId: "r1", revision: 4, savedAt: "2026-11-03T17:00:00Z",
    edits: [{ kind: "cell", key: evaluatorCellKey("lot-1", "jay"), from: null, to: 5000 }, { kind: "cell", key: 5 }] };
  const parsed = parseStoredDraft(JSON.stringify(draft), "r1", now);
  assert.equal(parsed.edits.length, 1, "malformed edits are left out");
  assert.equal(parsed.revision, 4);
  assert.equal(parseStoredDraft(JSON.stringify(draft), "r2", now), null);
  assert.equal(parseStoredDraft(JSON.stringify({ ...draft, savedAt: "2026-09-01T00:00:00Z" }), "r1", now), null);
  assert.equal(parseStoredDraft("{not json", "r1", now), null);
  assert.equal(draftStorageKey("r1"), "asset-insight:pv-draft:v1:r1");
});

test("the page keeps edits on a refused save, warns before leaving, keeps a browser copy and checks every 30 seconds", () => {
  const page = readFileSync(new URL("../app/components/reports/ReportDataPage.tsx", import.meta.url), "utf8");
  const sheetSource = readFileSync(new URL("../app/components/reports/AssetScheduleSheet.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /Reload this page before continuing/);
  assert.match(page, /PV_CHECK_INTERVAL_MS = 30_000/);
  assert.match(page, /afterRefusedSave: true/);
  assert.match(sheetSource, /"beforeunload"/);
  assert.match(sheetSource, /draftStorageKey\(/);
  assert.match(sheetSource, /rebaseEdits\(/);
  // Enter finishes an entry: the wrapper <div>'s blur() never did.
  assert.doesNotMatch(sheetSource, /currentTarget\.blur\(\)/);
});
