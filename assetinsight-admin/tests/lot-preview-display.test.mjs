import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { lotPreviewDisplay, reportPreviewDisplay, usesLotTitleDescription } from "../lib/lotPreviewDisplay.ts";

test("normal lot/item display hides only redundant narratives, retaining structured specifications", () => {
  const lot = { title: "Reviewed title", description: "Hidden legacy text", details: "Hidden freeform notes", specs: "Hidden freeform specs",
    condition_report_specs: { Description: "Structured detail", Width: "20 ft" }, specifications: { description: "Keep structured text" },
    disclaimers: { customText: "Keep custom note" }, damage_analysis: "Keep damage",
    items: [{ title: "Child", description: "Child legacy", details: { Width: "30 ft" }, specs: [{ field: "Description", value: "Keep this" }] }], image_urls: ["one", "two"] };
  const before = JSON.stringify(lot);
  const view = lotPreviewDisplay(lot);
  for (const key of ["description", "details", "specs"]) assert.equal(Object.hasOwn(view, key), false);
  assert.deepEqual(view.condition_report_specs, lot.condition_report_specs);
  assert.deepEqual(view.specifications, lot.specifications);
  assert.deepEqual(view.disclaimers, lot.disclaimers);
  assert.equal(view.damage_analysis, lot.damage_analysis);
  assert.equal(Object.hasOwn(view.items[0], "description"), false);
  assert.deepEqual(view.items[0].details, lot.items[0].details);
  assert.deepEqual(view.items[0].specs, lot.items[0].specs);
  assert.deepEqual(view.image_urls, lot.image_urls);
  assert.equal(JSON.stringify(lot), before);
});

test("full 142-lot report projection preserves all originals and 1824 photo identities", () => {
  const data = { description: "Report-level summary", lots: Array.from({ length: 142 }, (_, i) => ({
    title: `Lot ${i}`, description: `Hidden ${i}`, details: `Notes ${i}`, condition_report_specs: { Width: "20 ft" },
    image_urls: Array.from({ length: i < 120 ? 13 : 12 }, (_, j) => `${i}/${j}.jpg`),
  })) };
  const before = JSON.stringify(data);
  const view = reportPreviewDisplay(data);
  assert.equal(view.description, "Report-level summary");
  assert.equal(view.lots.length, 142);
  assert.equal(view.lots[141].title, "Lot 141");
  assert.equal(view.lots.reduce((sum, lot) => sum + lot.image_urls.length, 0), 1824);
  assert.equal(JSON.stringify(data), before);
});

test("generic report view is gated by the explicit type, not report titles or Salvage fields", () => {
  for (const value of ["Asset", "Lot Listing", "LotListing"]) assert.equal(usesLotTitleDescription([{ label: "Report Type", value }]), true);
  for (const value of ["Salvage", "Real Estate", "Other", ""]) assert.equal(usesLotTitleDescription([{ label: "Report Type", value }]), false);
  assert.equal(usesLotTitleDescription([{ label: "Title", value: "Asset" }]), false);
});

test("read-only render paths project views while Raw JSON and pagination retain saved snapshots", () => {
  const drawer = readFileSync(new URL("../app/components/preview-reports/PreviewReportDrawer.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../app/components/reports/ReportDataPage.tsx", import.meta.url), "utf8");
  assert.match(drawer, /value=\{lotPreviewDisplay\(activeLot\)\}/);
  assert.match(drawer, /value=\{reportPreviewDisplay\(payload\.preview\.data\)\}/);
  assert.match(drawer, /JSON\.stringify\(payload\.preview\.data, null, 2\)/);
  assert.match(page, /usesLotTitleDescription\(preview\.meta\) \? lotPreviewDisplay\(activeLot\) : activeLot/);
  assert.match(page, /JSON\.stringify\(preview, null, 2\)/);
  for (const source of [drawer, page]) assert.match(source, /placement="bottom"/);
});
