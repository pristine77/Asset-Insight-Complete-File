"use client";

import React from "react";
import { createPortal } from "react-dom";
import { previewSpecFieldKey } from "@/lib/previewSpecEdits";

export interface AssetCategorySpec {
  parentCategory: string;
  childCategory: string;
  fields: string[];
}

type Props = {
  lot: any;
  lotIndex: number;
  specsByCategory: Map<string, AssetCategorySpec>;
  onChange: (lotIndex: number, fieldName: string, value: string) => void;
  onAdd?: (lotIndex: number, fieldName: string, value: string) => void;
  onDelete: (lotIndex: number, fieldName: string) => void;
  includeDamageAnalysis?: boolean;
  damageEligible?: boolean;
  damageAnalysis?: string | null;
  onDamageAnalysisChange?: (lotIndex: number, value: string) => void;
  accent?: "rose" | "purple";
};

const normalizeKey = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

const isUsefulValue = (value: unknown) => {
  const text = String(value ?? "").trim();
  if (normalizeVisiblePresenceValue(text)) return true;
  return (
    !!text &&
    !/^(n\/a|na|none|null|unknown|not found|tbd|false|not available|not applicable)$/i.test(text) &&
    !/title clearance clarification fee|applied to your invoice|over and above the purchase price|applicable taxes|following the close of the sale/i.test(text)
  );
};

const normalizeVisiblePresenceValue = (value: unknown) => {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (/^(?:(?:not|no)\s+visible|visible\s*[:=-]?\s*(?:no|false))$/i.test(text)) {
    return "No";
  }
  if (/^visible(?:\s*[:=-]?\s*(?:yes|true))?$/i.test(text)) {
    return "Yes";
  }
  return "";
};

const getSpecRecord = (value: unknown, reviewed = false): Record<string, string> => {
  const out: Record<string, string> = {};
  if (Array.isArray(value)) {
    value.forEach((entry: any) => {
      const field = String(entry?.field ?? "").trim();
      const rawText = String(entry?.value ?? "");
      const text = rawText.trim();
      if (field && (reviewed || entry?.value === "" || (typeof entry?.value === "string" && !text) || isUsefulValue(rawText))) {
        out[field] = rawText;
      }
    });
    return out;
  }
  if (value && typeof value === "object") {
    Object.entries(value as Record<string, unknown>).forEach(([field, raw]) => {
      const rawText = String(raw ?? "");
      const text = rawText.trim();
      if (field && (reviewed || raw === "" || (typeof raw === "string" && !text) || isUsefulValue(rawText))) {
        out[field] = rawText;
      }
    });
  }
  return out;
};

const getValueForField = (record: Record<string, string>, fieldName: string, categoryFields: string[]) => {
  if (record[fieldName] !== undefined) return record[fieldName];
  const key = previewSpecFieldKey(fieldName, categoryFields);
  const matchingKey = Object.keys(record).find((field) => previewSpecFieldKey(field, categoryFields) === key);
  return matchingKey ? record[matchingKey] : "";
};

const isDamageField = (fieldName: string) => {
  const key = normalizeKey(fieldName);
  return key === "damage" || key === "damages" || key === "damageanalysis";
};

const priorityFields = ["Serial Number", "Has Key", "Running Condition", "Ownership Type"];

const isSerialField = (fieldName: string) => {
  const key = normalizeKey(fieldName);
  return key === "serialnumber" || key === "vin" || key === "sn" || key === "serialno" || key === "sno";
};

const cleanDisplayValueForField = (fieldName: string, value: string) => {
  const visibleValue = normalizeVisiblePresenceValue(value);
  if (visibleValue) return visibleValue;
  if (!isSerialField(fieldName)) return value;
  return value.replace(/^(?:vin|sn|s\/n|serial(?:\s*(?:number|no\.?|#))?)\s*[:#-]\s*/i, "").trim();
};

const isOperationalDamageAnalysisFallback = (value: unknown) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return Boolean(
    text &&
      [
        /\bsoftware analysis failed\b/i,
        /\bsoftware did not return details\b/i,
        /\bai analysis failed\b/i,
        /\bopenai.+failed\b/i,
        /\breview and edit before approval\b/i,
      ].some((pattern) => pattern.test(text))
  );
};

const sanitizeDamageAnalysisText = (value: unknown) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text && !isOperationalDamageAnalysisFallback(text) ? text : "";
};

export default function AuctioneerSpecsEditor({
  lot,
  lotIndex,
  specsByCategory,
  onChange,
  onAdd,
  onDelete,
  includeDamageAnalysis = false,
  damageEligible = true,
  damageAnalysis,
  onDamageAnalysisChange,
  accent = "rose",
}: Props) {
  const [expandedEditor, setExpandedEditor] = React.useState<{
    fieldName: string;
    draftFieldName?: string;
    value: string;
    isNew?: boolean;
    isDamage?: boolean;
    error?: string;
    notice?: string;
  } | null>(null);
  const categoryKey = normalizeKey(lot?.categories);
  const categorySpec = specsByCategory.get(categoryKey);
  const reviewed = lot?.condition_report_specs_reviewed === true;
  const specRecord = getSpecRecord(lot?.condition_report_specs, reviewed);
  const fields = categorySpec?.fields?.filter((field) => !isDamageField(field)) || [];
  const orderedFields = [...priorityFields, ...fields].filter((field, index, allFields) => {
    const key = previewSpecFieldKey(field, fields);
    return key && allFields.findIndex((candidate) => previewSpecFieldKey(candidate, fields) === key) === index;
  });
  const deletedSpecKeys = new Set(
    (Array.isArray(lot?.condition_report_specs_deleted)
      ? lot.condition_report_specs_deleted
      : []
    )
      .map((field: unknown) => previewSpecFieldKey(field, fields))
      .filter(Boolean)
  );
  const extraFields = Object.keys(specRecord).filter((field) => {
    if (isDamageField(field)) return false;
    const key = previewSpecFieldKey(field, fields);
    return (
      !deletedSpecKeys.has(key) &&
      !orderedFields.some((knownField) => previewSpecFieldKey(knownField, fields) === key)
    );
  });
  const visibleFields = [
    ...orderedFields.filter((field) => !deletedSpecKeys.has(previewSpecFieldKey(field, fields)) &&
      (!reviewed || Object.keys(specRecord).some(key => previewSpecFieldKey(key, fields) === previewSpecFieldKey(field, fields)))),
    ...extraFields,
  ];
  const accentClasses =
    accent === "purple"
      ? "border-[var(--app-border)] bg-[var(--app-panel-alt)] text-[var(--app-text)]"
      : "border-[var(--app-info-border)] bg-[var(--app-info-soft)] text-[var(--app-text)]";
  const focusClass =
    accent === "purple"
      ? "focus:ring-purple-500"
      : "focus:ring-blue-500";

  const categoryChipText = categorySpec
    ? `${categorySpec.childCategory} - ${fields.length} fields`
    : "Category not matched";
  const lotLabel = String(
    lot?.lot_number || lot?.lot_id || (Number.isFinite(lotIndex) ? lotIndex + 1 : "")
  ).trim();
  const lotTitle = String(lot?.title || lot?.description || "").trim();
  const accentButtonClass =
    accent === "purple"
      ? "bg-purple-600 hover:bg-purple-700 focus:ring-purple-500"
      : "bg-blue-600 hover:bg-blue-700 focus:ring-blue-500";
  const safeDamageAnalysis = sanitizeDamageAnalysisText(damageAnalysis);

  const openExpandedEditor = (fieldName: string) => {
    setExpandedEditor({
      fieldName,
      value: cleanDisplayValueForField(fieldName, getValueForField(specRecord, fieldName, fields)),
    });
  };

  const openAddFieldEditor = () => {
    setExpandedEditor({
      fieldName: "",
      draftFieldName: "",
      value: "",
      isNew: true,
    });
  };

  const closeExpandedEditor = () => {
    setExpandedEditor(null);
  };

  const openDamageEditor = (value = safeDamageAnalysis, notice?: string) => {
    setExpandedEditor({
      fieldName: "Damages",
      value,
      isDamage: true,
      notice,
    });
  };

  const saveExpandedEditor = () => {
    if (!expandedEditor) return;
    if (expandedEditor.isDamage) {
      onDamageAnalysisChange?.(lotIndex, expandedEditor.value);
      closeExpandedEditor();
      return;
    }
    if (expandedEditor.isNew) {
      const fieldName = String(expandedEditor.draftFieldName || "").trim();
      const value = String(expandedEditor.value || "").trim();
      if (!fieldName) {
        setExpandedEditor((prev) =>
          prev ? { ...prev, error: "Field name is required." } : prev
        );
        return;
      }
      if (isDamageField(fieldName) && !damageEligible) {
        setExpandedEditor((prev) =>
          prev
            ? {
                ...prev,
                error: "Damage Analysis is unavailable for lot numbers above 1000.",
              }
            : prev
        );
        return;
      }
      if (isDamageField(fieldName) && onDamageAnalysisChange) {
        openDamageEditor(
          expandedEditor.value,
          "Damage notes are saved in the Damages section."
        );
        return;
      }
      if (!value) {
        setExpandedEditor((prev) =>
          prev ? { ...prev, error: "Field value is required." } : prev
        );
        return;
      }
      const existingField = visibleFields.find(
        (field) => normalizeKey(field) === normalizeKey(fieldName)
      );
      if (existingField) {
        setExpandedEditor({
          fieldName: existingField,
          value: getValueForField(specRecord, existingField, fields),
          error: "This field already exists. Edit the existing value.",
        });
        return;
      }
      (onAdd || onChange)(lotIndex, fieldName, expandedEditor.value);
      closeExpandedEditor();
      return;
    }
    onChange(lotIndex, expandedEditor.fieldName, expandedEditor.value);
    closeExpandedEditor();
  };

  const deleteExpandedField = () => {
    if (!expandedEditor) return;
    if (expandedEditor.isDamage) {
      onDamageAnalysisChange?.(lotIndex, "");
      closeExpandedEditor();
      return;
    }
    onDelete(lotIndex, expandedEditor.fieldName);
    closeExpandedEditor();
  };

  const expandedEditorPortal =
    expandedEditor && typeof document !== "undefined"
      ? createPortal(
          <div
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-[var(--app-overlay)] px-4 py-6"
            role="dialog"
            aria-modal="true"
            aria-labelledby="auctioneer-spec-expanded-title"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeExpandedEditor();
            }}
          >
            <div className="flex max-h-[86vh] w-full max-w-xl flex-col overflow-hidden rounded-lg bg-[var(--app-panel)] shadow-sm ring-1 ">
              <div className="flex items-start justify-between gap-4 border-b border-[var(--app-border)] bg-[var(--app-panel-alt)] px-5 py-4">
                <div className="min-w-0">
                  <p
                    id="auctioneer-spec-expanded-title"
                    className="text-sm font-black uppercase tracking-wide text-[var(--app-text-strong)]"
                  >
                    {expandedEditor.isNew ? "ADD CONDITION REPORT FIELD" : expandedEditor.fieldName}
                  </p>
                  <p className="mt-1 truncate text-xs text-[var(--app-text-muted)]">
                    {[
                      lotLabel ? `Lot ${lotLabel}` : "",
                      lotTitle,
                    ].filter(Boolean).join(" - ") || "Condition report field"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={closeExpandedEditor}
                  className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-full border border-[var(--app-border)] bg-[var(--app-panel)] text-lg font-bold leading-none text-[var(--app-text-muted)] transition hover:bg-[var(--app-panel-alt)] hover:text-[var(--app-text)]"
                  aria-label="Close editor"
                >
                  x
                </button>
              </div>
              <div className="min-h-0 flex-1 px-5 py-4">
                {expandedEditor.isNew && (
                  <div className="mb-3">
                    <label className="mb-1 block text-xs font-bold uppercase tracking-wide text-[var(--app-text-muted)]">
                      Field name
                    </label>
                    <input
                      value={expandedEditor.draftFieldName || ""}
                      onChange={(event) =>
                        setExpandedEditor((prev) =>
                          prev ? { ...prev, draftFieldName: event.target.value, error: undefined, notice: undefined } : prev
                        )
                      }
                      className={`w-full rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-2 text-sm text-[var(--app-text)] outline-none transition focus:border-transparent focus:ring-2 ${focusClass}`}
                      placeholder="Example: Engine Hours"
                      autoFocus
                    />
                  </div>
                )}
                <textarea
                  value={expandedEditor.value}
                  onChange={(event) =>
                    setExpandedEditor((prev) =>
                      prev ? { ...prev, value: event.target.value, error: undefined, notice: undefined } : prev
                    )
                  }
                  className={`max-h-[44vh] min-h-[180px] w-full resize-y rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-3 text-sm leading-6 text-[var(--app-text)] outline-none transition focus:border-transparent focus:ring-2 ${focusClass}`}
                  placeholder="Edit the full field value"
                  autoFocus={!expandedEditor.isNew}
                />
                {expandedEditor.error && (
                  <p className="mt-2 text-xs font-semibold text-red-600">
                    {expandedEditor.error}
                  </p>
                )}
                {expandedEditor.notice && (
                  <p className="mt-2 rounded-lg border border-[var(--app-warning-border)] bg-[var(--app-warning-soft)] px-3 py-2 text-xs font-semibold text-[var(--app-warning)]">
                    {expandedEditor.notice}
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-2 border-t border-[var(--app-border)] bg-[var(--app-panel)] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <button
                  type="button"
                  onClick={expandedEditor.isNew ? closeExpandedEditor : deleteExpandedField}
                  className="rounded-lg border border-[var(--app-danger-border)] bg-[var(--app-danger-soft)] px-4 py-2 text-sm font-bold text-[var(--app-danger)] transition hover:border-[var(--app-danger)]"
                >
                  {expandedEditor.isNew
                    ? "Cancel add"
                    : expandedEditor.isDamage
                      ? "Clear damage"
                      : "Delete field"}
                </button>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    onClick={closeExpandedEditor}
                    className="rounded-lg border border-[var(--app-border)] bg-[var(--app-panel)] px-4 py-2 text-sm font-bold text-[var(--app-text-muted)] transition hover:bg-[var(--app-panel-alt)]"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={saveExpandedEditor}
                    className={`rounded-lg px-4 py-2 text-sm font-bold text-white shadow-sm transition focus:outline-none focus:ring-2 focus:ring-offset-2 ${accentButtonClass}`}
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <div className={`rounded-lg border p-3 ${accentClasses}`}>
        <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-black uppercase tracking-wide">
              CONDITION REPORT
            </p>
            <p className="mt-0.5 text-[11px] text-[var(--app-text-muted)]">
              {categorySpec
                ? `Category fields for ${categorySpec.childCategory}`
                : lot?.categories
                  ? "No matching category field list found"
                : "Select a category to show field names"}
            </p>
          </div>
          <span
            className={`w-fit rounded-full bg-[var(--app-panel)] px-2.5 py-1 text-[11px] font-semibold ring-1 ${
              categorySpec
                ? "text-[var(--app-text)] "
                : "text-[var(--app-warning)] ring-[var(--app-warning-border)]"
            }`}
          >
            {categoryChipText}
          </span>
        </div>

        <div className="mb-3">
          <button
            type="button"
            onClick={openAddFieldEditor}
            className="rounded-lg border border-dashed border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-1.5 text-xs font-bold text-[var(--app-text-muted)] transition hover:border-[var(--app-control-border)] hover:bg-[var(--app-panel-alt)]"
          >
            + Add field
          </button>
        </div>

        {!damageEligible ? (
          <div
            className="mb-3 rounded-lg border border-[var(--app-warning-border)] bg-[var(--app-warning-soft)] px-3 py-3 text-[var(--app-text)]"
            role="note"
          >
            <p className="text-xs font-black uppercase tracking-wide">
              Damage Analysis not required
            </p>
            <p className="mt-1 text-[11px] font-medium leading-5">
              This lot is above 1000, so Damage Analysis is excluded from the report and generated files.
            </p>
          </div>
        ) : includeDamageAnalysis && onDamageAnalysisChange ? (
          <div className="mb-3 rounded-lg border border-[var(--app-danger-border)] bg-[var(--app-danger-soft)] p-3 text-[var(--app-text)]">
            <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-black uppercase tracking-wide text-red-700">
                  Damages
                </p>
                <p className="mt-0.5 text-[11px] font-medium text-[var(--app-text-muted)]">
                  Manual damage notes for the CR damages section.
                </p>
              </div>
              <button
                type="button"
                onClick={() => openDamageEditor()}
                className="w-fit rounded-lg border border-[var(--app-danger-border)] bg-[var(--app-danger-soft)] px-3 py-1.5 text-xs font-bold text-[var(--app-danger)] transition hover:border-[var(--app-danger)]"
              >
                Edit damage
              </button>
            </div>
            <button
              type="button"
              onClick={() => openDamageEditor()}
              className={`min-h-10 w-full rounded-md border border-[var(--app-danger-border)] bg-[var(--app-danger-soft)] px-2.5 py-2 text-left text-xs text-[var(--app-text)] outline-none transition hover:border-[var(--app-danger)] focus:border-transparent focus:ring-2 ${focusClass}`}
              title="Click to open large damage editor"
            >
              <span className="block whitespace-pre-wrap break-words">
                {safeDamageAnalysis || "No manual damage notes yet."}
              </span>
            </button>
          </div>
        ) : null}

        {visibleFields.length > 0 ? (
          <div className="max-h-[360px] overflow-y-auto pr-1">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {visibleFields.map((fieldName) => (
                <div key={fieldName} className="block">
                  <div className="mb-1 flex items-center justify-between gap-2 text-[11px] font-medium text-[var(--app-text-muted)]">
                    <span className="min-w-0 break-words">{fieldName}</span>
                    <button
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onDelete(lotIndex, fieldName);
                      }}
                      className="grid h-6 w-6 flex-shrink-0 place-items-center rounded-full border border-[var(--app-danger-border)] bg-[var(--app-danger-soft)] text-sm font-bold leading-none text-[var(--app-danger)] transition hover:brightness-95"
                      aria-label={`Remove ${fieldName}`}
                    >
                      x
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => openExpandedEditor(fieldName)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openExpandedEditor(fieldName);
                      }
                    }}
                    className={`min-h-9 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] px-2.5 py-1.5 text-left text-xs text-[var(--app-text)] outline-none transition hover:border-[var(--app-control-border)] hover:bg-[var(--app-panel-alt)] focus:border-transparent focus:ring-2 ${focusClass}`}
                    title="Click to open large editor"
                  >
                    <span className="block truncate">
                      {cleanDisplayValueForField(fieldName, getValueForField(specRecord, fieldName, fields)) || "\u00a0"}
                    </span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-[var(--app-border)] bg-[var(--app-panel)] px-3 py-4 text-xs text-[var(--app-text-muted)]">
            No category fields are available yet.
          </div>
        )}
      </div>

      {expandedEditorPortal}
    </>
  );
}
