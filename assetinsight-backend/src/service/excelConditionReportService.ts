/**
 * Provides the editable condition-report projection used by spreadsheet-style admin UI.
 * Stable row locators and revision hashes prevent edits from landing on shifted lots;
 * regeneration acquires a conditional database lock, uploads new artifacts first, and
 * records failure state so concurrent requests cannot publish competing versions.
 */
import { createHash, randomUUID } from "crypto";
import AssetReport from "../models/asset.model.js";
import LotListing from "../models/lotListing.model.js";
import PdfReport from "../models/pdfReport.model.js";
import { generateAssetXlsxFromReport } from "./xlsx/assetXlsxService.js";
import { buildSpecReportData } from "./auctioneerSpecPdfRefreshService.js";
import {
  generateAndUploadScheduleAPdf,
  generateScheduleAPdfFromReport,
} from "./scheduleAReportPdfService.js";
import {
  uploadBufferToR2,
} from "../utils/r2Storage/r2Upload.js";
import {
  buildReportArtifactFilenames,
  getReportContractNumber,
} from "../utils/reportArtifactNames.js";
import {
  AUCTIONEER_NOT_FOUND,
  applyAuctioneerManualSpecOverrides,
  auctioneerSpecFieldAliases,
  buildAuctioneerSpecRows,
  reviewedAuctioneerItemSpecState,
  collectAuctioneerManualSpecOverrides,
  collectEffectiveAuctioneerManualSpecOverrides,
  collectAuctioneerSpecRecord,
  findAuctioneerManualSpecOverride,
  formatAuctioneerSpecValue,
  isAuctioneerDamageField,
  isAuctioneerSerialField,
  isAuctioneerSpecFieldDeleted,
  mergeAuctioneerSpecRecords,
  normalizeAuctioneerLotSpecs,
  normalizeAuctioneerSpecKey,
  resolveAuctioneerSpecValue,
  resolveAuctioneerCategorySpec,
} from "../utils/auctioneerSpecRows.js";
import { formatDamageAnalysisDisplayText } from "../utils/assetDamageAnalysis.js";
import {
  getCrDisclaimerLotKey,
  getCrDisclaimersForLot,
  normalizeCrDisclaimers,
} from "../utils/crDisclaimers.js";
import {
  enforceLotsDamageAnalysisPolicy,
  isLotDamageAnalysisEligible,
} from "../utils/lotDamagePolicy.js";
import { normalizeAssetConditionSelectionValue } from "../utils/assetConditionSelections.js";
import { queueAssetScheduleSheetRegeneration } from "./assetScheduleSheetRegenerationService.js";
import { proposalValuationWritableRevisionCondition } from "./proposalValuationArtifactPublicationService.js";
import { mergeAssetAdminScheduleSheetAfterPreviewEdit } from "./assetAdminScheduleSheetService.js";
import { broadcastProposalValuationRevision } from "./proposalValuationRealtimeService.js";

const EXCEL_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const MAX_ROWS = 5000;
const MAX_SPECS_PER_ROW = 200;
const EXCEL_REGENERATION_LEASE_MS = 30 * 60 * 1_000;

type ReportKind = "asset" | "lotListing";

type ReportTarget = {
  kind: ReportKind;
  parentId: string;
  doc: any;
};

type RowLocator = {
  rowKey: string;
  lotIndex: number;
  itemIndex: number | null;
  lot: any;
  record: any;
};

export class ExcelConditionReportError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function plain(value: any): any {
  if (!value) return {};
  if (typeof value.toObject === "function") return value.toObject();
  return JSON.parse(JSON.stringify(value));
}

function stableValue(value: any): any {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])])
  );
}

function revisionFor(value: any): string {
  // Sort object keys before hashing so the token represents semantic editor state rather
  // than incidental BSON/JavaScript property order.
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("base64url");
}

function versionedExcelOnlyArtifactName(filename: string, token: string): string {
  const suffix = token.replace(/[^a-zA-Z0-9]/g, "").slice(0, 12);
  const extensionIndex = filename.lastIndexOf(".");
  if (extensionIndex <= 0) return `${filename}-${suffix}`;
  return `${filename.slice(0, extensionIndex)}-${suffix}${filename.slice(extensionIndex)}`;
}

function cleanPlainText(value: unknown, maxLength: number): string {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function compactUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.map((item) => String(item || "").trim()).filter(Boolean))
  );
}

function compactIndexes(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item >= 0)
    )
  );
}

function collectRowImages(record: any, parentLot: any, imageUrls: string[]): string[] {
  const urls: string[] = [];
  const push = (value: unknown) => {
    const url = String(value || "").trim();
    if (url && !urls.includes(url)) urls.push(url);
  };
  for (const source of [record, parentLot]) {
    compactUrls(source?.image_urls).forEach(push);
    compactUrls(source?.extra_image_urls).forEach(push);
    push(source?.image_url);
    const indexes = [
      ...compactIndexes(source?.image_indexes),
      ...compactIndexes(source?.extra_image_indexes),
      ...(Number.isInteger(Number(source?.image_index)) ? [Number(source.image_index)] : []),
    ];
    indexes.forEach((index) => push(imageUrls[index]));
  }
  return urls.slice(0, 24);
}

function rowKeyFor(reportId: string, lot: any, lotIndex: number, itemIndex: number | null) {
  const identity = String(lot?.lot_id || lot?.id || lot?.lot_number || lotIndex);
  return createHash("sha256")
    .update(`${reportId}:${identity}:${lotIndex}:${itemIndex ?? "lot"}`)
    .digest("base64url")
    .slice(0, 24);
}

function buildLocators(doc: any): RowLocator[] {
  // Row keys bind edits to their original lot/item positions. The API never trusts array
  // order supplied by the browser when applying edits back to nested report data.
  const previewData = plain(doc?.preview_data);
  const lots = Array.isArray(previewData?.lots)
    ? previewData.lots
    : Array.isArray(doc?.lots)
      ? plain(doc.lots)
      : [];
  const reportId = String(doc?._id || "report");
  const locators: RowLocator[] = [];
  lots.forEach((lot: any, lotIndex: number) => {
    const items = Array.isArray(lot?.items) ? lot.items : [];
    if (items.length > 0) {
      items.forEach((item: any, itemIndex: number) => {
        const record = {
          ...lot,
          ...item,
          condition_report_specs: {
            ...collectAuctioneerSpecRecord(lot),
            ...collectAuctioneerSpecRecord(item),
          },
          condition_report_specs_manual_overrides: {
            ...collectAuctioneerManualSpecOverrides(lot),
            ...collectAuctioneerManualSpecOverrides(item),
          },
          ...reviewedAuctioneerItemSpecState(item),
          lot_number: item?.lot_number ?? lot?.lot_number,
        };
        locators.push({
          rowKey: rowKeyFor(reportId, lot, lotIndex, itemIndex),
          lotIndex,
          itemIndex,
          lot,
          record,
        });
      });
      return;
    }
    locators.push({
      rowKey: rowKeyFor(reportId, lot, lotIndex, null),
      lotIndex,
      itemIndex: null,
      lot,
      record: lot,
    });
  });
  return locators;
}

function normalizationWarnings(record: any) {
  const specs = collectAuctioneerSpecRecord(record);
  const entries = Object.entries(specs);
  const warnings: Array<{ removedField: string; keptField: string }> = [];
  const find = (matcher: (key: string) => boolean) =>
    entries.filter(([field]) => matcher(normalizeAuctioneerSpecKey(field)));
  const hours = find((key) => /^(hours?|showinghours?|hourmeter|enginehours)/.test(key));
  if (hours.length > 1) {
    const kept = hours.find(([field]) => /engine|showing/i.test(field)) || hours[0];
    hours.forEach(([field]) => {
      if (field !== kept?.[0]) warnings.push({ removedField: field, keptField: kept?.[0] || "Hours" });
    });
  }
  const bucket = entries.find(([field]) => normalizeAuctioneerSpecKey(field) === "bucket");
  const bucketType = entries.find(
    ([field]) => normalizeAuctioneerSpecKey(field) === "buckettype"
  );
  if (bucket && bucketType) {
    warnings.push({ removedField: bucket[0], keptField: bucketType[0] });
  }
  const manufacturer = entries.find(
    ([field]) => normalizeAuctioneerSpecKey(field) === "enginemanufacturer"
  );
  const model = entries.find(
    ([field]) => normalizeAuctioneerSpecKey(field) === "enginemodel"
  );
  if (
    manufacturer &&
    model &&
    normalizeAuctioneerSpecKey(manufacturer[1]) === normalizeAuctioneerSpecKey(model[1])
  ) {
    warnings.push({ removedField: model[0], keptField: manufacturer[0] });
  }
  return warnings;
}

function buildSpecControls(record: any) {
  const normalized = normalizeAuctioneerLotSpecs(record);
  const manualOverrides = collectEffectiveAuctioneerManualSpecOverrides(normalized);
  const categorySpec = resolveAuctioneerCategorySpec(
    normalized?.categories,
    normalized,
    [normalized?.description, normalized?.details].filter(Boolean).join(", ")
  );
  const definitions = categorySpec?.fieldDefinitions || [];
  const isDeleted = (field: string) => isAuctioneerSpecFieldDeleted(normalized, field, categorySpec?.fields || []);
  const explicitOrder = Array.isArray(normalized?.condition_report_specs_custom_order)
    ? normalized.condition_report_specs_custom_order
    : [];
  const rows = buildAuctioneerSpecRows(normalized, {
    category: normalized?.categories,
  });
  // Rows include values derived from report selections (for example Running
  // Condition), while the record contains explicitly saved category specs.
  // Combining both keeps the editor and generated outputs on one canonical path.
  const resolvedSpecs = applyAuctioneerManualSpecOverrides(
    mergeAuctioneerSpecRecords(
      collectAuctioneerSpecRecord(normalized),
      Object.fromEntries(rows.map((row) => [row.field, row.value]))
    ),
    manualOverrides
  );
  const rowsByKey = new Map(rows.map((row) => [normalizeAuctioneerSpecKey(row.field), row]));
  const controls: any[] = definitions
    .filter(
      (definition) =>
        !isAuctioneerDamageField(definition.name) &&
        !isDeleted(definition.name)
    )
    .map((definition) => {
      const row = rowsByKey.get(normalizeAuctioneerSpecKey(definition.name));
      const manualOverride = findAuctioneerManualSpecOverride(
        manualOverrides,
        definition.name
      );
      const resolvedValue = manualOverride.found
        ? manualOverride.value
        : row?.value || resolveAuctioneerSpecValue(resolvedSpecs, definition.name, true);
      return {
        field: definition.name,
        value:
          resolvedValue === AUCTIONEER_NOT_FOUND
            ? ""
            : manualOverride.found
              ? resolvedValue
              : formatAuctioneerSpecValue(definition.name, resolvedValue),
        type: definition.type,
        required: definition.required,
        options: definition.options || [],
        custom: false,
      };
    });
  const seen = new Set(controls.map((control) => normalizeAuctioneerSpecKey(control.field)));
  for (const row of rows) {
    const key = normalizeAuctioneerSpecKey(row.field);
    if (!key || seen.has(key) || isAuctioneerDamageField(row.field)) continue;
    seen.add(key);
    const manualOverride = findAuctioneerManualSpecOverride(manualOverrides, row.field);
    controls.push({
      field: row.field,
      value: manualOverride.found
        ? manualOverride.value
        : formatAuctioneerSpecValue(row.field, row.value),
      type: row.checked ? "checkbox" : "text",
      required: false,
      options: [],
      custom: true,
    });
  }
  for (const field of explicitOrder) {
    const key = normalizeAuctioneerSpecKey(field);
    if (
      !key ||
      seen.has(key) ||
      isDeleted(field) ||
      isAuctioneerDamageField(field)
    ) {
      continue;
    }
    seen.add(key);
    controls.push({
      field,
      value: "",
      type: "text",
      required: false,
      options: [],
      custom: true,
    });
  }
  const orderedFields = [...explicitOrder, ...rows.map((row) => row.field)];
  const rowOrder = new Map<string, number>();
  orderedFields.forEach((field, index) => {
    const key = normalizeAuctioneerSpecKey(field);
    if (key && !rowOrder.has(key)) rowOrder.set(key, index);
  });
  return controls
    .map((control, defaultIndex) => ({ control, defaultIndex }))
    .sort((left, right) => {
      const leftRank = rowOrder.get(normalizeAuctioneerSpecKey(left.control.field));
      const rightRank = rowOrder.get(normalizeAuctioneerSpecKey(right.control.field));
      if (leftRank !== undefined && rightRank !== undefined) return leftRank - rightRank;
      if (leftRank !== undefined) return -1;
      if (rightRank !== undefined) return 1;
      return left.defaultIndex - right.defaultIndex;
    })
    .map(({ control }) => control);
}

async function resolveTarget(id: string): Promise<ReportTarget | null> {
  const pdfReport = await PdfReport.findById(id).lean().catch(() => null);
  const parentId = String((pdfReport as any)?.report || id);
  const asset = await AssetReport.findById(parentId)
    .populate("user", "email username name companyName")
    .catch(() => null);
  if (asset) return { kind: "asset", parentId, doc: asset };
  const listing = await LotListing.findById(parentId)
    .populate("user", "email username name companyName")
    .catch(() => null);
  if (listing) return { kind: "lotListing", parentId, doc: listing };
  return null;
}

function assertApproved(target: ReportTarget) {
  if (target.doc.status !== "approved") {
    throw new ExcelConditionReportError(
      400,
      "REPORT_NOT_APPROVED",
      "Excel Condition Reports can only be edited for approved reports."
    );
  }
}

function editableSnapshot(doc: any) {
  const previewData = plain(doc?.preview_data);
  return {
    lots: previewData?.lots || plain(doc?.lots) || [],
    cr_disclaimers: previewData?.cr_disclaimers || {},
    cr_disclaimers_by_lot: previewData?.cr_disclaimers_by_lot || {},
    include_damage_analysis:
      previewData?.include_damage_analysis ?? doc?.include_damage_analysis ?? true,
  };
}

function responseFor(target: ReportTarget) {
  const reportData = buildSpecReportData(target.doc);
  const imageUrls = Array.isArray(target.doc?.imageUrls) ? target.doc.imageUrls : [];
  const masterDamageEnabled = reportData?.include_damage_analysis !== false;
  const locators = buildLocators(target.doc);
  const rows = locators.map((locator, rowIndex) => {
    const record = normalizeAuctioneerLotSpecs(locator.record);
    // A catalogue row owns its Description independently. The merged locator
    // may inherit parent text for legacy spec rendering, not for editable text.
    const originalRecord = locator.itemIndex === null
      ? locator.lot
      : locator.lot?.items?.[locator.itemIndex];
    const lotNumber = record?.lot_number ?? locator.lot?.lot_number ?? rowIndex + 1;
    const disclaimerLotKey = getCrDisclaimerLotKey(locator.lot, locator.lotIndex);
    const damagePolicyEligible = isLotDamageAnalysisEligible(lotNumber);
    return {
      rowKey: locator.rowKey,
      disclaimerLotKey,
      lotNumber: String(lotNumber ?? ""),
      title: String(record?.title || record?.description || `Lot ${lotNumber}`).trim(),
      description: String(originalRecord?.description ?? ""),
      descriptionScope: locator.itemIndex === null ? "lot" as const : "item" as const,
      category: String(record?.categories || "").trim(),
      imageUrls: collectRowImages(record, locator.lot, imageUrls),
      specs: buildSpecControls(record),
      damageEligible: masterDamageEnabled && damagePolicyEligible,
      damagePolicyEligible,
      damageAnalysis:
        masterDamageEnabled && damagePolicyEligible
          ? formatDamageAnalysisDisplayText(record?.damage_analysis)
          : "",
      disclaimers: getCrDisclaimersForLot(
        reportData,
        locator.lot,
        locator.lotIndex
      ),
      normalizationWarnings: normalizationWarnings(locator.record),
    };
  });
  return {
    reportType: target.kind === "asset" ? "Asset" : "LotListing",
    revision: revisionFor(editableSnapshot(target.doc)),
    filesBusy: Boolean(
      target.doc?.files_generating ||
        target.doc?.files_regenerating ||
        target.doc?.excel_regenerating ||
        ["queued", "processing"].includes(String(target.doc?.job_status || ""))
    ),
    fileJobStatus: String(target.doc?.job_status || ""),
    fileJobError: String(target.doc?.job_error || ""),
    masterDamageEnabled,
    rows,
  };
}

export async function getExcelConditionReports(id: string) {
  const target = await resolveTarget(id);
  if (!target) {
    throw new ExcelConditionReportError(404, "REPORT_NOT_FOUND", "Report not found");
  }
  assertApproved(target);
  return responseFor(target);
}

function sanitizeSpecs(value: unknown) {
  if (!Array.isArray(value) || value.length > MAX_SPECS_PER_ROW) {
    throw new ExcelConditionReportError(
      400,
      "INVALID_EXCEL_CONDITION_REPORT",
      `Each row must contain no more than ${MAX_SPECS_PER_ROW} specification controls.`
    );
  }
  const seen = new Set<string>();
  return value.map((entry: any) => {
    const field = cleanPlainText(entry?.field, 120);
    const key = normalizeAuctioneerSpecKey(field);
    if (!field || !key || seen.has(key) || isAuctioneerDamageField(field)) {
      throw new ExcelConditionReportError(
        400,
        "INVALID_EXCEL_CONDITION_REPORT",
        "Specification fields must be unique, named, and cannot duplicate Damage Analysis."
      );
    }
    seen.add(key);
    return {
      field,
      // Preserve intentional capitalization. Numeric/unit presentation is
      // applied when the editor/output is rendered, never destructively here.
      value: cleanPlainText(entry?.value, 4000),
      deleted: entry?.deleted === true,
    };
  });
}

function syncRunningConditionSelection(
  record: any,
  specs: Array<{ field: string; value: string; deleted: boolean }>
): Record<string, unknown> | undefined {
  const existing =
    record?.condition_report_selections &&
    typeof record.condition_report_selections === "object" &&
    !Array.isArray(record.condition_report_selections)
      ? { ...record.condition_report_selections }
      : undefined;
  const runningCondition = specs.find((spec) => {
    const key = normalizeAuctioneerSpecKey(spec.field);
    return key === "runningcondition" || key === "workingcondition";
  });
  if (!runningCondition) {
    return existing;
  }

  if (runningCondition.deleted || !runningCondition.value) {
    return {
      ...(existing || {}),
      condition: "N/A",
    };
  }

  const condition = normalizeAssetConditionSelectionValue(
    "condition",
    runningCondition.value
  );
  if (!condition) return existing;

  return {
    ...(existing || {}),
    condition,
  };
}

function resolveSubmittedDamageAnalysis(
  originalValue: unknown,
  submittedValue: unknown
): unknown {
  const submittedText = String(submittedValue || "").slice(0, 8000);
  // The editor presents a normalized, title-cased projection. Sending that
  // projection back unchanged must not rewrite the underlying report text when
  // an administrator edits only CR notes or specifications.
  if (
    formatDamageAnalysisDisplayText(submittedText) ===
    formatDamageAnalysisDisplayText(originalValue)
  ) {
    return originalValue;
  }
  return formatDamageAnalysisDisplayText(submittedText) || null;
}

export async function saveExcelConditionReports(
  id: string,
  body: any,
  options: { requireFilesIdle?: boolean } = { requireFilesIdle: true }
) {
  const target = await resolveTarget(id);
  if (!target) {
    throw new ExcelConditionReportError(404, "REPORT_NOT_FOUND", "Report not found");
  }
  assertApproved(target);
  if (
    options.requireFilesIdle &&
    (target.doc?.files_generating ||
      target.doc?.files_regenerating ||
      target.doc?.excel_regenerating ||
      ["queued", "processing"].includes(String(target.doc?.job_status || "")))
  ) {
    throw new ExcelConditionReportError(
      409,
      "EXCEL_CR_REGENERATION_IN_PROGRESS",
      "This report is already generating files."
    );
  }
  const currentRevision = revisionFor(editableSnapshot(target.doc));
  if (!body?.revision || body.revision !== currentRevision) {
    throw new ExcelConditionReportError(
      409,
      "REPORT_REVISION_CHANGED",
      "This report changed after the editor was opened. Refresh it before saving."
    );
  }
  if (!Array.isArray(body?.rows) || body.rows.length > MAX_ROWS) {
    throw new ExcelConditionReportError(
      400,
      "INVALID_EXCEL_CONDITION_REPORT",
      "A structured rows array is required."
    );
  }

  const locators = buildLocators(target.doc);
  const locatorByKey = new Map(locators.map((locator) => [locator.rowKey, locator]));
  if (body.rows.length !== locators.length) {
    throw new ExcelConditionReportError(
      400,
      "INVALID_EXCEL_CONDITION_REPORT",
      "All Excel rows must be included when saving."
    );
  }

  const submittedKeys = new Set<string>();
  const previewData = plain(target.doc.preview_data);
  const nextLots = Array.isArray(previewData?.lots)
    ? plain(previewData.lots)
    : plain(target.doc.lots || []);
  const nextDisclaimersByLot = {
    ...(previewData?.cr_disclaimers_by_lot || {}),
  };
  const sourceReportData = buildSpecReportData(target.doc);
  const currentDisclaimerByParent = new Map<string, string>();
  const submittedDisclaimersByParent = new Map<string, Set<string>>();
  for (const locator of locators) {
    const parentKey = getCrDisclaimerLotKey(locator.lot, locator.lotIndex);
    if (!currentDisclaimerByParent.has(parentKey)) {
      currentDisclaimerByParent.set(
        parentKey,
        JSON.stringify(
          getCrDisclaimersForLot(sourceReportData, locator.lot, locator.lotIndex)
        )
      );
    }
  }

  for (const submittedRow of body.rows) {
    const rowKey = String(submittedRow?.rowKey || "");
    if (!rowKey || submittedKeys.has(rowKey)) {
      throw new ExcelConditionReportError(
        400,
        "INVALID_EXCEL_CONDITION_REPORT",
        "Excel row keys must be unique."
      );
    }
    submittedKeys.add(rowKey);
    const locator = locatorByKey.get(rowKey);
    if (!locator) {
      throw new ExcelConditionReportError(
        400,
        "INVALID_EXCEL_CONDITION_REPORT",
        "An Excel row no longer exists in this report."
      );
    }
    const specs = sanitizeSpecs(submittedRow?.specs);
    const deletedSpecs = specs.filter((spec) => spec.deleted).map((spec) => spec.field);
    const originalLot = nextLots[locator.lotIndex] || {};
    const originalRecord =
      locator.itemIndex === null
        ? originalLot
        : Array.isArray(originalLot.items)
          ? originalLot.items[locator.itemIndex] || {}
          : {};
    const editedSourceRecord = { ...originalRecord };
    if (Object.prototype.hasOwnProperty.call(submittedRow, "description")) {
      if (typeof submittedRow.description !== "string") {
        throw new ExcelConditionReportError(
          400,
          "INVALID_EXCEL_CONDITION_REPORT",
          "Description must be text."
        );
      }
      // Preserve old clients' omissions and unchanged projection echoes,
      // including a child's absent field. Explicit edits/clears stay verbatim;
      // headline cleanup and AI-ingress length limits do not apply to reviews.
      if (submittedRow.description !== String(originalRecord?.description ?? "")) {
        editedSourceRecord.description = submittedRow.description;
      }
    }
    const categoryFields = resolveAuctioneerCategorySpec(submittedRow?.category || originalRecord?.categories, originalRecord)?.fields || [];
    const aliasesFor = (field: string) => auctioneerSpecFieldAliases(field, categoryFields).map(normalizeAuctioneerSpecKey);
    const sameField = (left: string, right: string) => {
      const leftKeys = new Set(aliasesFor(left));
      return aliasesFor(right).some(key => leftKeys.has(key));
    };
    const priorControls = buildSpecControls(locator.record);
    const previousTable = originalRecord?.condition_report_specs;
    const previousFields = Array.isArray(previousTable)
      ? previousTable.map(entry => String(entry?.field || ""))
      : previousTable && typeof previousTable === "object" ? Object.keys(previousTable) : [];
    const retainedSpecs = specs.filter(spec => {
      if (spec.deleted) return false;
      if (spec.value || previousFields.some(field => sameField(field, spec.field))) return true;
      const previousControl = priorControls.find(control => sameField(control.field, spec.field));
      // An untouched blank category template is presentation, not saved data.
      // Keep an explicit clear of a displayed value, or a newly added blank row.
      return !previousControl || !!previousControl.value;
    });
    const specRecord = Object.fromEntries(retainedSpecs.map(spec => [spec.field, spec.value]));
    const manualSpecOverrides = {
      // Legacy manual-only blanks still suppress captured/prose values without
      // adding an absent row to the canonical reviewed table.
      ...Object.fromEntries(Object.entries(collectAuctioneerManualSpecOverrides(originalRecord)).filter(([field, value]) =>
        !value && !retainedSpecs.some(spec => sameField(spec.field, field)))),
      ...Object.fromEntries(retainedSpecs.map(spec => [spec.field, spec.value])),
    };
    // The editor also submits untouched, empty category controls. Those are
    // not evidence that an unrelated legacy hidden field was re-added.
    const restoredKeys = new Set(specs.filter(spec => !spec.deleted && (spec.value || isAuctioneerSerialField(spec.field))).flatMap(spec =>
      auctioneerSpecFieldAliases(spec.field, categoryFields).map(normalizeAuctioneerSpecKey)));
    // Deleted controls are omitted from the editor. Saving a different field
    // must retain those tombstones unless that field was explicitly re-added.
    for (const field of Array.isArray(originalRecord?.condition_report_specs_deleted) ? originalRecord.condition_report_specs_deleted : []) {
      if (!auctioneerSpecFieldAliases(String(field), categoryFields).some(alias => restoredKeys.has(normalizeAuctioneerSpecKey(alias))) &&
          !deletedSpecs.some(deleted => normalizeAuctioneerSpecKey(deleted) === normalizeAuctioneerSpecKey(field))) {
        deletedSpecs.push(String(field));
      }
    }
    if (restoredKeys.size) {
      // Explicitly retained/re-added fields supersede their own old deletion
      // aliases; unrelated hidden fields and collection shapes are preserved.
      for (const key of ["deleted_condition_report_specs", "removed_condition_report_specs", "hidden_condition_report_specs"]) {
        const collection = editedSourceRecord[key];
        const restored = (field: string) => auctioneerSpecFieldAliases(field, categoryFields)
          .some(alias => restoredKeys.has(normalizeAuctioneerSpecKey(alias)));
        if (Array.isArray(collection)) {
          editedSourceRecord[key] = collection.filter((field) => !restored(String(field ?? "")));
        } else if (collection && typeof collection === "object") {
          editedSourceRecord[key] = Object.fromEntries(
            Object.entries(collection).filter(([field]) => !restored(field))
          );
        }
      }
    }
    const conditionReportSelections = syncRunningConditionSelection(
      originalRecord,
      specs
    );
    const lotNumber = cleanPlainText(submittedRow?.lotNumber, 80);
    const damageEligible = isLotDamageAnalysisEligible(
      lotNumber || originalRecord?.lot_number || originalLot?.lot_number
    );
    const editedRecord = normalizeAuctioneerLotSpecs({
      ...editedSourceRecord,
      lot_number: lotNumber || originalRecord?.lot_number || originalLot?.lot_number,
      title: cleanPlainText(submittedRow?.title, 500),
      categories: cleanPlainText(submittedRow?.category, 180),
      condition_report_specs: specRecord,
      condition_report_specs_reviewed: true,
      condition_report_specs_manual_overrides: manualSpecOverrides,
      condition_report_specs_deleted: deletedSpecs,
      condition_report_specs_custom_order: specs
        .filter((spec) => !spec.deleted)
        .map((spec) => spec.field),
      ...(conditionReportSelections
        ? { condition_report_selections: conditionReportSelections }
        : {}),
      damage_analysis:
        damageEligible &&
        (previewData?.include_damage_analysis ?? target.doc?.include_damage_analysis ?? true) !== false
          ? resolveSubmittedDamageAnalysis(
              originalRecord?.damage_analysis,
              submittedRow?.damageAnalysis
            )
          : null,
    });

    if (locator.itemIndex === null) {
      nextLots[locator.lotIndex] = { ...originalLot, ...editedRecord };
    } else {
      const items = Array.isArray(originalLot.items) ? [...originalLot.items] : [];
      items[locator.itemIndex] = editedRecord;
      nextLots[locator.lotIndex] = { ...originalLot, items };
    }

    const parentKey = getCrDisclaimerLotKey(originalLot, locator.lotIndex);
    const disclaimers = normalizeCrDisclaimers(submittedRow?.disclaimers);
    const serialized = JSON.stringify(disclaimers);
    const submitted = submittedDisclaimersByParent.get(parentKey) || new Set<string>();
    submitted.add(serialized);
    submittedDisclaimersByParent.set(parentKey, submitted);
  }

  for (const [parentKey, submitted] of submittedDisclaimersByParent) {
    const current = currentDisclaimerByParent.get(parentKey);
    const changed = [...submitted].filter((value) => value !== current);
    if (changed.length > 1) {
      throw new ExcelConditionReportError(
        400,
        "INVALID_EXCEL_CONDITION_REPORT",
        "Rows from the same catalogue lot contain conflicting auction controls or disclaimers."
      );
    }
    const selected = changed[0] || current || [...submitted][0];
    if (selected) nextDisclaimersByLot[parentKey] = JSON.parse(selected);
  }

  const includeDamageAnalysis =
    (previewData?.include_damage_analysis ?? target.doc?.include_damage_analysis ?? true) !== false;
  const enforcedLots = enforceLotsDamageAnalysisPolicy(nextLots, includeDamageAnalysis);
  const nextPreviewData: Record<string, any> = {
    ...previewData,
    lots: enforcedLots,
    cr_disclaimers_by_lot: nextDisclaimersByLot,
  };
  const proposalValuationRevision = Number(
    target.doc?.proposal_valuation_revision || 0
  );
  const scheduleMerge =
    target.kind === "asset"
      ? mergeAssetAdminScheduleSheetAfterPreviewEdit({
          previousPreviewData: previewData,
          nextPreviewData,
        })
      : null;
  const proposalValuationChanged = Boolean(
    scheduleMerge &&
      revisionFor(scheduleMerge.previousSheet) !==
        revisionFor(scheduleMerge.nextSheet)
  );
  const proposalValuationUpdatedAt = proposalValuationChanged
    ? new Date()
    : undefined;
  if (
    proposalValuationChanged &&
    scheduleMerge &&
    scheduleMerge.hadStoredSheet
  ) {
    nextPreviewData.admin_schedule_sheet = scheduleMerge.nextSheet;
  }
  const Model: any = target.kind === "asset" ? AssetReport : LotListing;
  // The client revision detects stale forms; updatedAt and idle predicates repeat that
  // protection atomically at the write boundary in case state changes during validation.
  const updated = await Model.findOneAndUpdate(
    {
      _id: target.parentId,
      updatedAt: target.doc.updatedAt,
      status: "approved",
      ...(target.kind === "asset"
        ? proposalValuationWritableRevisionCondition(
            proposalValuationRevision
          )
        : {}),
      ...(options.requireFilesIdle
        ? {
            files_generating: { $ne: true },
            files_regenerating: { $ne: true },
            excel_regenerating: { $ne: true },
            job_status: { $nin: ["queued", "processing"] },
          }
        : {}),
    },
    {
      $set: {
        preview_data: nextPreviewData,
        lots: enforcedLots,
        ...(proposalValuationUpdatedAt
          ? { proposal_valuation_updated_at: proposalValuationUpdatedAt }
          : {}),
      },
      ...(proposalValuationChanged
        ? { $inc: { proposal_valuation_revision: 1 } }
        : {}),
    },
    { new: true, runValidators: true }
  ).populate("user", "email username name companyName");
  if (!updated) {
    if (options.requireFilesIdle) {
      const busy = await Model.exists({
        _id: target.parentId,
        status: "approved",
        $or: [
          { files_generating: true },
          { files_regenerating: true },
          { excel_regenerating: true },
          { job_status: { $in: ["queued", "processing"] } },
        ],
      });
      if (busy) {
        throw new ExcelConditionReportError(
          409,
          "EXCEL_CR_REGENERATION_IN_PROGRESS",
          "This report is already generating files."
        );
      }
    }
    throw new ExcelConditionReportError(
      409,
      "REPORT_REVISION_CHANGED",
      "This report changed while it was being saved. Refresh it before trying again."
    );
  }
  if (proposalValuationChanged) {
    broadcastProposalValuationRevision({
      reportId: target.parentId,
      revision: proposalValuationRevision + 1,
      updatedAt: proposalValuationUpdatedAt as Date,
    });
  }
  return responseFor({ ...target, doc: updated });
}

export async function regenerateExcelOnly(id: string) {
  const target = await resolveTarget(id);
  if (!target) {
    throw new ExcelConditionReportError(404, "REPORT_NOT_FOUND", "Report not found");
  }
  assertApproved(target);
  const Model: any = target.kind === "asset" ? AssetReport : LotListing;
  const excelRegenerationToken = randomUUID();
  const excelRegenerationExpiresAt = new Date(
    Date.now() + EXCEL_REGENERATION_LEASE_MS
  );
  const proposalValuationRevision = Number(
    target.kind === "asset"
      ? target.doc?.proposal_valuation_revision || 0
      : 0
  );
  let lockReleased = false;
  // Acquire the regeneration flag with compare-and-set so only one process can render
  // and publish a replacement workbook for this report.
  const locked = await Model.findOneAndUpdate(
    {
      _id: target.parentId,
      status: "approved",
      files_generating: { $ne: true },
      files_regenerating: { $ne: true },
      ...(target.kind === "asset"
        ? {
            ...proposalValuationWritableRevisionCondition(
              proposalValuationRevision
            ),
            $or: [
              { excel_regenerating: { $ne: true } },
              { excel_regeneration_expires_at: { $lte: new Date() } },
            ],
          }
        : { excel_regenerating: { $ne: true } }),
    },
    {
      $set: {
        excel_regenerating: true,
        ...(target.kind === "asset"
          ? {
              excel_regeneration_token: excelRegenerationToken,
              excel_regeneration_expires_at: excelRegenerationExpiresAt,
            }
          : {}),
        excel_regeneration_error: null,
      },
    },
    { new: true }
  ).populate("user", "email username name companyName");
  if (!locked) {
    throw new ExcelConditionReportError(
      409,
      "EXCEL_REGENERATION_IN_PROGRESS",
      "This report is already generating files."
    );
  }

  const renewAssetExcelLock = async () => {
    if (target.kind !== "asset") return;
    const renewed = await AssetReport.updateOne(
      {
        _id: target.parentId,
        excel_regeneration_token: excelRegenerationToken,
        excel_regenerating: true,
      },
      {
        $set: {
          excel_regeneration_expires_at: new Date(
            Date.now() + EXCEL_REGENERATION_LEASE_MS
          ),
        },
      }
    );
    if (renewed.matchedCount !== 1) {
      throw new ExcelConditionReportError(
        409,
        "EXCEL_REGENERATION_OWNERSHIP_LOST",
        "Excel regeneration ownership expired. Retry from the latest report."
      );
    }
  };

  try {
    const bucket = process.env.R2_BUCKET_NAME;
    if (!bucket) throw new Error("R2_BUCKET_NAME is required to regenerate Excel");
    let reportData = buildSpecReportData(locked);
    const artifactNames = buildReportArtifactFilenames({
      kind: target.kind,
      contractNo: getReportContractNumber(reportData, target.parentId),
      reportId: target.parentId,
      fallback: target.parentId,
      lots: reportData.lots,
    });
    const folder = target.kind === "lotListing" ? "lot-listings" : "previews";
    if (target.kind === "asset") {
      const revision = Number(
        (locked as any)?.proposal_valuation_revision || 0
      );
      const scheduleABuffer = await generateScheduleAPdfFromReport(reportData);
      await renewAssetExcelLock();
      const timestamp = Date.now();
      const scheduleAKey = `${folder}/${versionedExcelOnlyArtifactName(
        artifactNames.scheduleAPdf,
        excelRegenerationToken
      )}`;
      const scheduleAUploaded = await uploadBufferToR2(
        scheduleABuffer,
        "application/pdf",
        bucket,
        scheduleAKey
      );
      const scheduleAUrl = `${scheduleAUploaded}?v=${timestamp}`;
      reportData = { ...reportData, schedule_a_pdf_url: scheduleAUrl };
      const xlsxBuffer = await generateAssetXlsxFromReport(reportData, {
        includeScheduleAColumn: true,
      });
      await renewAssetExcelLock();
      const excelKey = `${folder}/${versionedExcelOnlyArtifactName(
        artifactNames.excel,
        excelRegenerationToken
      )}`;
      const excelUploaded = await uploadBufferToR2(
        xlsxBuffer,
        EXCEL_CONTENT_TYPE,
        bucket,
        excelKey
      );
      const excelUrl = `${excelUploaded}?v=${timestamp}`;
      const now = new Date();
      // Token-versioned keys are final assets. A crash between uploads leaves
      // only unreachable objects; readers keep the previous complete pair until
      // this single guarded pointer swap commits.
      const updated = await AssetReport.findOneAndUpdate(
        {
          _id: target.parentId,
          excel_regenerating: true,
          excel_regeneration_token: excelRegenerationToken,
          excel_regeneration_expires_at: { $gt: new Date() },
          ...proposalValuationWritableRevisionCondition(revision),
        },
        {
          $set: {
            "preview_files.excel": excelUrl,
            "preview_files.schedule_a_pdf": scheduleAUrl,
            "files.schedule_a_pdf": scheduleAUrl,
            excel_regenerating: false,
            excel_regenerated_at: now,
            excel_regeneration_error: null,
          },
          $unset: {
            excel_regeneration_token: 1,
            excel_regeneration_expires_at: 1,
          },
        },
        { new: true }
      ).lean();
      if (!updated) {
        const latest = await AssetReport.findById(target.parentId)
          .select("proposal_valuation_revision files_regeneration_pending")
          .lean();
        const latestRevision = Number(
          (latest as any)?.proposal_valuation_revision || revision
        );
        const releaseSet: Record<string, unknown> = {
          excel_regenerating: false,
        };
        if (latestRevision !== revision) {
          releaseSet.files_regeneration_pending = true;
        }
        const released = await AssetReport.updateOne(
          {
            _id: target.parentId,
            excel_regeneration_token: excelRegenerationToken,
          },
          {
            $set: releaseSet,
            $unset: {
              excel_regeneration_token: 1,
              excel_regeneration_expires_at: 1,
            },
          }
        );
        lockReleased = released.matchedCount === 1;
        if (latestRevision !== revision) {
          await queueAssetScheduleSheetRegeneration(
            target.parentId,
            latestRevision
          );
        }
        throw new ExcelConditionReportError(
          409,
          "PV_REVISION_CONFLICT",
          "Proposal Valuation changed while Excel was generated. Retry from the latest revision."
        );
      }
      lockReleased = true;
      const pending = Boolean(
        (updated as any)?.files_regeneration_pending
      );
      if (pending) {
        await queueAssetScheduleSheetRegeneration(
          target.parentId,
          Number((updated as any)?.proposal_valuation_revision || revision)
        );
      }
      return {
        excel: excelUrl,
        scheduleA: scheduleAUrl,
        preview_files: (updated as any)?.preview_files,
        files: (updated as any)?.files,
        regeneratedAt: now.toISOString(),
      };
    }
    const scheduleA = await generateAndUploadScheduleAPdf({
      reportData,
      kind: target.kind,
      reportId: target.parentId,
      folder,
      objectName: artifactNames.scheduleAPdf,
    });
    reportData = {
      ...reportData,
      schedule_a_pdf_url: scheduleA.url,
    };
    const xlsxBuffer = await generateAssetXlsxFromReport(reportData, {
      includeScheduleAColumn: false,
    });
    // Upload before replacing the persisted URL. Readers therefore continue seeing the
    // previous valid workbook until the new object is fully available.
    const uploaded = await uploadBufferToR2(
      xlsxBuffer,
      EXCEL_CONTENT_TYPE,
      bucket,
      `${folder}/${artifactNames.excel}`
    );
    const url = `${uploaded}?v=${Date.now()}`;
    const now = new Date();
    const set: Record<string, any> = {
      "preview_files.excel": url,
      "preview_files.schedule_a_pdf": scheduleA.url,
      "files.schedule_a_pdf": scheduleA.url,
      excel_regenerating: false,
      excel_regenerated_at: now,
      excel_regeneration_error: null,
    };
    if (target.kind === "lotListing") set["files.excel"] = url;
    const updated = await Model.findByIdAndUpdate(
      target.parentId,
      { $set: set },
      { new: true }
    );
    return {
      excel: url,
      scheduleA: scheduleA.url,
      preview_files: (updated as any)?.preview_files,
      files: (updated as any)?.files,
      regeneratedAt: now.toISOString(),
    };
  } catch (error: any) {
    // On handled errors, attempt to clear the logical lock and retain the reason so
    // operators can distinguish failed regeneration from work that is still running.
    if (target.kind === "asset" && !lockReleased) {
      await Model.findOneAndUpdate(
        {
          _id: target.parentId,
          excel_regeneration_token: excelRegenerationToken,
        },
        {
          $set: {
            excel_regenerating: false,
            excel_regeneration_error: error?.message || String(error),
          },
          $unset: {
            excel_regeneration_token: 1,
            excel_regeneration_expires_at: 1,
          },
        }
      );
    } else if (target.kind === "lotListing") {
      await Model.findByIdAndUpdate(target.parentId, {
        $set: {
          excel_regenerating: false,
          excel_regeneration_error: error?.message || String(error),
        },
      });
    }
    throw error;
  }
}
