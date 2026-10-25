/**
 * Administrative schema editor for the auctioneer specification-sheet registry.
 *
 * Parents, categories and ordered fields form a shared configuration consumed by
 * report generation. Mutations validate names/types and preserve ordering invariants;
 * workbook extraction/import is staged through dedicated parsing services before the
 * canonical registry is returned to clients.
 */
import { Response } from "express";
import mongoose from "mongoose";
import SpecSheetCategory from "../models/specSheetCategory.model.js";
import SpecSheetParentCategory from "../models/specSheetParentCategory.model.js";
import { AdminAuthRequest } from "../middleware/admin.middleware.js";
import {
  buildSpecSheetChildScopedKey,
  buildStrictSpecSheetRegistry,
  extractSpecSheetFieldsFromFile,
  formatSpecSheetCategory,
  formatSpecSheetParentCategory,
  normalizeSpecSheetFieldOptions,
  normalizeSpecSheetRequired,
  normalizeSpecSheetFieldType,
  normalizeSpecSheetFields,
  normalizeSpecSheetKey,
  parseSpecSheetWorkbookFromBuffer,
  sanitizeSpecSheetDescription,
  sanitizeSpecSheetName,
} from "../service/specSheetService.js";

let specSheetCategoryScopedIndexReady = false;

function handleSpecSheetError(res: Response, error: unknown) {
  const status = Number((error as any)?.statusCode || 500);
  const message =
    error instanceof Error ? error.message : "Unable to process spec sheet request";
  return res.status(status).json({ message });
}

async function findCategoryOr404(id: string) {
  const category = await SpecSheetCategory.findById(id);
  if (!category) {
    const err = new Error("Spec Sheet category not found");
    (err as any).statusCode = 404;
    throw err;
  }
  return category;
}

async function findParentOr404(id: string) {
  const parent = await SpecSheetParentCategory.findById(id);
  if (!parent) {
    const err = new Error("Spec Sheet parent category not found");
    (err as any).statusCode = 404;
    throw err;
  }
  return parent;
}

function specSheetRegex(value: unknown) {
  return String(value || "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function resolveParentCategoryId(value: unknown): Promise<string | undefined> {
  const raw = String(value || "").trim();
  if (!raw) return undefined;
  if (!mongoose.Types.ObjectId.isValid(raw)) {
    const err = new Error("Parent category id is invalid");
    (err as any).statusCode = 400;
    throw err;
  }
  await findParentOr404(raw);
  return raw;
}

function toPlainField(field: any, order: number) {
  // Rebuilding subdocuments through one normalizer prevents sparse or duplicate order
  // values after move/delete operations and removes options from incompatible types.
  const type = normalizeSpecSheetFieldType(field?.type);
  return {
    _id: field._id,
    name: field.name,
    normalizedName: field.normalizedName,
    order,
    type,
    required: normalizeSpecSheetRequired(field?.required),
    options: type === "select" || type === "checkbox" ? normalizeSpecSheetFieldOptions(field?.options) : [],
  };
}

function reindexPlainFields(fields: any[]) {
  return fields.map((field, index) => toPlainField(field, index + 1));
}

function childCategoryParentScope(parentCategoryId: string | mongoose.Types.ObjectId | undefined) {
  // Child names are unique only within a parent; unassigned legacy categories share a
  // separate null/missing scope rather than colliding with every parent.
  if (parentCategoryId) {
    return { parentCategory: new mongoose.Types.ObjectId(String(parentCategoryId)) };
  }
  return { $or: [{ parentCategory: { $exists: false } }, { parentCategory: null }] };
}

function childCategoryDuplicateFilter(input: {
  normalizedName: string;
  parentCategoryId?: string | mongoose.Types.ObjectId;
  excludeId?: mongoose.Types.ObjectId;
}) {
  const filter: any = {
    normalizedName: input.normalizedName,
    ...childCategoryParentScope(input.parentCategoryId),
  };
  if (input.excludeId) filter._id = { $ne: input.excludeId };
  return filter;
}

async function ensureSpecSheetCategoryScopedIndex() {
  if (specSheetCategoryScopedIndexReady) return;
  // Lazily migrate the legacy global unique index before writes. Mongo's composite
  // index is the concurrency backstop after application-level duplicate checks.
  const indexes = await SpecSheetCategory.collection.indexes();
  for (const index of indexes as any[]) {
    const key = index?.key || {};
    if (index?.unique && key.normalizedName === 1 && Object.keys(key).length === 1) {
      await SpecSheetCategory.collection.dropIndex(index.name);
    }
  }
  await SpecSheetCategory.collection.createIndex(
    { parentCategory: 1, normalizedName: 1 },
    { unique: true, name: "parentCategory_normalizedName_unique" }
  );
  specSheetCategoryScopedIndexReady = true;
}

export const listSpecSheetCategories = async (req: AdminAuthRequest, res: Response) => {
  try {
    const q = normalizeSpecSheetKey(req.query.q);
    const parentCategoryId = String(req.query.parentCategoryId || "").trim();
    const filter = q
      ? {
          $or: [
            { normalizedName: { $regex: specSheetRegex(q), $options: "i" } },
            { name: { $regex: specSheetRegex(req.query.q), $options: "i" } },
          ],
        }
      : {};

    if (parentCategoryId) {
      if (parentCategoryId === "unassigned") {
        (filter as any).$and = [
          ...((filter as any).$and || []),
          { $or: [{ parentCategory: { $exists: false } }, { parentCategory: null }] },
        ];
      } else {
        if (!mongoose.Types.ObjectId.isValid(parentCategoryId)) {
          return res.status(400).json({ message: "Parent category id is invalid" });
        }
        (filter as any).parentCategory = parentCategoryId;
      }
    }

    const categories = await SpecSheetCategory.find(filter).sort({ name: 1 }).lean(false);
    return res.json({ data: categories.map(formatSpecSheetCategory) });
  } catch (error) {
    return handleSpecSheetError(res, error);
  }
};

export const listSpecSheetParents = async (req: AdminAuthRequest, res: Response) => {
  try {
    const q = normalizeSpecSheetKey(req.query.q);
    const filter = q
      ? {
          $or: [
            { normalizedName: { $regex: specSheetRegex(q), $options: "i" } },
            { name: { $regex: specSheetRegex(req.query.q), $options: "i" } },
          ],
        }
      : {};
    const parents = await SpecSheetParentCategory.find(filter).sort({ name: 1 }).lean(false);
    return res.json({ data: parents.map(formatSpecSheetParentCategory) });
  } catch (error) {
    return handleSpecSheetError(res, error);
  }
};

export const createSpecSheetParent = async (req: AdminAuthRequest, res: Response) => {
  try {
    const name = sanitizeSpecSheetName(req.body?.name, "Parent category name");
    const normalizedName = normalizeSpecSheetKey(name);
    const exists = await SpecSheetParentCategory.exists({ normalizedName });
    if (exists) {
      return res.status(409).json({ message: "A parent category with this name already exists" });
    }

    const parent = await SpecSheetParentCategory.create({
      name,
      normalizedName,
      description: sanitizeSpecSheetDescription(req.body?.description),
      createdBy: req.userId,
      updatedBy: req.userId,
    });

    return res.status(201).json({ message: "Spec Sheet parent category created", data: formatSpecSheetParentCategory(parent) });
  } catch (error) {
    return handleSpecSheetError(res, error);
  }
};

export const updateSpecSheetParent = async (req: AdminAuthRequest, res: Response) => {
  try {
    const parent = await findParentOr404(req.params.id);

    if (req.body?.name !== undefined) {
      const name = sanitizeSpecSheetName(req.body.name, "Parent category name");
      const normalizedName = normalizeSpecSheetKey(name);
      const duplicate = await SpecSheetParentCategory.exists({
        _id: { $ne: parent._id },
        normalizedName,
      });
      if (duplicate) {
        return res.status(409).json({ message: "A parent category with this name already exists" });
      }
      parent.name = name;
      parent.normalizedName = normalizedName;
    }

    if (req.body?.description !== undefined) {
      parent.description = sanitizeSpecSheetDescription(req.body.description);
    }
    parent.updatedBy = req.userId as any;
    await parent.save();
    return res.json({ message: "Spec Sheet parent category updated", data: formatSpecSheetParentCategory(parent) });
  } catch (error) {
    return handleSpecSheetError(res, error);
  }
};

export const deleteSpecSheetParent = async (req: AdminAuthRequest, res: Response) => {
  try {
    const parent = await SpecSheetParentCategory.findById(req.params.id);
    if (!parent) return res.status(404).json({ message: "Spec Sheet parent category not found" });

    // Cascade delete is intentional: a parent owns its child category field lists.
    const childResult = await SpecSheetCategory.deleteMany({ parentCategory: parent._id });
    await parent.deleteOne();
    return res.json({
      message: "Spec Sheet parent category deleted",
      data: { deletedChildren: childResult.deletedCount || 0 },
    });
  } catch (error) {
    return handleSpecSheetError(res, error);
  }
};

export const createSpecSheetCategory = async (req: AdminAuthRequest, res: Response) => {
  try {
    await ensureSpecSheetCategoryScopedIndex();
    const name = sanitizeSpecSheetName(req.body?.name, "Category name");
    const normalizedName = normalizeSpecSheetKey(name);
    const parentCategory = await resolveParentCategoryId(req.body?.parentCategoryId);
    const exists = await SpecSheetCategory.exists(
      childCategoryDuplicateFilter({ normalizedName, parentCategoryId: parentCategory })
    );
    if (exists) {
      return res.status(409).json({ message: "A category with this name already exists under this parent" });
    }

    const category = await SpecSheetCategory.create({
      name,
      normalizedName,
      description: sanitizeSpecSheetDescription(req.body?.description),
      parentCategory,
      fields: normalizeSpecSheetFields(req.body?.fields || []),
      createdBy: req.userId,
      updatedBy: req.userId,
    });

    return res.status(201).json({ message: "Spec Sheet category created", data: formatSpecSheetCategory(category) });
  } catch (error) {
    return handleSpecSheetError(res, error);
  }
};

export const updateSpecSheetCategory = async (req: AdminAuthRequest, res: Response) => {
  try {
    await ensureSpecSheetCategoryScopedIndex();
    const category = await findCategoryOr404(req.params.id);
    let nextName = category.name;
    let nextNormalizedName = category.normalizedName;
    let nextParentCategory = category.parentCategory ? String(category.parentCategory) : undefined;

    if (req.body?.name !== undefined) {
      nextName = sanitizeSpecSheetName(req.body.name, "Category name");
      nextNormalizedName = normalizeSpecSheetKey(nextName);
    }

    if (req.body?.description !== undefined) {
      category.description = sanitizeSpecSheetDescription(req.body.description);
    }
    if (req.body?.parentCategoryId !== undefined) {
      nextParentCategory = await resolveParentCategoryId(req.body.parentCategoryId);
    }

    const duplicate = await SpecSheetCategory.exists(
      childCategoryDuplicateFilter({
        normalizedName: nextNormalizedName,
        parentCategoryId: nextParentCategory,
        excludeId: category._id as mongoose.Types.ObjectId,
      })
    );
    if (duplicate) {
      return res.status(409).json({ message: "A category with this name already exists under this parent" });
    }

    category.name = nextName;
    category.normalizedName = nextNormalizedName;
    if (nextParentCategory) {
      category.parentCategory = new mongoose.Types.ObjectId(nextParentCategory) as any;
    } else {
      (category as any).parentCategory = undefined;
    }
    category.updatedBy = req.userId as any;
    await category.save();
    return res.json({ message: "Spec Sheet category updated", data: formatSpecSheetCategory(category) });
  } catch (error) {
    return handleSpecSheetError(res, error);
  }
};

export const deleteSpecSheetCategory = async (req: AdminAuthRequest, res: Response) => {
  try {
    const category = await SpecSheetCategory.findByIdAndDelete(req.params.id);
    if (!category) return res.status(404).json({ message: "Spec Sheet category not found" });
    return res.json({ message: "Spec Sheet category deleted" });
  } catch (error) {
    return handleSpecSheetError(res, error);
  }
};

export const addSpecSheetField = async (req: AdminAuthRequest, res: Response) => {
  try {
    const category = await findCategoryOr404(req.params.id);
    const name = sanitizeSpecSheetName(req.body?.name, "Field name");
    const normalizedName = normalizeSpecSheetKey(name);
    if (category.fields.some((field) => field.normalizedName === normalizedName)) {
      return res.status(409).json({ message: "This field already exists in the category" });
    }
    const [normalizedField] = normalizeSpecSheetFields([
      {
        name,
        type: req.body?.type,
        required: req.body?.required,
        options: req.body?.options,
      },
    ]);
    category.fields.push({
      ...normalizedField,
      normalizedName,
      order: category.fields.length + 1,
    });
    category.updatedBy = req.userId as any;
    await category.save();
    return res.status(201).json({ message: "Spec Sheet field added", data: formatSpecSheetCategory(category) });
  } catch (error) {
    return handleSpecSheetError(res, error);
  }
};

export const updateSpecSheetField = async (req: AdminAuthRequest, res: Response) => {
  try {
    const category = await findCategoryOr404(req.params.id);
    const field = category.fields.find((item: any) => String(item._id) === req.params.fieldId);
    if (!field) return res.status(404).json({ message: "Spec Sheet field not found" });

    if (req.body?.name !== undefined) {
      const name = sanitizeSpecSheetName(req.body.name, "Field name");
      const normalizedName = normalizeSpecSheetKey(name);
      const duplicate = category.fields.some(
        (item: any) => String(item._id) !== req.params.fieldId && item.normalizedName === normalizedName
      );
      if (duplicate) {
        return res.status(409).json({ message: "This field already exists in the category" });
      }
      field.name = name;
      field.normalizedName = normalizedName;
    }

    if (req.body?.type !== undefined || req.body?.options !== undefined || req.body?.required !== undefined) {
      const nextType =
        req.body?.type !== undefined
          ? normalizeSpecSheetFieldType(req.body.type)
          : normalizeSpecSheetFieldType((field as any).type);
      (field as any).type = nextType;
      if (req.body?.required !== undefined) {
        (field as any).required = normalizeSpecSheetRequired(req.body.required);
      }
      (field as any).options =
        nextType === "select" || nextType === "checkbox"
          ? normalizeSpecSheetFieldOptions(
              req.body?.options !== undefined ? req.body.options : (field as any).options
            )
          : [];
    }

    if (req.body?.order !== undefined) {
      const targetOrder = Math.max(1, Math.min(category.fields.length, Number(req.body.order) || field.order));
      const fieldValue = toPlainField(field, targetOrder);
      const remaining = category.fields
        .filter((item: any) => String(item._id) !== req.params.fieldId)
        .sort((a, b) => a.order - b.order);
      remaining.splice(targetOrder - 1, 0, fieldValue);
      category.fields = reindexPlainFields(remaining);
    } else {
      category.fields = reindexPlainFields(category.fields);
    }

    category.updatedBy = req.userId as any;
    await category.save();
    return res.json({ message: "Spec Sheet field updated", data: formatSpecSheetCategory(category) });
  } catch (error) {
    return handleSpecSheetError(res, error);
  }
};

export const deleteSpecSheetField = async (req: AdminAuthRequest, res: Response) => {
  try {
    const category = await findCategoryOr404(req.params.id);
    const before = category.fields.length;
    category.fields = category.fields.filter((item: any) => String(item._id) !== req.params.fieldId);
    if (category.fields.length === before) {
      return res.status(404).json({ message: "Spec Sheet field not found" });
    }
    category.fields = reindexPlainFields(category.fields);
    category.updatedBy = req.userId as any;
    await category.save();
    return res.json({ message: "Spec Sheet field deleted", data: formatSpecSheetCategory(category) });
  } catch (error) {
    return handleSpecSheetError(res, error);
  }
};

export const reorderSpecSheetFields = async (req: AdminAuthRequest, res: Response) => {
  try {
    const category = await findCategoryOr404(req.params.id);
    const fieldIds = Array.isArray(req.body?.fieldIds) ? req.body.fieldIds.map(String) : [];
    const currentIds = category.fields.map((field: any) => String(field._id));
    // Require a complete permutation so omission or duplication cannot silently delete
    // a field while an administrator is only trying to change display order.
    const valid =
      fieldIds.length === currentIds.length &&
      fieldIds.every((id: string) => currentIds.includes(id)) &&
      new Set(fieldIds).size === fieldIds.length;
    if (!valid) {
      return res.status(400).json({ message: "Reorder payload must include every field exactly once" });
    }
    const byId = new Map(category.fields.map((field: any) => [String(field._id), field]));
    category.fields = fieldIds.map((id: string, index: number) => toPlainField(byId.get(id), index + 1));
    category.updatedBy = req.userId as any;
    await category.save();
    return res.json({ message: "Spec Sheet fields reordered", data: formatSpecSheetCategory(category) });
  } catch (error) {
    return handleSpecSheetError(res, error);
  }
};

export const bulkSaveSpecSheetFields = async (req: AdminAuthRequest, res: Response) => {
  try {
    const category = await findCategoryOr404(req.params.id);
    const mode = req.body?.mode === "replace" ? "replace" : "append";
    const incoming = normalizeSpecSheetFields(req.body?.fields || []);

    // Replace treats the submitted list as authoritative; append retains existing
    // fields and ignores normalized-name duplicates for repeatable import retries.
    if (mode === "replace") {
      category.fields = incoming;
    } else {
      const existing = new Set(category.fields.map((field) => field.normalizedName));
      const appended = incoming
        .filter((field) => !existing.has(field.normalizedName))
        .map((field, index) => ({
          ...field,
          order: category.fields.length + index + 1,
        }));
      category.fields = [...category.fields, ...appended];
    }

    category.fields = reindexPlainFields(category.fields);
    category.updatedBy = req.userId as any;
    await category.save();
    return res.json({ message: "Spec Sheet fields saved", data: formatSpecSheetCategory(category) });
  } catch (error) {
    return handleSpecSheetError(res, error);
  }
};

export const extractSpecSheetFields = async (req: AdminAuthRequest, res: Response) => {
  try {
    const category = await findCategoryOr404(req.params.id);
    const file = req.file;
    if (!file) return res.status(400).json({ message: "Upload a PDF or image file" });
    // Extraction is suggestion-only. It never mutates the registry until an admin
    // explicitly submits the resulting fields through a save endpoint.
    const data = await extractSpecSheetFieldsFromFile({
      buffer: file.buffer,
      mimetype: file.mimetype,
      originalname: file.originalname,
      categoryName: category.name,
    });
    return res.json({ message: "Spec Sheet fields extracted", data });
  } catch (error) {
    return handleSpecSheetError(res, error);
  }
};

export const importSpecSheetWorkbook = async (req: AdminAuthRequest, res: Response) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ message: "Upload an .xlsx workbook" });
    const isXlsx =
      file.mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      /\.xlsx$/i.test(file.originalname || "");
    if (!isXlsx) return res.status(400).json({ message: "Upload an .xlsx workbook" });

    const parsed = await parseSpecSheetWorkbookFromBuffer(file.buffer);
    const dryRun =
      String(req.query.dryRun ?? req.body?.dryRun ?? "")
        .trim()
        .toLowerCase() === "true";
    const mode = String(req.query.mode ?? req.body?.mode ?? "replace").trim().toLowerCase();

    // Dry-run returns the normalized topology before any database write, allowing the
    // UI and operators to review a workbook safely.
    if (dryRun) {
      return res.json({
        message: "Spec Sheet workbook parsed",
        data: parsed,
      });
    }

    if (mode !== "replace") {
      return res.status(400).json({ message: "Only replace mode is supported for workbook import" });
    }

    await ensureSpecSheetCategoryScopedIndex();

    // Replace mode treats the workbook as the complete desired registry. Stable
    // normalized keys allow rerunning the same import as upserts instead of duplicates.
    const importedParentKeys = new Set(parsed.parents.map((parent) => parent.normalizedName));
    const importedChildKeys = new Set(
      parsed.children.map((child) =>
        buildSpecSheetChildScopedKey(child.parentNormalizedName, child.normalizedName)
      )
    );
    const parentIdByKey = new Map<string, mongoose.Types.ObjectId>();

    for (const parent of parsed.parents) {
      const doc = await SpecSheetParentCategory.findOneAndUpdate(
        { normalizedName: parent.normalizedName },
        {
          $set: {
            name: parent.name,
            normalizedName: parent.normalizedName,
            updatedBy: req.userId,
          },
          $setOnInsert: {
            description: "",
            createdBy: req.userId,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      parentIdByKey.set(parent.normalizedName, doc._id as mongoose.Types.ObjectId);
    }

    for (const child of parsed.children) {
      const parentId = parentIdByKey.get(child.parentNormalizedName);
      if (!parentId) {
        return res.status(400).json({ message: `Parent category missing for child "${child.name}"` });
      }

      await SpecSheetCategory.findOneAndUpdate(
        { normalizedName: child.normalizedName, parentCategory: parentId },
        {
          $set: {
            name: child.name,
            normalizedName: child.normalizedName,
            parentCategory: parentId,
            fields: child.fields.map((field) => ({
              name: field.name,
              normalizedName: field.normalizedName,
              order: field.order,
              type: field.type,
              required: field.required,
              options: field.options,
            })),
            updatedBy: req.userId,
          },
          $setOnInsert: {
            description: "",
            createdBy: req.userId,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    }

    const parentKeyById = new Map(
      [...parentIdByKey.entries()].map(([parentKey, parentId]) => [String(parentId), parentKey])
    );
    const existingChildren = await SpecSheetCategory.find({})
      .select("_id normalizedName parentCategory")
      .lean();
    const childrenToDelete = existingChildren
      .filter((child: any) => {
        const parentKey = parentKeyById.get(String(child.parentCategory || ""));
        if (!parentKey) return true;
        return !importedChildKeys.has(buildSpecSheetChildScopedKey(parentKey, child.normalizedName));
      })
      .map((child: any) => child._id);

    // Remove records absent from the authoritative workbook only after all imported
    // parents and children have been upserted successfully.
    const [deletedChildren, deletedParents] = await Promise.all([
      childrenToDelete.length
        ? SpecSheetCategory.deleteMany({ _id: { $in: childrenToDelete } })
        : Promise.resolve({ deletedCount: 0 }),
      SpecSheetParentCategory.deleteMany({ normalizedName: { $nin: [...importedParentKeys] } }),
    ]);

    return res.json({
      message: "Spec Sheet workbook imported",
      data: {
        ...parsed,
        deletedChildren: deletedChildren.deletedCount || 0,
        deletedParents: deletedParents.deletedCount || 0,
      },
    });
  } catch (error) {
    return handleSpecSheetError(res, error);
  }
};

export const getSpecSheetRegistryJson = async (_req: AdminAuthRequest, res: Response) => {
  try {
    // Build through the strict formatter so report-generation consumers never need to
    // understand Mongoose documents or legacy null-parent representation.
    const [parents, children] = await Promise.all([
      SpecSheetParentCategory.find({}).sort({ name: 1 }).lean(false),
      SpecSheetCategory.find({}).sort({ name: 1 }).lean(false),
    ]);
    return res.json({ data: buildStrictSpecSheetRegistry({ parents, children }) });
  } catch (error) {
    return handleSpecSheetError(res, error);
  }
};
