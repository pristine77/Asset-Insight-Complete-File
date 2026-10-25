import assert from "node:assert/strict";
import test from "node:test";
import { additionalEvaluatorIds, canAddEvaluator, canRemoveEvaluator } from "../app/components/reports/assetScheduleSheetUtils.ts";

const owner = { id: "retained-owner-column", user_id: "owner", name: "Owner" };
const makeSheet = (count) => ({ evaluator_columns: [owner, { id: "legacy", name: "Old values" }, ...Array.from({ length: count }, (_, i) => ({ id: `column-${i}`, user_id: `user-${i}`, name: `Evaluator ${i}` }))], rows: [], file_summary: {} });

test("the intrinsic owner and legacy columns are not removable assignments", () => {
  assert.equal(canRemoveEvaluator(owner, owner.id), false);
  assert.equal(canRemoveEvaluator({ id: "legacy", name: "Old values" }, owner.id), false);
  assert.equal(canRemoveEvaluator(makeSheet(1).evaluator_columns[2], owner.id), true);
});

test("owner does not consume one of four additional slots or become a duplicate", () => {
  const sheet = makeSheet(3);
  const before = JSON.stringify(sheet);
  assert.equal(additionalEvaluatorIds(sheet, owner.id).size, 3);
  assert.equal(canAddEvaluator(sheet, "new-user", owner.id), true);
  assert.equal(canAddEvaluator(sheet, "owner", owner.id), false);
  assert.equal(canAddEvaluator(sheet, "user-0", owner.id), false);
  assert.equal(canAddEvaluator(makeSheet(4), "new-user", owner.id), false);
  assert.equal(JSON.stringify(sheet), before);
});

test("without new server metadata the existing four-linked-user limit is retained", () => {
  assert.equal(additionalEvaluatorIds(makeSheet(3)).size, 4);
  assert.equal(canAddEvaluator(makeSheet(3), "new-user"), false);
  assert.equal(canAddEvaluator(makeSheet(0), "", owner.id), false);
});
