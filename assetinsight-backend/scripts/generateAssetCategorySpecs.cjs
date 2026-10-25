const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

const root = path.resolve(__dirname, "..");
const workbookPath = path.join(
  root,
  "src",
  "excel",
  "McDougall_Child_Category_Specifications_Reordered_v2.xlsx"
);
const outputPath = path.join(root, "src", "utils", "assetCategorySpecs.ts");
const sheetName = "Auctioneer Import";

function cleanText(value) {
  return String(value ?? "").trim();
}

function normalized(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isBoilerplateFieldName(value) {
  const text = cleanText(value);
  if (!text) return true;
  const lower = text.toLowerCase();
  return (
    text.length > 140 ||
    /title clearance clarification fee/i.test(text) ||
    /applied to your invoice/i.test(text) ||
    /over and above the purchase price/i.test(text) ||
    /applicable taxes/i.test(text) ||
    /following the close of the sale/i.test(text) ||
    (/[.!?]/.test(text) && /\b(fee|invoice|tax|purchase price|sale)\b/i.test(lower))
  );
}

function cellText(cell) {
  if (!cell) return "";
  if (cell.text) return cleanText(cell.text);
  const value = cell.value;
  if (value && typeof value === "object") {
    if (Array.isArray(value.richText)) {
      return cleanText(value.richText.map((part) => part.text || "").join(""));
    }
    if (value.text) return cleanText(value.text);
    if (value.result) return cleanText(value.result);
  }
  return cleanText(value);
}

function findHeaderColumns(headerRow) {
  const headers = new Map();
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers.set(normalized(cellText(cell)), colNumber);
  });

  const parentCol = headers.get("parentcategory");
  const orderCol = headers.get("orderposition");
  const childCol = headers.get("childcategory");
  const fieldCol = headers.get("fieldname");
  const typeCol = headers.get("fieldtype");
  const requiredCol = headers.get("required");
  const optionsCol = headers.get("options");

  if (!parentCol || !orderCol || !childCol || !fieldCol || !typeCol || !requiredCol || !optionsCol) {
    throw new Error(
      `Could not find required Auctioneer Import headers. Found: ${[
        ...headers.keys(),
      ].join(", ")}`
    );
  }

  return { parentCol, orderCol, childCol, fieldCol, typeCol, requiredCol, optionsCol };
}

function parseOrderPosition(value) {
  const numeric = Number(cleanText(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function normalizeFieldType(value) {
  const type = cleanText(value).toLowerCase().replace(/\s+/g, "");
  if (type === "number") return "number";
  if (type === "dropdown") return "select";
  if (type === "checkbox" || type === "checkboxgroup") return "checkbox";
  return "text";
}

function parseRequired(value) {
  const text = cleanText(value).toLowerCase();
  return text === "y" || text === "yes" || text === "true" || text === "1" || text === "required";
}

function parseOptions(value) {
  const text = cleanText(value);
  if (!text) return [];
  const rawOptions = text.includes(" / ")
    ? text.split(/\s+\/\s+/g)
    : text.split(/[\n,]+/g);
  const seen = new Set();
  const options = [];
  for (const raw of rawOptions) {
    const option = cleanText(raw);
    const key = normalized(option);
    if (!option || !key || seen.has(key)) continue;
    seen.add(key);
    options.push(option);
  }
  return options;
}

function stableStringify(value) {
  return JSON.stringify(value, null, 2);
}

async function main() {
  if (!fs.existsSync(workbookPath)) {
    throw new Error(`Workbook not found: ${workbookPath}`);
  }

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(workbookPath);
  const worksheet = workbook.getWorksheet(sheetName);
  if (!worksheet) throw new Error(`Workbook tab not found: ${sheetName}`);

  const { parentCol, orderCol, childCol, fieldCol, typeCol, requiredCol, optionsCol } = findHeaderColumns(worksheet.getRow(1));
  const byChild = new Map();
  let currentParent = "";

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const parentFromRow = cellText(row.getCell(parentCol));
    if (parentFromRow) currentParent = parentFromRow;
    const childCategory = cellText(row.getCell(childCol));
    const fieldName = cellText(row.getCell(fieldCol));
    if (!childCategory || !fieldName) continue;
    if (isBoilerplateFieldName(fieldName)) continue;

    const key = childCategory;
    if (!byChild.has(key)) {
      byChild.set(key, {
        parentCategory: currentParent,
        childCategory,
        rawFields: [],
      });
    }

    const entry = byChild.get(key);
    entry.rawFields.push({
      name: fieldName,
      normalizedName: normalized(fieldName),
      orderPosition: parseOrderPosition(cellText(row.getCell(orderCol))),
      rowNumber,
      type: normalizeFieldType(cellText(row.getCell(typeCol))),
      required: parseRequired(cellText(row.getCell(requiredCol))),
      options: parseOptions(cellText(row.getCell(optionsCol))),
    });
  }

  const specs = Array.from(byChild.values()).map((entry) => {
    const seenFields = new Set();
    const fieldDefinitions = [];
    const sortedFields = [...entry.rawFields].sort((a, b) => {
      if (a.orderPosition && b.orderPosition && a.orderPosition !== b.orderPosition) return a.orderPosition - b.orderPosition;
      if (a.orderPosition && !b.orderPosition) return -1;
      if (!a.orderPosition && b.orderPosition) return 1;
      return a.rowNumber - b.rowNumber;
    });

    for (const field of sortedFields) {
      if (!field.normalizedName || seenFields.has(field.normalizedName)) continue;
      seenFields.add(field.normalizedName);
      fieldDefinitions.push({
        name: field.name,
        order: fieldDefinitions.length + 1,
        type: field.type,
        required: field.required,
        options: field.type === "select" || field.type === "checkbox" ? field.options : [],
      });
    }

    return {
      parentCategory: entry.parentCategory,
      childCategory: entry.childCategory,
      fields: fieldDefinitions.map((field) => field.name),
      fieldDefinitions,
    };
  });

  // Keep generated output byte-for-byte stable across developer and production
  // machines. Absolute paths made every production build dirty after prebuild.
  const sourceForComment = path
    .relative(root, workbookPath)
    .replace(/\\/g, "/");
const output = `// Generated from the workbook tab "${sheetName}".
// Source workbook: ${sourceForComment}
// Generation rule: sort by Order Position where present, then row order, and de-duplicate Field Name values per Child Category.
// Run: npm run generate:asset-category-specs

export interface AssetCategorySpec {
  parentCategory: string;
  childCategory: string;
  fields: string[];
  fieldDefinitions: Array<{
    name: string;
    order: number;
    type: "text" | "number" | "select" | "checkbox";
    required: boolean;
    options: string[];
  }>;
}

export const assetCategorySpecs = ${stableStringify(specs)} satisfies AssetCategorySpec[];

export const allowedCategories = assetCategorySpecs.map((spec) => spec.childCategory);

export const masterSpecHeaders = Array.from(
  new Set(assetCategorySpecs.flatMap((spec) => spec.fields))
);

const categorySelectionGroups = assetCategorySpecs.reduce<Record<string, string[]>>(
  (groups, spec) => {
    const parent = spec.parentCategory || "Unassigned";
    if (!groups[parent]) groups[parent] = [];
    groups[parent].push(spec.childCategory);
    return groups;
  },
  {}
);

// Compact category-only prompt for initial image analysis. The full Field Name
// registry is intentionally kept out of that prompt to avoid very large input
// token usage; focused repair/enrichment steps can still use assetCategorySpecPrompt.
export const assetCategorySelectionPrompt = Object.entries(categorySelectionGroups)
  .map(([parent, children]) => \`\${parent}: \${children.join(", ")}\`)
  .join("\\n");

export const assetCategorySpecPrompt = assetCategorySpecs
  .map(
    (spec) =>
      \`\${spec.childCategory} (parent: \${spec.parentCategory}) -> \${spec.fields.join(" | ")}\`
  )
  .join("\\n");
`;

  fs.writeFileSync(outputPath, output, "utf8");
  console.log(
    `Generated ${path.relative(root, outputPath)} from ${sheetName}: ${specs.length} categories`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
