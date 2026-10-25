import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { excelConditionReportDescription, excelConditionReportTitleHelp } from "../lib/excelConditionReportDescription.ts";

test("Title and Description remain independent, including long multiline descriptions", () => {
  const description = `Reviewed description\n${"Detailed specification. ".repeat(30)}`;
  const row = { title: "Lot title TEST", description };
  assert.deepEqual(excelConditionReportDescription(row), { description });
  assert.equal(row.title, "Lot title TEST");
  assert.deepEqual(excelConditionReportDescription({ ...row, title: "Different title" }), { description });
});

test("explicit blank Description is sent, not replaced by the Title", () => {
  assert.deepEqual(excelConditionReportDescription({ title: "Original title", description: "" }), { description: "" });
  assert.deepEqual(excelConditionReportDescription({ description: "  " }), { description: "  " });
});

test("old or malformed DTOs omit Description rather than clearing saved content", () => {
  for (const row of [{ title: "Title TEST" }, { description: undefined }, { description: null }, { description: 123 }]) {
    assert.deepEqual(excelConditionReportDescription(row), {});
    assert.equal(Object.hasOwn(excelConditionReportDescription(row), "description"), false);
  }
});

test("Title-only editor preserves hidden descriptions through the existing atomic request", () => {
  const source = readFileSync(new URL("../app/components/reports/ExcelConditionReportEditorDialog.tsx", import.meta.url), "utf8");
  assert.equal(source.match(/\.\.\.excelConditionReportDescription\(row\)/g)?.length, 2);
  assert.match(source, /label="Title"/);
  assert.doesNotMatch(source, /label="Description"|description: event\.target\.value|row\.description\.trim/);
  assert.match(source, /excelConditionReportTitleHelp\(activeRow\.descriptionScope\)/);
  assert.match(source, /descriptionScope: row\.descriptionScope === "lot" \|\| row\.descriptionScope === "item"/);
  assert.doesNotMatch(source.slice(source.indexOf("const editorBody ="), source.indexOf("const acceptSavedEditor")), /descriptionScope/);
  assert.match(source, /title="Specifications"/);
  assert.match(source, /title="Custom note"/);
  assert.match(source, /title="Lot content preview"/);
  assert.doesNotMatch(source, /title="Final Excel preview"/);
  assert.match(source, /\/rerun-excel-cr`/);
  assert.match(source, /body: JSON\.stringify\(editorBody\)/);
  assert.match(source, /revision: payload\.revision/);
  assert.match(source, /The server queued file regeneration without confirming the saved editor snapshot/);
  assert.doesNotMatch(source, /description: row\.title|description: activeRow\.title/);
  assert.match(source, /gridTemplateColumns: \{ xs: "minmax\(0, 1fr\)", md: "260px minmax\(0, 1fr\)"/);
  assert.match(source, /aria-label="Excel condition report rows"[\s\S]*?display: "flex",\s*minWidth: 0,/);
});

test("output scope distinguishes lot CR documents from nested Excel item rows", () => {
  assert.match(excelConditionReportTitleHelp("lot"), /Title is used as Description in Excel, CR PDF and CR DOCX/);
  assert.match(excelConditionReportTitleHelp("item"), /this item's Excel row/);
  assert.match(excelConditionReportTitleHelp("item"), /parent lot's Title/);
  assert.match(excelConditionReportTitleHelp(), /parent lot's Title/);
  assert.doesNotMatch(excelConditionReportTitleHelp("item"), /Description in Excel, CR PDF and CR DOCX/);
});
