/**
 * Owns the canonical specification registry and workbook import/extraction boundary.
 * Names, field types, ordering, and options are normalized before persistence so admin
 * edits, Excel uploads, and AI extraction all produce the same strict hierarchy; unsafe
 * or unsupported files are rejected before provider calls.
 */
import openai from "../utils/openaiClient.js";
import ExcelJS from "exceljs";
import type {
  ISpecSheetCategory,
  ISpecSheetField,
} from "../models/specSheetCategory.model.js";
import type { ISpecSheetParentCategory } from "../models/specSheetParentCategory.model.js";

export type SpecSheetFieldInput = {
  name?: unknown;
  order?: unknown;
  type?: unknown;
  required?: unknown;
  options?: unknown;
};

export type SpecSheetFieldType = "text" | "number" | "select" | "checkbox";

export type ExtractedSpecSheetFields = {
  fields: Array<{ name: string; order: number }>;
  notes: string;
};

export type StrictSpecSheetRegistryField = {
  id: string;
  name: string;
  order: number;
  type: SpecSheetFieldType;
  required: boolean;
  options: string[];
};

export type ParsedSpecSheetWorkbookField = {
  name: string;
  normalizedName: string;
  order: number;
  type: SpecSheetFieldType;
  required: boolean;
  options: string[];
};

export type ParsedSpecSheetWorkbookChild = {
  name: string;
  normalizedName: string;
  parentName: string;
  parentNormalizedName: string;
  fields: ParsedSpecSheetWorkbookField[];
};

export type ParsedSpecSheetWorkbookParent = {
  name: string;
  normalizedName: string;
};

export type ParsedSpecSheetWorkbook = {
  parents: ParsedSpecSheetWorkbookParent[];
  children: ParsedSpecSheetWorkbookChild[];
  warnings: string[];
  stats: {
    parentCount: number;
    childCount: number;
    fieldCount: number;
    duplicateFieldCount: number;
  };
};

export type StrictSpecSheetRegistryChild = {
  id: string;
  name: string;
  description: string;
  fields: StrictSpecSheetRegistryField[];
};

export type StrictSpecSheetRegistryParent = {
  id: string;
  name: string;
  description: string;
  children: StrictSpecSheetRegistryChild[];
};

export type StrictSpecSheetRegistry = {
  parents: StrictSpecSheetRegistryParent[];
  unassignedChildren: StrictSpecSheetRegistryChild[];
};

export function normalizeSpecSheetKey(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildSpecSheetChildScopedKey(parentNormalizedName: string, childNormalizedName: string): string {
  return `${normalizeSpecSheetKey(parentNormalizedName)}::${normalizeSpecSheetKey(childNormalizedName)}`;
}

export function sanitizeSpecSheetName(value: unknown, label: string): string {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (!name) {
    const err = new Error(`${label} is required`);
    (err as any).statusCode = 400;
    throw err;
  }
  if (name.length > 180) {
    const err = new Error(`${label} must be 180 characters or less`);
    (err as any).statusCode = 400;
    throw err;
  }
  return name;
}

export function sanitizeSpecSheetDescription(value: unknown): string {
  return String(value || "").trim().slice(0, 1000);
}

export function normalizeSpecSheetFieldType(value: unknown): SpecSheetFieldType {
  const type = String(value || "").trim().toLowerCase().replace(/\s+/g, "");
  if (type === "number" || type === "select" || type === "checkbox") return type;
  if (type === "dropdown") return "select";
  if (type === "textbox") return "text";
  if (type === "checkboxgroup") return "checkbox";
  return "text";
}

export function normalizeSpecSheetFieldOptions(value: unknown): string[] {
  const rawText = String(value || "").trim();
  const rawValues = Array.isArray(value)
    ? value
    : rawText.includes(" / ")
      ? rawText.split(/\s+\/\s+/g)
      : rawText
          .split(/[\n,]+/g)
          .map((item) => item.trim());

  const seen = new Set<string>();
  const options: string[] = [];
  for (const raw of rawValues) {
    const option = String(raw || "").trim().replace(/\s+/g, " ");
    if (!option) continue;
    const key = normalizeSpecSheetKey(option);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    options.push(option.slice(0, 120));
  }
  return options;
}

export function normalizeSpecSheetRequired(value: unknown): boolean {
  const text = String(value ?? "").trim().toLowerCase();
  return text === "true" || text === "yes" || text === "y" || text === "1" || text === "required";
}

export function normalizeSpecSheetFields(
  fields: SpecSheetFieldInput[]
): Array<{ name: string; normalizedName: string; order: number; type: SpecSheetFieldType; required: boolean; options: string[] }> {
  const seen = new Set<string>();
  const normalized: Array<{
    name: string;
    normalizedName: string;
    order: number;
    type: SpecSheetFieldType;
    required: boolean;
    options: string[];
  }> = [];

  const sorted = [...(fields || [])].sort((a, b) => {
    const orderA = Number(a?.order || 0);
    const orderB = Number(b?.order || 0);
    if (orderA && orderB && orderA !== orderB) return orderA - orderB;
    if (orderA && !orderB) return -1;
    if (!orderA && orderB) return 1;
    return 0;
  });

  for (const input of sorted) {
    const name = String(input?.name || "").trim().replace(/\s+/g, " ");
    if (!name) continue;
    const normalizedName = normalizeSpecSheetKey(name);
    if (!normalizedName || seen.has(normalizedName)) continue;
    seen.add(normalizedName);
    const type = normalizeSpecSheetFieldType(input?.type);
    normalized.push({
      name,
      normalizedName,
      order: normalized.length + 1,
      type,
      required: normalizeSpecSheetRequired(input?.required),
      options: type === "select" || type === "checkbox" ? normalizeSpecSheetFieldOptions(input?.options) : [],
    });
  }

  return normalized;
}

export function reindexSpecSheetFields(fields: ISpecSheetField[]): ISpecSheetField[] {
  return [...(fields || [])]
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
    .map((field, index) => ({
      ...field,
      order: index + 1,
    }));
}

export function formatSpecSheetCategory(category: ISpecSheetCategory) {
  const doc = category.toObject ? category.toObject() : category;
  return {
    _id: String((doc as any)._id),
    name: doc.name,
    normalizedName: doc.normalizedName,
    description: doc.description || "",
    parentCategoryId: (doc as any).parentCategory ? String((doc as any).parentCategory) : "",
    fields: [...(doc.fields || [])]
      .sort((a: ISpecSheetField, b: ISpecSheetField) => a.order - b.order)
      .map((field: ISpecSheetField) => ({
        _id: String((field as any)._id),
        name: field.name,
        normalizedName: field.normalizedName,
        order: field.order,
        type: field.type || "text",
        required: Boolean((field as any).required),
        options: Array.isArray(field.options) ? field.options : [],
      })),
    createdBy: (doc as any).createdBy ? String((doc as any).createdBy) : undefined,
    updatedBy: (doc as any).updatedBy ? String((doc as any).updatedBy) : undefined,
    createdAt: (doc as any).createdAt,
    updatedAt: (doc as any).updatedAt,
  };
}

export function formatSpecSheetParentCategory(parent: ISpecSheetParentCategory) {
  const doc = parent.toObject ? parent.toObject() : parent;
  return {
    _id: String((doc as any)._id),
    name: doc.name,
    normalizedName: doc.normalizedName,
    description: doc.description || "",
    createdBy: (doc as any).createdBy ? String((doc as any).createdBy) : undefined,
    updatedBy: (doc as any).updatedBy ? String((doc as any).updatedBy) : undefined,
    createdAt: (doc as any).createdAt,
    updatedAt: (doc as any).updatedAt,
  };
}

// Strict registry serializers intentionally return only stable JSON primitives.
// This keeps the DB registry ready for future AI/tool-call JSON contracts.
export function toStrictRegistryChild(category: ISpecSheetCategory): StrictSpecSheetRegistryChild {
  const formatted = formatSpecSheetCategory(category);
  return {
    id: formatted._id,
    name: formatted.name,
    description: formatted.description,
    fields: formatted.fields.map((field) => ({
      id: field._id,
      name: field.name,
      order: field.order,
      type: normalizeSpecSheetFieldType(field.type),
      required: Boolean((field as any).required),
      options: Array.isArray(field.options) ? field.options : [],
    })),
  };
}

export function buildStrictSpecSheetRegistry(input: {
  parents: ISpecSheetParentCategory[];
  children: ISpecSheetCategory[];
}): StrictSpecSheetRegistry {
  const childrenByParent = new Map<string, StrictSpecSheetRegistryChild[]>();
  const unassignedChildren: StrictSpecSheetRegistryChild[] = [];

  for (const child of input.children || []) {
    const parentId = String((child as any)?.parentCategory || "").trim();
    const serializedChild = toStrictRegistryChild(child);
    if (parentId) {
      const bucket = childrenByParent.get(parentId) || [];
      bucket.push(serializedChild);
      childrenByParent.set(parentId, bucket);
    } else {
      unassignedChildren.push(serializedChild);
    }
  }

  const parents = [...(input.parents || [])]
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
    .map((parent) => {
      const formatted = formatSpecSheetParentCategory(parent);
      const children = (childrenByParent.get(formatted._id) || []).sort((a, b) =>
        a.name.localeCompare(b.name)
      );
      return {
        id: formatted._id,
        name: formatted.name,
        description: formatted.description,
        children,
      };
    });

  return {
    parents,
    unassignedChildren: unassignedChildren.sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function cleanWorkbookText(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function workbookCellText(cell: ExcelJS.Cell | undefined): string {
  if (!cell) return "";
  if (cell.text) return cleanWorkbookText(cell.text);
  const value = cell.value as any;
  if (value && typeof value === "object") {
    if (Array.isArray(value.richText)) {
      return cleanWorkbookText(value.richText.map((part: any) => part.text || "").join(""));
    }
    if (value.text) return cleanWorkbookText(value.text);
    if (value.result) return cleanWorkbookText(value.result);
  }
  return cleanWorkbookText(value);
}

function workbookHeaderKey(value: unknown): string {
  return normalizeSpecSheetKey(value).replace(/\s+/g, "");
}

function findSpecWorkbookColumns(headerRow: ExcelJS.Row) {
  const headers = new Map<string, number>();
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers.set(workbookHeaderKey(workbookCellText(cell)), colNumber);
  });

  const columns = {
    parent: headers.get("parentcategory"),
    order: headers.get("orderposition"),
    child: headers.get("childcategory"),
    field: headers.get("fieldname"),
    type: headers.get("fieldtype"),
    required: headers.get("required"),
    options: headers.get("options"),
  };

  const missing = Object.entries(columns)
    .filter(([, col]) => !col)
    .map(([name]) => name);
  if (missing.length > 0) {
    const err = new Error(`Spec workbook is missing required header(s): ${missing.join(", ")}`);
    (err as any).statusCode = 400;
    throw err;
  }

  return columns as Record<keyof typeof columns, number>;
}

function isSpecBoilerplateFieldName(value: unknown): boolean {
  const text = cleanWorkbookText(value);
  if (!text) return true;
  const lower = text.toLowerCase();
  return (
    text.length > 180 ||
    /title clearance clarification fee/i.test(text) ||
    /applied to your invoice/i.test(text) ||
    /over and above the purchase price/i.test(text) ||
    /applicable taxes/i.test(text) ||
    /following the close of the sale/i.test(text) ||
    (/[.!?]/.test(text) && /\b(fee|invoice|tax|purchase price|sale)\b/i.test(lower))
  );
}

function parseWorkbookOrder(value: unknown): number | null {
  const numeric = Number(String(value ?? "").trim());
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

export async function parseSpecSheetWorkbookFromBuffer(buffer: Buffer): Promise<ParsedSpecSheetWorkbook> {
  // The export format uses visually merged parent cells, so the most recent non-empty
  // parent applies to following rows. Reject orphan rows instead of guessing hierarchy.
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  const worksheet = workbook.getWorksheet("Auctioneer Import");
  if (!worksheet) {
    const err = new Error('Spec workbook must include an "Auctioneer Import" sheet');
    (err as any).statusCode = 400;
    throw err;
  }

  const columns = findSpecWorkbookColumns(worksheet.getRow(1));
  const parentsByKey = new Map<string, ParsedSpecSheetWorkbookParent>();
  const childrenByScopedKey = new Map<
    string,
    ParsedSpecSheetWorkbookChild & {
      rawFields: Array<ParsedSpecSheetWorkbookField & { rowNumber: number; orderPosition: number | null }>;
    }
  >();
  const warnings: string[] = [];
  let duplicateFieldCount = 0;
  let activeParentName = "";
  let activeParentKey = "";

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const parentNameFromRow = workbookCellText(row.getCell(columns.parent));
    if (parentNameFromRow) {
      activeParentName = parentNameFromRow;
      activeParentKey = normalizeSpecSheetKey(parentNameFromRow);
    }

    const childName = workbookCellText(row.getCell(columns.child));
    const fieldName = workbookCellText(row.getCell(columns.field));
    if (!childName && !fieldName) continue;
    if (!activeParentName || !activeParentKey) {
      const err = new Error(`Spec workbook row ${rowNumber} is missing a parent category before any parent was set`);
      (err as any).statusCode = 400;
      throw err;
    }
    if (!childName || isSpecBoilerplateFieldName(fieldName)) continue;

    const childKey = normalizeSpecSheetKey(childName);
    const fieldKey = normalizeSpecSheetKey(fieldName);
    if (!childKey || !fieldKey) continue;
    const scopedChildKey = buildSpecSheetChildScopedKey(activeParentKey, childKey);

    if (!parentsByKey.has(activeParentKey)) {
      parentsByKey.set(activeParentKey, {
        name: activeParentName,
        normalizedName: activeParentKey,
      });
    }

    const existingChild = childrenByScopedKey.get(scopedChildKey);
    const child =
      existingChild ||
      {
        name: childName,
        normalizedName: childKey,
        parentName: activeParentName,
        parentNormalizedName: activeParentKey,
        fields: [],
        rawFields: [],
      };

    child.rawFields.push({
      name: fieldName,
      normalizedName: fieldKey,
      order: 0,
      type: normalizeSpecSheetFieldType(workbookCellText(row.getCell(columns.type))),
      required: normalizeSpecSheetRequired(workbookCellText(row.getCell(columns.required))),
      options: normalizeSpecSheetFieldOptions(workbookCellText(row.getCell(columns.options))),
      rowNumber,
      orderPosition: parseWorkbookOrder(workbookCellText(row.getCell(columns.order))),
    });
    childrenByScopedKey.set(scopedChildKey, child);
  }

  // Deduplicate within the parent/child scope after ordering. This preserves the first
  // intentional occurrence and reports later spreadsheet mistakes as import warnings.
  const children: ParsedSpecSheetWorkbookChild[] = [];
  for (const child of childrenByScopedKey.values()) {
    const seenFields = new Set<string>();
    const sortedFields = [...child.rawFields].sort((a, b) => {
      if (a.orderPosition && b.orderPosition && a.orderPosition !== b.orderPosition) {
        return a.orderPosition - b.orderPosition;
      }
      if (a.orderPosition && !b.orderPosition) return -1;
      if (!a.orderPosition && b.orderPosition) return 1;
      return a.rowNumber - b.rowNumber;
    });

    const fields: ParsedSpecSheetWorkbookField[] = [];
    for (const field of sortedFields) {
      if (seenFields.has(field.normalizedName)) {
        duplicateFieldCount += 1;
        if (warnings.length < 100) {
          warnings.push(`Duplicate field "${field.name}" skipped in "${child.name}"`);
        }
        continue;
      }
      seenFields.add(field.normalizedName);
      fields.push({
        name: field.name,
        normalizedName: field.normalizedName,
        order: fields.length + 1,
        type: field.type,
        required: field.required,
        options: field.type === "select" || field.type === "checkbox" ? field.options : [],
      });
    }

    children.push({
      name: child.name,
      normalizedName: child.normalizedName,
      parentName: child.parentName,
      parentNormalizedName: child.parentNormalizedName,
      fields,
    });
  }

  const parents = [...parentsByKey.values()].sort((a, b) => a.name.localeCompare(b.name));
  children.sort((a, b) => a.parentName.localeCompare(b.parentName) || a.name.localeCompare(b.name));

  return {
    parents,
    children,
    warnings,
    stats: {
      parentCount: parents.length,
      childCount: children.length,
      fieldCount: children.reduce((total, child) => total + child.fields.length, 0),
      duplicateFieldCount,
    },
  };
}

function ensureSupportedExtractionFile(mimetype: string) {
  if (mimetype === "application/pdf" || mimetype.startsWith("image/")) return;
  const err = new Error("Upload a PDF or image file");
  (err as any).statusCode = 400;
  throw err;
}

export async function extractSpecSheetFieldsFromFile(input: {
  buffer: Buffer;
  mimetype: string;
  originalname?: string;
  categoryName?: string;
}): Promise<ExtractedSpecSheetFields> {
  // AI output is treated as an untrusted draft: strict schema constrains its shape and
  // the same field normalizer used by manual input enforces names, ordering, and limits.
  ensureSupportedExtractionFile(input.mimetype);

  const base64 = input.buffer.toString("base64");
  const dataUrl = `data:${input.mimetype};base64,${base64}`;
  const categoryContext = input.categoryName
    ? `\nCategory being edited: ${input.categoryName}.`
    : "";

  const prompt = `Extract only the ordered field names from the uploaded spec sheet document or image.${categoryContext}

Rules:
- Return field labels only, not values.
- Preserve the visual/document order from top to bottom and left to right.
- Do not invent fields that are not visible or stated in the document.
- De-duplicate repeated field names.
- Ignore page headers, footers, company contact blocks, signatures, lot numbers, and handwritten values.
- Use concise field labels such as "Serial Number", "Odometer (Showing Unverified)", "Drive Type".
- If the file does not contain a usable field list, return an empty fields array and explain in notes.`;

  const filePart =
    input.mimetype === "application/pdf"
      ? {
          type: "input_file",
          filename: input.originalname || "spec-sheet.pdf",
          file_data: dataUrl,
        }
      : {
          type: "input_image",
          image_url: dataUrl,
          detail: "high",
        };

  const response = await openai.responses.create({
    model: process.env.SPEC_SHEET_EXTRACTION_MODEL || "gpt-4.1-mini",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          filePart,
        ] as any,
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "spec_sheet_field_extraction",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            fields: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  name: { type: "string" },
                  order: { type: "integer" },
                },
                required: ["name", "order"],
              },
            },
            notes: { type: "string" },
          },
          required: ["fields", "notes"],
        },
      },
    },
  } as any);

  const raw = String((response as any)?.output_text || "{}").trim();
  let parsed: any = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { fields: [], notes: "Software could not parse the extraction result." };
  }

  const fields = normalizeSpecSheetFields(Array.isArray(parsed.fields) ? parsed.fields : [])
    .map((field) => ({ name: field.name, order: field.order }));

  return {
    fields,
    notes: String(parsed.notes || "").trim(),
  };
}
