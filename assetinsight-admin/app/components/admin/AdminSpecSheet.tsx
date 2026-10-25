"use client";

import AddRoundedIcon from "@mui/icons-material/AddRounded";
import ArrowDownwardRoundedIcon from "@mui/icons-material/ArrowDownwardRounded";
import ArrowUpwardRoundedIcon from "@mui/icons-material/ArrowUpwardRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import DeleteOutlineRoundedIcon from "@mui/icons-material/DeleteOutlineRounded";
import EditRoundedIcon from "@mui/icons-material/EditRounded";
import FolderRoundedIcon from "@mui/icons-material/FolderRounded";
import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";
import SaveRoundedIcon from "@mui/icons-material/SaveRounded";
import SearchRoundedIcon from "@mui/icons-material/SearchRounded";
import UploadFileRoundedIcon from "@mui/icons-material/UploadFileRounded";
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Drawer,
  IconButton,
  InputAdornment,
  FormControlLabel,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useMemo, useState } from "react";

type SpecFieldType = "text" | "number" | "select" | "checkbox";

type SpecField = {
  _id: string;
  name: string;
  normalizedName: string;
  order: number;
  type?: SpecFieldType;
  required?: boolean;
  options?: string[];
};

type SpecCategory = {
  _id: string;
  name: string;
  normalizedName: string;
  description: string;
  parentCategoryId?: string;
  fields: SpecField[];
  createdAt: string;
  updatedAt: string;
};

type SpecParentCategory = {
  _id: string;
  name: string;
  normalizedName: string;
  description: string;
  createdAt: string;
  updatedAt: string;
};

type ExtractedField = {
  name: string;
  order: number;
  type?: SpecFieldType;
  required?: boolean;
  options?: string[];
};

type WorkbookImportSummary = {
  parents: Array<{ name: string; normalizedName: string }>;
  children: Array<{ name: string; normalizedName: string; parentName: string; fields: SpecField[] }>;
  warnings: string[];
  stats: {
    parentCount: number;
    childCount: number;
    fieldCount: number;
    duplicateFieldCount: number;
  };
  deletedParents?: number;
  deletedChildren?: number;
};

type EditDialogState =
  | {
      open: false;
      kind?: "parent" | "category";
      id?: string;
      name: string;
      description: string;
      parentCategoryId?: string;
    }
  | {
      open: true;
      kind: "parent" | "category";
      id?: string;
      name: string;
      description: string;
      parentCategoryId?: string;
    };

async function readJson<T = any>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || "Request failed");
  return data as T;
}

function normalizeFieldName(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizeFieldType(value: unknown): SpecFieldType {
  return value === "number" || value === "select" || value === "checkbox" ? value : "text";
}

function optionsToDraft(options: unknown): string {
  return Array.isArray(options)
    ? options.map((item) => String(item || "").trim()).filter(Boolean).join(", ")
    : "";
}

function parseOptions(value: string): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  const rawValues = value.includes(" / ") ? value.split(/\s+\/\s+/g) : value.split(/[\n,]+/g);
  for (const raw of rawValues) {
    const option = raw.trim().replace(/\s+/g, " ");
    if (!option) continue;
    const key = normalizeFieldName(option);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    next.push(option);
  }
  return next;
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Recently";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function initials(name: string) {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "S"
  );
}

export default function AdminSpecSheet() {
  const [parents, setParents] = useState<SpecParentCategory[]>([]);
  const [categories, setCategories] = useState<SpecCategory[]>([]);
  const [selectedParentId, setSelectedParentId] = useState("");
  const [selectedCategoryId, setSelectedCategoryId] = useState("");
  const [parentDrawerOpen, setParentDrawerOpen] = useState(false);
  const [categoryDrawerOpen, setCategoryDrawerOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [editDialog, setEditDialog] = useState<EditDialogState>({
    open: false,
    name: "",
    description: "",
  });
  const [fieldDrafts, setFieldDrafts] = useState<Record<string, string>>({});
  const [fieldTypeDrafts, setFieldTypeDrafts] = useState<Record<string, SpecFieldType>>({});
  const [fieldOptionsDrafts, setFieldOptionsDrafts] = useState<Record<string, string>>({});
  const [fieldRequiredDrafts, setFieldRequiredDrafts] = useState<Record<string, boolean>>({});
  const [newFieldName, setNewFieldName] = useState("");
  const [newFieldType, setNewFieldType] = useState<SpecFieldType>("text");
  const [newFieldOptions, setNewFieldOptions] = useState("");
  const [newFieldRequired, setNewFieldRequired] = useState(false);
  const [extractFile, setExtractFile] = useState<File | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [extractedFields, setExtractedFields] = useState<ExtractedField[]>([]);
  const [extractionNotes, setExtractionNotes] = useState("");
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPreview, setImportPreview] = useState<WorkbookImportSummary | null>(null);
  const [importConfirmed, setImportConfirmed] = useState(false);
  const [importingWorkbook, setImportingWorkbook] = useState(false);

  const selectedParent = useMemo(
    () => parents.find((parent) => parent._id === selectedParentId) || null,
    [parents, selectedParentId]
  );
  const selectedCategory = useMemo(
    () => categories.find((category) => category._id === selectedCategoryId) || null,
    [categories, selectedCategoryId]
  );

  const childCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const category of categories) {
      if (!category.parentCategoryId) continue;
      counts.set(category.parentCategoryId, (counts.get(category.parentCategoryId) || 0) + 1);
    }
    return counts;
  }, [categories]);

  const fieldCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const category of categories) {
      if (!category.parentCategoryId) continue;
      counts.set(
        category.parentCategoryId,
        (counts.get(category.parentCategoryId) || 0) + category.fields.length
      );
    }
    return counts;
  }, [categories]);

  const filteredParents = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return parents;
    return parents.filter((parent) =>
      `${parent.name} ${parent.description}`.toLowerCase().includes(q)
    );
  }, [parents, search]);

  const parentChildren = useMemo(
    () =>
      selectedParent
        ? categories
            .filter((category) => category.parentCategoryId === selectedParent._id)
            .sort((a, b) => a.name.localeCompare(b.name))
        : [],
    [categories, selectedParent]
  );

  const unassignedCategories = useMemo(() => {
    const q = search.trim().toLowerCase();
    const items = categories.filter((category) => !category.parentCategoryId);
    if (!q) return items.sort((a, b) => a.name.localeCompare(b.name));
    return items
      .filter((category) => `${category.name} ${category.description}`.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [categories, search]);

  const loadSpecSheet = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [parentData, categoryData] = await Promise.all([
        readJson<{ data: SpecParentCategory[] }>(
          await fetch("/api/admin/spec-sheet/parents", { cache: "no-store" })
        ),
        readJson<{ data: SpecCategory[] }>(
          await fetch("/api/admin/spec-sheet/categories", { cache: "no-store" })
        ),
      ]);
      setParents(parentData.data || []);
      setCategories(categoryData.data || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load CR Management");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSpecSheet();
  }, [loadSpecSheet]);

  useEffect(() => {
    if (!selectedCategory) {
      setFieldDrafts({});
      setFieldTypeDrafts({});
      setFieldOptionsDrafts({});
      setFieldRequiredDrafts({});
      setCategoryDrawerOpen(false);
      return;
    }
    setFieldDrafts(
      Object.fromEntries(selectedCategory.fields.map((field) => [field._id, field.name]))
    );
    setFieldTypeDrafts(
      Object.fromEntries(
        selectedCategory.fields.map((field) => [field._id, normalizeFieldType(field.type)])
      )
    );
    setFieldOptionsDrafts(
      Object.fromEntries(
        selectedCategory.fields.map((field) => [field._id, optionsToDraft(field.options)])
      )
    );
    setFieldRequiredDrafts(
      Object.fromEntries(
        selectedCategory.fields.map((field) => [field._id, Boolean(field.required)])
      )
    );
  }, [selectedCategory]);

  useEffect(() => {
    setNewFieldName("");
    setNewFieldType("text");
    setNewFieldOptions("");
    setNewFieldRequired(false);
    setExtractFile(null);
    setExtractedFields([]);
    setExtractionNotes("");
  }, [selectedCategoryId]);

  function upsertParent(parent: SpecParentCategory) {
    setParents((current) => {
      const exists = current.some((item) => item._id === parent._id);
      const next = exists
        ? current.map((item) => (item._id === parent._id ? parent : item))
        : [...current, parent];
      return next.sort((a, b) => a.name.localeCompare(b.name));
    });
    setSelectedParentId(parent._id);
  }

  function upsertCategory(category: SpecCategory) {
    setCategories((current) => {
      const exists = current.some((item) => item._id === category._id);
      const next = exists
        ? current.map((item) => (item._id === category._id ? category : item))
        : [...current, category];
      return next.sort((a, b) => a.name.localeCompare(b.name));
    });
    setSelectedCategoryId(category._id);
  }

  function openParent(parentId: string) {
    setSelectedParentId(parentId);
    setParentDrawerOpen(true);
  }

  function openCategory(categoryId: string) {
    setSelectedCategoryId(categoryId);
    setCategoryDrawerOpen(true);
  }

  async function saveEditDialog() {
    if (!editDialog.open) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      if (editDialog.kind === "parent") {
        const isEdit = Boolean(editDialog.id);
        const data = await readJson<{ data: SpecParentCategory; message?: string }>(
          await fetch(
            isEdit
              ? `/api/admin/spec-sheet/parents/${editDialog.id}`
              : "/api/admin/spec-sheet/parents",
            {
              method: isEdit ? "PATCH" : "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: editDialog.name,
                description: editDialog.description,
              }),
            }
          )
        );
        upsertParent(data.data);
        setParentDrawerOpen(true);
        setSuccess(data.message || "Parent category saved");
      } else {
        const isEdit = Boolean(editDialog.id);
        const data = await readJson<{ data: SpecCategory; message?: string }>(
          await fetch(
            isEdit
              ? `/api/admin/spec-sheet/categories/${editDialog.id}`
              : "/api/admin/spec-sheet/categories",
            {
              method: isEdit ? "PATCH" : "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: editDialog.name,
                description: editDialog.description,
                parentCategoryId: editDialog.parentCategoryId || "",
              }),
            }
          )
        );
        upsertCategory(data.data);
        setSelectedParentId(data.data.parentCategoryId || selectedParentId);
        setParentDrawerOpen(true);
        setCategoryDrawerOpen(true);
        setSuccess(data.message || "Child category saved");
      }
      setEditDialog({ open: false, name: "", description: "" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save CR Management item");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelectedParent() {
    if (!selectedParent) return;
    const childCount = childCounts.get(selectedParent._id) || 0;
    const confirmed = window.confirm(
      `Delete "${selectedParent.name}"? This will also delete ${childCount} child categor${childCount === 1 ? "y" : "ies"} and all fields inside them.`
    );
    if (!confirmed) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const data = await readJson<{ data?: { deletedChildren?: number }; message?: string }>(
        await fetch(`/api/admin/spec-sheet/parents/${selectedParent._id}`, { method: "DELETE" })
      );
      setParents((current) => current.filter((item) => item._id !== selectedParent._id));
      setCategories((current) =>
        current.filter((category) => category.parentCategoryId !== selectedParent._id)
      );
      setSelectedParentId("");
      setSelectedCategoryId("");
      setParentDrawerOpen(false);
      setCategoryDrawerOpen(false);
      setSuccess(
        data.message ||
          `Parent deleted${data.data?.deletedChildren ? ` with ${data.data.deletedChildren} child categories` : ""}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete parent category");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelectedCategory() {
    if (!selectedCategory) return;
    if (!window.confirm(`Delete "${selectedCategory.name}" and all of its fields?`)) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const data = await readJson<{ message?: string }>(
        await fetch(`/api/admin/spec-sheet/categories/${selectedCategory._id}`, { method: "DELETE" })
      );
      setCategories((current) => current.filter((item) => item._id !== selectedCategory._id));
      setSelectedCategoryId("");
      setCategoryDrawerOpen(false);
      setSuccess(data.message || "Child category deleted");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete child category");
    } finally {
      setBusy(false);
    }
  }

  async function addField() {
    if (!selectedCategory) return;
    const name = newFieldName.trim();
    if (!name) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const data = await readJson<{ data: SpecCategory; message?: string }>(
        await fetch(`/api/admin/spec-sheet/categories/${selectedCategory._id}/fields`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name,
            type: newFieldType,
            required: newFieldRequired,
            options: newFieldType === "select" || newFieldType === "checkbox" ? parseOptions(newFieldOptions) : [],
          }),
        })
      );
      upsertCategory(data.data);
      setNewFieldName("");
      setNewFieldType("text");
      setNewFieldOptions("");
      setNewFieldRequired(false);
      setSuccess(data.message || "Field added");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to add field");
    } finally {
      setBusy(false);
    }
  }

  async function updateField(field: SpecField) {
    if (!selectedCategory) return;
    const name = (fieldDrafts[field._id] || "").trim();
    const type = normalizeFieldType(fieldTypeDrafts[field._id] || field.type);
    const required = Boolean(fieldRequiredDrafts[field._id]);
    const options = type === "select" || type === "checkbox" ? parseOptions(fieldOptionsDrafts[field._id] || "") : [];
    if (!name) {
      setError("Field name is required");
      return;
    }
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const data = await readJson<{ data: SpecCategory; message?: string }>(
        await fetch(
          `/api/admin/spec-sheet/categories/${selectedCategory._id}/fields/${field._id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, type, required, options }),
          }
        )
      );
      upsertCategory(data.data);
      setSuccess(data.message || "Field updated");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update field");
    } finally {
      setBusy(false);
    }
  }

  async function deleteField(field: SpecField) {
    if (!selectedCategory) return;
    if (!window.confirm(`Delete field "${field.name}"?`)) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const data = await readJson<{ data: SpecCategory; message?: string }>(
        await fetch(
          `/api/admin/spec-sheet/categories/${selectedCategory._id}/fields/${field._id}`,
          { method: "DELETE" }
        )
      );
      upsertCategory(data.data);
      setSuccess(data.message || "Field deleted");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete field");
    } finally {
      setBusy(false);
    }
  }

  async function reorderFields(fromIndex: number, toIndex: number) {
    if (!selectedCategory) return;
    const fields = [...selectedCategory.fields];
    if (toIndex < 0 || toIndex >= fields.length) return;
    const [moved] = fields.splice(fromIndex, 1);
    fields.splice(toIndex, 0, moved);
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const data = await readJson<{ data: SpecCategory; message?: string }>(
        await fetch(`/api/admin/spec-sheet/categories/${selectedCategory._id}/fields/reorder`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fieldIds: fields.map((field) => field._id) }),
        })
      );
      upsertCategory(data.data);
      setSuccess(data.message || "Fields reordered");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to reorder fields");
    } finally {
      setBusy(false);
    }
  }

  async function extractFields() {
    if (!selectedCategory || !extractFile) return;
    setExtracting(true);
    setError("");
    setSuccess("");
    setExtractedFields([]);
    setExtractionNotes("");
    try {
      const form = new FormData();
      form.append("file", extractFile);
      const data = await readJson<{
        data: { fields: ExtractedField[]; notes: string };
        message?: string;
      }>(
        await fetch(`/api/admin/spec-sheet/categories/${selectedCategory._id}/extract-fields`, {
          method: "POST",
          body: form,
        })
      );
      setExtractedFields(data.data?.fields || []);
      setExtractionNotes(data.data?.notes || "");
      setSuccess(data.message || "Fields extracted for review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to extract fields");
    } finally {
      setExtracting(false);
    }
  }

  async function saveExtracted(mode: "append" | "replace") {
    if (!selectedCategory || extractedFields.length === 0) return;
    if (mode === "replace" && !window.confirm("Replace all existing fields with this extracted list?")) return;
    setBusy(true);
    setError("");
    setSuccess("");
    try {
      const data = await readJson<{ data: SpecCategory; message?: string }>(
        await fetch(`/api/admin/spec-sheet/categories/${selectedCategory._id}/fields/bulk`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode, fields: extractedFields }),
        })
      );
      upsertCategory(data.data);
      setExtractedFields([]);
      setExtractionNotes("");
      setExtractFile(null);
      setSuccess(mode === "replace" ? "Extracted fields replaced category fields" : "Extracted fields appended");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save extracted fields");
    } finally {
      setBusy(false);
    }
  }

  async function previewWorkbookImport() {
    if (!importFile) return;
    setImportingWorkbook(true);
    setError("");
    setSuccess("");
    setImportPreview(null);
    setImportConfirmed(false);
    try {
      const form = new FormData();
      form.append("file", importFile);
      const data = await readJson<{ data: WorkbookImportSummary; message?: string }>(
        await fetch("/api/admin/spec-sheet/import-workbook?dryRun=true", {
          method: "POST",
          body: form,
        })
      );
      setImportPreview(data.data);
      setSuccess(data.message || "Workbook parsed for review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to parse workbook");
    } finally {
      setImportingWorkbook(false);
    }
  }

  async function replaceRegistryFromWorkbook() {
    if (!importFile || !importPreview || !importConfirmed) return;
    setImportingWorkbook(true);
    setError("");
    setSuccess("");
    try {
      const form = new FormData();
      form.append("file", importFile);
      form.append("mode", "replace");
      const data = await readJson<{ data: WorkbookImportSummary; message?: string }>(
        await fetch("/api/admin/spec-sheet/import-workbook?mode=replace", {
          method: "POST",
          body: form,
        })
      );
      setImportDialogOpen(false);
      setImportFile(null);
      setImportPreview(null);
      setImportConfirmed(false);
      setSelectedParentId("");
      setSelectedCategoryId("");
      setParentDrawerOpen(false);
      setCategoryDrawerOpen(false);
      setSuccess(
        `${data.message || "Workbook imported"}: ${data.data.stats.parentCount} parents, ${data.data.stats.childCount} child categories, ${data.data.stats.fieldCount} fields`
      );
      await loadSpecSheet();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to import workbook");
    } finally {
      setImportingWorkbook(false);
    }
  }

  const existingFieldKeys = useMemo(
    () => new Set((selectedCategory?.fields || []).map((field) => normalizeFieldName(field.name))),
    [selectedCategory]
  );

  const totalFields = useMemo(
    () => categories.reduce((count, category) => count + category.fields.length, 0),
    [categories]
  );

  const parentDrawer = selectedParent ? (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column", bgcolor: "background.default" }}>
      <Box
        sx={{
          position: "sticky",
          top: 0,
          zIndex: 2,
          bgcolor: "background.paper",
          borderBottom: "1px solid",
          borderColor: "divider",
          px: { xs: 2, md: 3 },
          py: 2,
        }}
      >
        <Stack direction="row" spacing={1.5} justifyContent="space-between" alignItems="flex-start">
          <Box sx={{ minWidth: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
              <Typography variant="h5" sx={{ fontWeight: 950, letterSpacing: 0 }}>
                {selectedParent.name}
              </Typography>
              <Chip size="small" label={`${parentChildren.length} child categories`} />
              <Chip size="small" label={`${fieldCounts.get(selectedParent._id) || 0} fields`} />
            </Stack>
            <Typography color="text.secondary" sx={{ mt: 0.75 }}>
              {selectedParent.description || "No description yet."}
            </Typography>
          </Box>
          <IconButton onClick={() => setParentDrawerOpen(false)} aria-label="Close parent drawer">
            <CloseRoundedIcon />
          </IconButton>
        </Stack>
        <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mt: 2 }}>
          <Button
            variant="contained"
            size="small"
            startIcon={<AddRoundedIcon />}
            onClick={() =>
              setEditDialog({
                open: true,
                kind: "category",
                name: "",
                description: "",
                parentCategoryId: selectedParent._id,
              })
            }
          >
            New Child Category
          </Button>
          <Button
            variant="outlined"
            size="small"
            startIcon={<EditRoundedIcon />}
            onClick={() =>
              setEditDialog({
                open: true,
                kind: "parent",
                id: selectedParent._id,
                name: selectedParent.name,
                description: selectedParent.description || "",
              })
            }
          >
            Edit Parent
          </Button>
          <Button
            color="error"
            variant="outlined"
            size="small"
            startIcon={<DeleteOutlineRoundedIcon />}
            onClick={deleteSelectedParent}
          >
            Delete Parent
          </Button>
        </Stack>
      </Box>

      <Box sx={{ flex: 1, overflow: "auto", p: { xs: 2, md: 3 } }}>
        {parentChildren.length === 0 ? (
          <Paper
            variant="outlined"
            sx={{ p: 3, borderStyle: "dashed", borderRadius: "8px", textAlign: "center" }}
          >
            <Typography sx={{ fontWeight: 900 }}>No child categories yet</Typography>
            <Typography color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
              Add the first child category, then manage its ordered field list.
            </Typography>
            <Button
              variant="contained"
              startIcon={<AddRoundedIcon />}
              onClick={() =>
                setEditDialog({
                  open: true,
                  kind: "category",
                  name: "",
                  description: "",
                  parentCategoryId: selectedParent._id,
                })
              }
            >
              Add Child Category
            </Button>
          </Paper>
        ) : (
          <Stack spacing={1.5}>
            {parentChildren.map((category) => (
              <CategoryCard key={category._id} category={category} onClick={() => openCategory(category._id)} />
            ))}
          </Stack>
        )}
      </Box>
    </Box>
  ) : null;

  const categoryDrawer = selectedCategory ? (
    <Box sx={{ height: "100%", display: "flex", flexDirection: "column", bgcolor: "background.default" }}>
      <Box
        sx={{
          position: "sticky",
          top: 0,
          zIndex: 2,
          bgcolor: "background.paper",
          borderBottom: "1px solid",
          borderColor: "divider",
          px: { xs: 2, md: 3 },
          py: 2,
        }}
      >
        <Stack direction="row" spacing={1.5} alignItems="flex-start" justifyContent="space-between">
          <Box sx={{ minWidth: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
              <Typography variant="h5" sx={{ fontWeight: 950, letterSpacing: 0 }}>
                {selectedCategory.name}
              </Typography>
              <Chip size="small" label={`${selectedCategory.fields.length} fields`} />
              <Chip
                size="small"
                variant="outlined"
                label={
                  parents.find((parent) => parent._id === selectedCategory.parentCategoryId)?.name ||
                  "Unassigned"
                }
              />
            </Stack>
            <Typography color="text.secondary" sx={{ mt: 0.75 }}>
              {selectedCategory.description || "No description yet."}
            </Typography>
          </Box>
          <IconButton onClick={() => setCategoryDrawerOpen(false)} aria-label="Close child category drawer">
            <CloseRoundedIcon />
          </IconButton>
        </Stack>
        <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mt: 2 }}>
          <Button
            variant="outlined"
            size="small"
            startIcon={<EditRoundedIcon />}
            onClick={() =>
              setEditDialog({
                open: true,
                kind: "category",
                id: selectedCategory._id,
                name: selectedCategory.name,
                description: selectedCategory.description || "",
                parentCategoryId: selectedCategory.parentCategoryId || "",
              })
            }
          >
            Edit Child Category
          </Button>
          <Button
            color="error"
            variant="outlined"
            size="small"
            startIcon={<DeleteOutlineRoundedIcon />}
            onClick={deleteSelectedCategory}
          >
            Delete
          </Button>
        </Stack>
      </Box>

      <Box sx={{ flex: 1, overflow: "auto", p: { xs: 2, md: 3 } }}>
        <Paper variant="outlined" sx={{ borderRadius: "8px", overflow: "hidden" }}>
          <Box sx={{ p: 2 }}>
            <Typography variant="h6" sx={{ fontWeight: 900, mb: 1 }}>
              Ordered Fields
            </Typography>
            <Stack direction={{ xs: "column", md: "row" }} spacing={1.25} alignItems={{ md: "flex-start" }}>
              <TextField
                fullWidth
                size="small"
                label="Add field name"
                value={newFieldName}
                onChange={(event) => setNewFieldName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") addField();
                }}
              />
              <TextField
                select
                size="small"
                label="Type"
                value={newFieldType}
                onChange={(event) => setNewFieldType(normalizeFieldType(event.target.value))}
                sx={{ minWidth: { md: 132 } }}
              >
                <MenuItem value="text">Text</MenuItem>
                <MenuItem value="number">Number</MenuItem>
                <MenuItem value="select">Select</MenuItem>
                <MenuItem value="checkbox">Checkbox</MenuItem>
              </TextField>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={newFieldRequired}
                    onChange={(event) => setNewFieldRequired(event.target.checked)}
                  />
                }
                label="Required"
                sx={{ minWidth: { md: 118 } }}
              />
              {(newFieldType === "select" || newFieldType === "checkbox") && (
                <TextField
                  fullWidth
                  size="small"
                  label={newFieldType === "checkbox" ? "Checkbox values" : "Select values"}
                  placeholder="Option 1, Option 2, Option 3"
                  value={newFieldOptions}
                  onChange={(event) => setNewFieldOptions(event.target.value)}
                  helperText="Use /, comma, or line breaks"
                />
              )}
              <Button variant="contained" startIcon={<AddRoundedIcon />} onClick={addField} disabled={busy}>
                Add
              </Button>
            </Stack>
          </Box>
          <Divider />
          <Box sx={{ overflowX: "auto" }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell width={70}>#</TableCell>
                  <TableCell>Field Name</TableCell>
                  <TableCell width={150}>Type</TableCell>
                  <TableCell width={120}>Required</TableCell>
                  <TableCell>Values</TableCell>
                  <TableCell width={176} align="right">
                    Actions
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {selectedCategory.fields.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} sx={{ color: "text.secondary", py: 3 }}>
                      Add fields manually or extract them from a PDF/image.
                    </TableCell>
                  </TableRow>
                ) : (
                  selectedCategory.fields.map((field, index) => {
                    const draft = fieldDrafts[field._id] ?? field.name;
                    const typeDraft = normalizeFieldType(fieldTypeDrafts[field._id] || field.type);
                    const optionsDraft = fieldOptionsDrafts[field._id] ?? optionsToDraft(field.options);
                    const requiredDraft = Boolean(fieldRequiredDrafts[field._id]);
                    const changed =
                      draft.trim() !== field.name ||
                      typeDraft !== normalizeFieldType(field.type) ||
                      requiredDraft !== Boolean(field.required) ||
                      optionsToDraft(parseOptions(optionsDraft)) !== optionsToDraft(field.options);
                    return (
                      <TableRow key={field._id} hover>
                        <TableCell>
                          <Chip size="small" label={field.order} sx={{ fontWeight: 800 }} />
                        </TableCell>
                        <TableCell>
                          <TextField
                            fullWidth
                            size="small"
                            value={draft}
                            onChange={(event) =>
                              setFieldDrafts((current) => ({ ...current, [field._id]: event.target.value }))
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <TextField
                            select
                            fullWidth
                            size="small"
                            value={typeDraft}
                            onChange={(event) => {
                              const nextType = normalizeFieldType(event.target.value);
                              setFieldTypeDrafts((current) => ({ ...current, [field._id]: nextType }));
                              if (nextType !== "select" && nextType !== "checkbox") {
                                setFieldOptionsDrafts((current) => ({ ...current, [field._id]: "" }));
                              }
                            }}
                          >
                            <MenuItem value="text">Text</MenuItem>
                            <MenuItem value="number">Number</MenuItem>
                            <MenuItem value="select">Select</MenuItem>
                            <MenuItem value="checkbox">Checkbox</MenuItem>
                          </TextField>
                        </TableCell>
                        <TableCell>
                          <TextField
                            select
                            fullWidth
                            size="small"
                            value={requiredDraft ? "yes" : "no"}
                            onChange={(event) =>
                              setFieldRequiredDrafts((current) => ({
                                ...current,
                                [field._id]: event.target.value === "yes",
                              }))
                            }
                          >
                            <MenuItem value="no">No</MenuItem>
                            <MenuItem value="yes">Yes</MenuItem>
                          </TextField>
                        </TableCell>
                        <TableCell>
                          <TextField
                            fullWidth
                            size="small"
                            value={typeDraft === "select" || typeDraft === "checkbox" ? optionsDraft : ""}
                            placeholder={typeDraft === "select" || typeDraft === "checkbox" ? "Red / Blue / Green / Black" : "Not used"}
                            disabled={typeDraft !== "select" && typeDraft !== "checkbox"}
                            onChange={(event) =>
                              setFieldOptionsDrafts((current) => ({
                                ...current,
                                [field._id]: event.target.value,
                              }))
                            }
                            helperText={
                              typeDraft === "select"
                                ? "Software will choose one value"
                                : typeDraft === "checkbox"
                                  ? "One or more checkbox values"
                                  : " "
                            }
                          />
                        </TableCell>
                        <TableCell align="right">
                          <Tooltip title="Move up">
                            <span>
                              <IconButton size="small" disabled={index === 0 || busy} onClick={() => reorderFields(index, index - 1)}>
                                <ArrowUpwardRoundedIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                          <Tooltip title="Move down">
                            <span>
                              <IconButton
                                size="small"
                                disabled={index === selectedCategory.fields.length - 1 || busy}
                                onClick={() => reorderFields(index, index + 1)}
                              >
                                <ArrowDownwardRoundedIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                          <Tooltip title="Save field">
                            <span>
                              <IconButton size="small" disabled={!changed || busy} onClick={() => updateField(field)}>
                                <SaveRoundedIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                          <Tooltip title="Delete field">
                            <span>
                              <IconButton size="small" color="error" disabled={busy} onClick={() => deleteField(field)}>
                                <DeleteOutlineRoundedIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </Box>
        </Paper>

        <Paper variant="outlined" sx={{ mt: 2, borderRadius: "8px", overflow: "hidden" }}>
          <Box sx={{ p: 2 }}>
            <Typography variant="h6" sx={{ fontWeight: 900, mb: 0.5 }}>
              Extract Fields From PDF/Image
            </Typography>
            <Typography color="text.secondary" sx={{ mb: 2 }}>
              Upload a source document and review the ordered field names before saving.
            </Typography>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1.25} alignItems={{ sm: "center" }}>
              <Button variant="outlined" component="label" startIcon={<UploadFileRoundedIcon />}>
                Choose file
                <input
                  hidden
                  type="file"
                  accept="application/pdf,image/*"
                  onChange={(event) => {
                    setExtractFile(event.target.files?.[0] || null);
                    setExtractedFields([]);
                    setExtractionNotes("");
                  }}
                />
              </Button>
              <Typography color="text.secondary" sx={{ flex: 1 }}>
                {extractFile ? extractFile.name : "PDF or image, used only for field extraction."}
              </Typography>
              <Button variant="contained" disabled={!extractFile || extracting} onClick={extractFields}>
                {extracting ? "Extracting..." : "Extract"}
              </Button>
            </Stack>
            {extractionNotes && (
              <Alert severity="info" sx={{ mt: 2 }}>
                {extractionNotes}
              </Alert>
            )}
            {extractedFields.length > 0 && (
              <Paper variant="outlined" sx={{ mt: 2, borderRadius: "8px", overflow: "hidden" }}>
                <Box sx={{ p: 2 }}>
                  <Stack
                    direction={{ xs: "column", sm: "row" }}
                    spacing={1}
                    alignItems={{ xs: "stretch", sm: "center" }}
                    justifyContent="space-between"
                  >
                    <Box>
                      <Typography sx={{ fontWeight: 900 }}>Proposed ordered fields</Typography>
                      <Typography color="text.secondary" variant="body2">
                        Existing duplicates are flagged and skipped when appended.
                      </Typography>
                    </Box>
                    <Stack direction="row" spacing={1}>
                      <Button onClick={() => saveExtracted("append")} disabled={busy}>
                        Append
                      </Button>
                      <Button variant="contained" color="warning" onClick={() => saveExtracted("replace")} disabled={busy}>
                        Replace
                      </Button>
                      <Button
                        onClick={() => {
                          setExtractedFields([]);
                          setExtractionNotes("");
                        }}
                      >
                        Cancel
                      </Button>
                    </Stack>
                  </Stack>
                </Box>
                <Divider />
                <Box sx={{ maxHeight: 320, overflow: "auto" }}>
                  {extractedFields.map((field) => (
                    <Stack
                      key={`${field.order}-${field.name}`}
                      direction="row"
                      spacing={1.5}
                      alignItems="center"
                      sx={{ px: 2, py: 1, borderBottom: "1px solid", borderColor: "divider" }}
                    >
                      <Chip size="small" label={field.order} />
                      <Typography sx={{ flex: 1 }}>{field.name}</Typography>
                      {existingFieldKeys.has(normalizeFieldName(field.name)) && (
                        <Chip size="small" color="warning" label="duplicate" />
                      )}
                    </Stack>
                  ))}
                </Box>
              </Paper>
            )}
          </Box>
        </Paper>
      </Box>
    </Box>
  ) : null;

  return (
    <Box
      sx={{
        minHeight: "100%",
        p: { xs: 2, md: 3 },
        bgcolor: (theme) => (theme.palette.mode === "dark" ? "background.default" : "#eef4ff"),
      }}
    >
      <Stack
        direction={{ xs: "column", lg: "row" }}
        spacing={2}
        justifyContent="space-between"
        alignItems={{ xs: "stretch", lg: "flex-start" }}
        sx={{ mb: 3 }}
      >
        <Box>
          <Typography variant="h3" sx={{ fontWeight: 950, letterSpacing: 0, lineHeight: 1 }}>
            CR Management
          </Typography>
          <Typography color="text.secondary" sx={{ mt: 1, fontSize: "1rem" }}>
            Manage CR parent categories, child categories, and ordered field lists.
          </Typography>
        </Box>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ sm: "center" }}>
          <Button variant="outlined" startIcon={<RefreshRoundedIcon />} onClick={loadSpecSheet} disabled={loading}>
            Refresh
          </Button>
          <Button
            variant="outlined"
            startIcon={<UploadFileRoundedIcon />}
            onClick={() => {
              setImportDialogOpen(true);
              setImportFile(null);
              setImportPreview(null);
              setImportConfirmed(false);
            }}
          >
            Import Excel
          </Button>
          <Button
            variant="outlined"
            onClick={() => window.open("/api/admin/spec-sheet/registry-json", "_blank", "noopener,noreferrer")}
          >
            Registry JSON
          </Button>
          <Button
            variant="contained"
            startIcon={<AddRoundedIcon />}
            onClick={() => setEditDialog({ open: true, kind: "parent", name: "", description: "" })}
            sx={{ boxShadow: "0 14px 28px rgba(79,70,229,0.22)" }}
          >
            New Parent Category
          </Button>
        </Stack>
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError("")}>
          {error}
        </Alert>
      )}
      {success && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setSuccess("")}>
          {success}
        </Alert>
      )}

      <Paper
        variant="outlined"
        sx={{
          borderRadius: "8px",
          borderColor: "rgba(148,163,184,0.28)",
          bgcolor: "background.paper",
          p: { xs: 2, md: 2.5 },
          mb: 2.5,
          boxShadow: "0 18px 45px rgba(37,99,235,0.08)",
        }}
      >
        <Stack
          direction={{ xs: "column", md: "row" }}
          spacing={1.5}
          alignItems={{ xs: "stretch", md: "center" }}
          justifyContent="space-between"
        >
          <TextField
            size="small"
            placeholder="Search parents or unassigned child categories"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            sx={{ maxWidth: { md: 520 } }}
            fullWidth
            InputProps={{
              startAdornment: (
                <InputAdornment position="start">
                  <SearchRoundedIcon fontSize="small" />
                </InputAdornment>
              ),
            }}
          />
          <Stack direction="row" spacing={1} flexWrap="wrap">
            <Chip label={`${parents.length} parents`} />
            <Chip label={`${categories.length} child categories`} />
            <Chip label={`${totalFields} fields`} />
          </Stack>
        </Stack>
      </Paper>

      {loading ? (
        <Stack alignItems="center" sx={{ py: 8 }}>
          <CircularProgress />
        </Stack>
      ) : (
        <Stack spacing={3}>
          <Box>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
              <FolderRoundedIcon color="primary" />
              <Typography variant="h5" sx={{ fontWeight: 950 }}>
                Parent Categories
              </Typography>
            </Stack>
            {filteredParents.length === 0 ? (
              <EmptyPanel
                title={parents.length === 0 ? "No parent categories yet" : "No parent categories match your search"}
                body="Create parent categories, then add child categories and field names inside them."
                actionLabel="Create Parent Category"
                onAction={() => setEditDialog({ open: true, kind: "parent", name: "", description: "" })}
              />
            ) : (
              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: {
                    xs: "1fr",
                    sm: "repeat(2, minmax(0, 1fr))",
                    xl: "repeat(3, minmax(0, 1fr))",
                  },
                  gap: 2,
                }}
              >
                {filteredParents.map((parent) => (
                  <ParentCard
                    key={parent._id}
                    parent={parent}
                    childCount={childCounts.get(parent._id) || 0}
                    fieldCount={fieldCounts.get(parent._id) || 0}
                    onClick={() => openParent(parent._id)}
                  />
                ))}
              </Box>
            )}
          </Box>

          <Box>
            <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" sx={{ mb: 1.5 }}>
              <Box>
                <Typography variant="h5" sx={{ fontWeight: 950 }}>
                  Unassigned Categories
                </Typography>
                <Typography color="text.secondary">
                  Existing child categories remain here until an admin assigns a parent.
                </Typography>
              </Box>
              <Button
                variant="outlined"
                startIcon={<AddRoundedIcon />}
                onClick={() =>
                  setEditDialog({
                    open: true,
                    kind: "category",
                    name: "",
                    description: "",
                    parentCategoryId: "",
                  })
                }
              >
                New Unassigned Child
              </Button>
            </Stack>
            {unassignedCategories.length === 0 ? (
              <Paper
                variant="outlined"
                sx={{ p: 2.5, borderRadius: "8px", borderStyle: "dashed", color: "text.secondary" }}
              >
                No unassigned child categories.
              </Paper>
            ) : (
              <Stack spacing={1.5}>
                {unassignedCategories.map((category) => (
                  <CategoryCard key={category._id} category={category} onClick={() => openCategory(category._id)} />
                ))}
              </Stack>
            )}
          </Box>
        </Stack>
      )}

      <Drawer
        anchor="right"
        open={parentDrawerOpen && Boolean(selectedParent)}
        onClose={() => setParentDrawerOpen(false)}
        PaperProps={{
          sx: {
            width: { xs: "100%", md: 720, xl: 820 },
            maxWidth: "100%",
            borderTopLeftRadius: { xs: 0, md: "8px" },
            borderBottomLeftRadius: { xs: 0, md: "8px" },
            overflow: "hidden",
          },
        }}
      >
        {parentDrawer}
      </Drawer>

      <Drawer
        anchor="right"
        open={categoryDrawerOpen && Boolean(selectedCategory)}
        onClose={() => setCategoryDrawerOpen(false)}
        PaperProps={{
          sx: {
            width: { xs: "100%", md: 780, xl: 920 },
            maxWidth: "100%",
            borderTopLeftRadius: { xs: 0, md: "8px" },
            borderBottomLeftRadius: { xs: 0, md: "8px" },
            overflow: "hidden",
          },
        }}
      >
        {categoryDrawer}
      </Drawer>

      <Dialog
        open={importDialogOpen}
        onClose={() => {
          if (importingWorkbook) return;
          setImportDialogOpen(false);
        }}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>Import CR Management Excel</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Alert severity="warning">
              This replaces the database CR Management registry with the uploaded workbook. Asset and Lot Listing generation still uses the generated v2 file registry until the future DB runtime switch.
            </Alert>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={1.25} alignItems={{ sm: "center" }}>
              <Button variant="outlined" component="label" startIcon={<UploadFileRoundedIcon />}>
                Choose Excel
                <input
                  hidden
                  type="file"
                  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onChange={(event) => {
                    setImportFile(event.target.files?.[0] || null);
                    setImportPreview(null);
                    setImportConfirmed(false);
                  }}
                />
              </Button>
              <Typography color="text.secondary" sx={{ flex: 1 }}>
                {importFile ? importFile.name : "Upload McDougall_Child_Category_Specifications_Reordered_v2.xlsx"}
              </Typography>
              <Button variant="contained" disabled={!importFile || importingWorkbook} onClick={previewWorkbookImport}>
                {importingWorkbook && !importPreview ? "Parsing..." : "Preview"}
              </Button>
            </Stack>

            {importPreview && (
              <Paper variant="outlined" sx={{ borderRadius: "8px", overflow: "hidden" }}>
                <Box sx={{ p: 2 }}>
                  <Typography variant="h6" sx={{ fontWeight: 900 }}>
                    Import Summary
                  </Typography>
                  <GridSummary
                    items={[
                      { label: "Parents", value: importPreview.stats.parentCount },
                      { label: "Child categories", value: importPreview.stats.childCount },
                      { label: "Fields", value: importPreview.stats.fieldCount },
                      { label: "Duplicates skipped", value: importPreview.stats.duplicateFieldCount },
                    ]}
                  />
                  {importPreview.warnings.length > 0 && (
                    <Alert severity="info" sx={{ mt: 2 }}>
                      <Typography sx={{ fontWeight: 800 }}>Warnings</Typography>
                      <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2, maxHeight: 150, overflow: "auto" }}>
                        {importPreview.warnings.slice(0, 20).map((warning, index) => (
                          <Typography component="li" variant="caption" key={`${warning}-${index}`}>
                            {warning}
                          </Typography>
                        ))}
                        {importPreview.warnings.length > 20 && (
                          <Typography component="li" variant="caption">
                            +{importPreview.warnings.length - 20} more
                          </Typography>
                        )}
                      </Box>
                    </Alert>
                  )}
                  <FormControlLabel
                    sx={{ mt: 1.5 }}
                    control={
                      <Checkbox
                        checked={importConfirmed}
                        onChange={(event) => setImportConfirmed(event.target.checked)}
                      />
                    }
                    label="I understand this will replace the CR Management database registry"
                  />
                </Box>
              </Paper>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button
            onClick={() => {
              setImportDialogOpen(false);
              setImportFile(null);
              setImportPreview(null);
              setImportConfirmed(false);
            }}
            disabled={importingWorkbook}
          >
            Cancel
          </Button>
          <Button
            variant="contained"
            color="warning"
            disabled={!importPreview || !importConfirmed || importingWorkbook}
            onClick={replaceRegistryFromWorkbook}
          >
            {importingWorkbook && importPreview ? "Importing..." : "Replace Registry"}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={editDialog.open}
        onClose={() => setEditDialog({ open: false, name: "", description: "" })}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>
          {editDialog.kind === "parent"
            ? editDialog.id
              ? "Edit Parent Category"
              : "New Parent Category"
            : editDialog.id
              ? "Edit Child Category"
              : "New Child Category"}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField
              label={editDialog.kind === "parent" ? "Parent category name" : "Child category name"}
              value={editDialog.name}
              onChange={(event) => setEditDialog((current) => ({ ...current, name: event.target.value }))}
              autoFocus
              fullWidth
            />
            {editDialog.kind === "category" && (
              <TextField
                select
                label="Parent category"
                value={editDialog.parentCategoryId || ""}
                onChange={(event) =>
                  setEditDialog((current) => ({ ...current, parentCategoryId: event.target.value }))
                }
                fullWidth
              >
                <MenuItem value="">Unassigned</MenuItem>
                {parents.map((parent) => (
                  <MenuItem key={parent._id} value={parent._id}>
                    {parent.name}
                  </MenuItem>
                ))}
              </TextField>
            )}
            <TextField
              label="Description"
              value={editDialog.description}
              onChange={(event) =>
                setEditDialog((current) => ({ ...current, description: event.target.value }))
              }
              minRows={3}
              multiline
              fullWidth
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditDialog({ open: false, name: "", description: "" })}>
            Cancel
          </Button>
          <Button variant="contained" disabled={busy} onClick={saveEditDialog}>
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

function ParentCard({
  parent,
  childCount,
  fieldCount,
  onClick,
}: {
  parent: SpecParentCategory;
  childCount: number;
  fieldCount: number;
  onClick: () => void;
}) {
  return (
    <Paper
      component={ButtonBase}
      onClick={onClick}
      variant="outlined"
      sx={{
        display: "block",
        textAlign: "left",
        borderRadius: "8px",
        borderColor: "rgba(148,163,184,0.28)",
        bgcolor: "background.paper",
        overflow: "hidden",
        transition: "transform 140ms ease, box-shadow 140ms ease, border-color 140ms ease",
        "&:hover": {
          transform: "translateY(-2px)",
          borderColor: "primary.main",
          boxShadow: "0 20px 48px rgba(37,99,235,0.12)",
        },
      }}
    >
      <Box sx={{ p: 2.25 }}>
        <Stack direction="row" spacing={1.5} alignItems="flex-start">
          <Box
            sx={{
              width: 48,
              height: 48,
              borderRadius: "8px",
              display: "grid",
              placeItems: "center",
              bgcolor: "primary.main",
              color: "primary.contrastText",
              fontWeight: 900,
              flexShrink: 0,
            }}
          >
            {initials(parent.name)}
          </Box>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="h6" sx={{ fontWeight: 950, lineHeight: 1.15 }}>
              {parent.name}
            </Typography>
            <Typography
              color="text.secondary"
              sx={{
                mt: 0.75,
                minHeight: 44,
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {parent.description || "No description added yet."}
            </Typography>
          </Box>
        </Stack>
      </Box>
      <Divider />
      <Stack direction="row" spacing={1} alignItems="center" justifyContent="space-between" sx={{ px: 2.25, py: 1.5 }}>
        <Stack direction="row" spacing={1}>
          <Chip size="small" label={`${childCount} children`} sx={{ fontWeight: 700 }} />
          <Chip size="small" label={`${fieldCount} fields`} sx={{ fontWeight: 700 }} />
        </Stack>
        <Typography variant="caption" color="text.secondary">
          Updated {formatUpdatedAt(parent.updatedAt)}
        </Typography>
      </Stack>
    </Paper>
  );
}

function GridSummary({ items }: { items: Array<{ label: string; value: number | string }> }) {
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: { xs: "repeat(2, minmax(0, 1fr))", md: "repeat(4, minmax(0, 1fr))" },
        gap: 1,
        mt: 1.5,
      }}
    >
      {items.map((item) => (
        <Paper key={item.label} variant="outlined" sx={{ p: 1.25, borderRadius: "8px" }}>
          <Typography variant="caption" color="text.secondary">
            {item.label}
          </Typography>
          <Typography variant="h6" sx={{ fontWeight: 900 }}>
            {item.value}
          </Typography>
        </Paper>
      ))}
    </Box>
  );
}

function CategoryCard({ category, onClick }: { category: SpecCategory; onClick: () => void }) {
  return (
    <Paper
      component={ButtonBase}
      onClick={onClick}
      variant="outlined"
      sx={{
        width: "100%",
        display: "block",
        textAlign: "left",
        borderRadius: "8px",
        borderColor: "rgba(148,163,184,0.32)",
        bgcolor: "background.paper",
        p: 2,
        transition: "border-color 140ms ease, box-shadow 140ms ease",
        "&:hover": {
          borderColor: "primary.main",
          boxShadow: "0 16px 38px rgba(37,99,235,0.1)",
        },
      }}
    >
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.25} alignItems={{ sm: "center" }} justifyContent="space-between">
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontWeight: 950, fontSize: "1.05rem" }}>{category.name}</Typography>
          <Typography color="text.secondary" variant="body2" sx={{ mt: 0.35 }}>
            {category.description || "No description added yet."}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} flexShrink={0}>
          <Chip size="small" label={`${category.fields.length} fields`} />
          <Chip size="small" variant="outlined" label={`Updated ${formatUpdatedAt(category.updatedAt)}`} />
        </Stack>
      </Stack>
    </Paper>
  );
}

function EmptyPanel({
  title,
  body,
  actionLabel,
  onAction,
}: {
  title: string;
  body: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <Paper
      variant="outlined"
      sx={{
        borderRadius: "8px",
        borderStyle: "dashed",
        borderColor: "rgba(99,102,241,0.35)",
        bgcolor: "rgba(255,255,255,0.76)",
        p: { xs: 3, md: 5 },
        textAlign: "center",
      }}
    >
      <Typography variant="h5" sx={{ fontWeight: 900 }}>
        {title}
      </Typography>
      <Typography color="text.secondary" sx={{ mt: 1, mb: 2 }}>
        {body}
      </Typography>
      <Button variant="contained" startIcon={<AddRoundedIcon />} onClick={onAction}>
        {actionLabel}
      </Button>
    </Paper>
  );
}
