"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, Trash2, Upload, X } from "lucide-react";
import { SALVAGE_MAX_ADDITIONAL_UNITS, SALVAGE_MAX_ADDITIONAL_UNIT_PHOTOS, type SalvageUnit } from "@/services/salvage";
import ImageAnnotatorModal, { type AnnotatorAction, type DamageLoop } from "./ImageAnnotatorModal";
import { FIELD_CLASS } from "../real-estate/Field";

/*
  Units 2 onward of a Salvage report (owner, 2026-11-01: one report covers
  several units, like file 71763's truck and two trailers or 76047's six grain
  bins). Each unit has its own details, photos (with damage loops, as unit 1)
  and a switch for the market research. The photos upload with the report;
  the server keeps them per unit and researches each unit that asks for it.
*/

type PhotoEdit = { original: File; actions: AnnotatorAction[]; damageLoops: DamageLoop[]; displayFile: File };
export type SalvageUnitDraft = { key: string; fields: SalvageUnit; images: File[]; edits: (PhotoEdit | undefined)[] };

export const newSalvageUnitDraft = (): SalvageUnitDraft => ({ key: crypto.randomUUID(), fields: { research: true }, images: [], edits: [] });

/** The unit as sent with the report: its fields and the loops drawn on its photos. */
export function salvageUnitPayload(draft: SalvageUnitDraft): SalvageUnit {
  const damageMarks = draft.images.flatMap((_, photoIndex) => {
    const loops = draft.edits[photoIndex]?.damageLoops || [];
    return loops.length ? [{ photoIndex, loops }] : [];
  });
  const fields = Object.fromEntries(Object.entries(draft.fields).filter(([, value]) => value !== "" && value !== undefined));
  return { ...fields, research: draft.images.length > 0 && draft.fields.research !== false, ...(damageMarks.length ? { damage_marks: damageMarks } : {}) };
}

const TEXT_FIELDS: readonly (readonly [keyof SalvageUnit, string, string?])[] = [
  ["unit_label", "Unit name", "Semi Trailer #01 (Lead)"], ["item_type", "Type", "Super-B Flatdeck"], ["year", "Year"], ["make", "Make"],
  ["item_model", "Model"], ["vin", "VIN / serial number"], ["licence_plate", "Licence plate"], ["limit_of_insurance", "Limit of insurance"],
  ["coverage", "Coverage"], ["deductible", "Deductible"], ["item_condition", "Condition", "Good"], ["hours", "Hour / kilometre reading"],
];
const LONG_FIELDS: readonly (readonly [keyof SalvageUnit, string])[] = [
  ["pre_existing_damage", "Pre-existing damage"], ["damage_description", "Description of damage"],
];

function UnitPhotos({ draft, disabled, onChange, remaining }: { draft: SalvageUnitDraft; disabled: boolean; remaining: number; onChange: (next: SalvageUnitDraft) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [previews, setPreviews] = useState<string[]>([]);
  const [marking, setMarking] = useState<number | null>(null);
  useEffect(() => {
    const urls = draft.images.map((file, index) => URL.createObjectURL(draft.edits[index]?.displayFile || file));
    setPreviews(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [draft.images, draft.edits]);
  const room = Math.min(50 - draft.images.length, remaining);
  return (
    <div className="grid gap-2">
      <input ref={input} type="file" accept="image/*" multiple className="sr-only" aria-label={`Photos for ${draft.fields.unit_label || "this unit"}`}
        onChange={(event) => {
          const files = Array.from(event.target.files || []).slice(0, Math.max(0, room));
          event.currentTarget.value = "";
          if (files.length) onChange({ ...draft, images: [...draft.images, ...files], edits: [...draft.edits, ...files.map(() => undefined)] });
        }} />
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="app-button app-button--secondary" disabled={disabled || room <= 0} onClick={() => input.current?.click()}>
          <Upload className="size-4" aria-hidden /> Add photos
        </button>
        <span className="text-xs tabular-nums text-[var(--app-text-muted)]">{draft.images.length} photo{draft.images.length === 1 ? "" : "s"}</span>
      </div>
      {draft.images.length ? (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-6">
          {previews.map((src, index) => (
            <div key={index} className="relative overflow-hidden rounded-lg border border-[var(--app-border)]">
              <img src={src} alt={`Unit photo ${index + 1}`} className="h-20 w-full cursor-crosshair object-cover" onClick={() => !disabled && setMarking(index)} />
              {draft.edits[index]?.damageLoops.length ? (
                <span className="absolute left-1 top-1 rounded-full bg-[#dc2626] px-1.5 py-0.5 text-[10px] font-semibold text-white">
                  {draft.edits[index]!.damageLoops.length} damage
                </span>
              ) : null}
              <button type="button" disabled={disabled} onClick={() => setMarking(index)}
                className="absolute bottom-1 left-1 rounded-full bg-black/65 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {draft.edits[index] ? "Edit marks" : "Mark damage"}
              </button>
              <button type="button" aria-label={`Remove unit photo ${index + 1}`} disabled={disabled}
                onClick={() => onChange({ ...draft, images: draft.images.filter((_, i) => i !== index), edits: draft.edits.filter((_, i) => i !== index) })}
                className="absolute right-1 top-1 rounded-full bg-black/65 p-1 text-white hover:bg-[var(--app-danger)]">
                <X className="size-3" aria-hidden />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <ImageAnnotatorModal
        open={marking !== null}
        file={marking !== null ? draft.edits[marking]?.original || draft.images[marking] || null : null}
        defaultMode="damage"
        initialActions={marking !== null ? draft.edits[marking]?.actions : undefined}
        onClose={() => setMarking(null)}
        onSave={(uploadFile, edit) => {
          if (marking === null || !uploadFile) return;
          const original = draft.edits[marking]?.original || draft.images[marking];
          const marked = edit.actions.length > 0;
          onChange({
            ...draft,
            // As for unit 1: a marked photo uploads the editor's copy, loops travel as data.
            images: draft.images.map((file, i) => (i === marking ? (marked ? uploadFile : original) : file)),
            edits: draft.edits.map((entry, i) => (i === marking
              ? (marked ? { original, actions: edit.actions, damageLoops: edit.damageLoops, displayFile: edit.displayFile || uploadFile } : undefined)
              : entry)),
          });
          setMarking(null);
        }}
      />
    </div>
  );
}

export default function SalvageUnitsEditor({ units, onChange, disabled }: { units: SalvageUnitDraft[]; onChange: (units: SalvageUnitDraft[]) => void; disabled: boolean }) {
  const photos = units.reduce((sum, unit) => sum + unit.images.length, 0);
  const set = (index: number, next: SalvageUnitDraft) => onChange(units.map((unit, i) => (i === index ? next : unit)));
  const field = (index: number, key: keyof SalvageUnit, value: unknown) => set(index, { ...units[index], fields: { ...units[index].fields, [key]: value } });
  return (
    <div className="grid gap-3">
      {units.map((unit, index) => (
        <section key={unit.key} className="rounded-xl border border-[var(--app-border)] bg-[var(--app-panel)] p-3 sm:p-4" aria-label={`Unit ${index + 2}`}>
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-[var(--app-text)]">Unit {index + 2}{unit.fields.unit_label ? ` — ${unit.fields.unit_label}` : ""}</h3>
            <button type="button" className="app-button" disabled={disabled} onClick={() => onChange(units.filter((_, i) => i !== index))}>
              <Trash2 className="size-4" aria-hidden /> Remove unit
            </button>
          </div>
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-3">
            {TEXT_FIELDS.map(([key, label, placeholder]) => (
              <div key={key} className="grid min-w-0 content-start gap-1.5">
                <label htmlFor={`unit-${unit.key}-${key}`} className="text-[13px] font-semibold text-[var(--app-text)]">{label}</label>
                <input id={`unit-${unit.key}-${key}`} className={FIELD_CLASS} value={String(unit.fields[key] ?? "")} placeholder={placeholder}
                  disabled={disabled} onChange={(e) => field(index, key, e.target.value)} />
              </div>
            ))}
            {LONG_FIELDS.map(([key, label]) => (
              <div key={key} className="col-span-full grid gap-1.5">
                <label htmlFor={`unit-${unit.key}-${key}`} className="text-[13px] font-semibold text-[var(--app-text)]">{label}</label>
                <textarea id={`unit-${unit.key}-${key}`} rows={2} className={`${FIELD_CLASS} resize-y`} value={String(unit.fields[key] ?? "")}
                  disabled={disabled} onChange={(e) => field(index, key, e.target.value)} />
              </div>
            ))}
          </div>
          <div className="mt-3 grid gap-2">
            <p className="text-[13px] font-semibold text-[var(--app-text)]">Photos</p>
            <UnitPhotos draft={unit} disabled={disabled} remaining={SALVAGE_MAX_ADDITIONAL_UNIT_PHOTOS - photos} onChange={(next) => set(index, next)} />
            <label className="mt-1 inline-flex items-center gap-2 text-sm text-[var(--app-text)]">
              <input type="checkbox" checked={unit.fields.research !== false} disabled={disabled || !unit.images.length}
                onChange={(e) => field(index, "research", e.target.checked)} />
              Research the market for this unit
              <span className="text-xs text-[var(--app-text-muted)]">{unit.images.length ? "(uses its photos; each unit is a separate research run)" : "(add photos first)"}</span>
            </label>
          </div>
        </section>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="app-button app-button--secondary" disabled={disabled || units.length >= SALVAGE_MAX_ADDITIONAL_UNITS}
          onClick={() => onChange([...units, newSalvageUnitDraft()])}>
          <Plus className="size-4" aria-hidden /> Add another unit
        </button>
        <span className="text-xs text-[var(--app-text-muted)]">
          {units.length ? `${units.length + 1} units in this report · ${photos}/${SALVAGE_MAX_ADDITIONAL_UNIT_PHOTOS} photos for units 2 onward` : "One unit so far. Add a unit for each truck, trailer, bin or machine in this claim."}
        </span>
      </div>
    </div>
  );
}
