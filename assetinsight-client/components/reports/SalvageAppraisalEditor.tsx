"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ExternalLink, FileText, ImageIcon, Lasso, Plus, Trash2, Upload } from "lucide-react";
import {
  SalvageService, SALVAGE_LOSS_STATUSES, SALVAGE_MAX_ADDITIONAL_UNITS,
  type SalvageAppendix, type SalvageDamageMark, type SalvagePreviewData, type SalvageReport, type SalvageUnit,
} from "@/services/salvage";
import { salvageSystemText } from "@/lib/salvagePresentation";
import ImageAnnotatorModal from "@/components/forms/salvage/ImageAnnotatorModal";
import { DAMAGE_COLOR, marksWithLoops, photoLoops } from "./SalvageDamageLoops";
import styles from "./SalvagePreviewWorkspace.module.css";
import { captureAuthSession, isAuthSessionCurrent } from "@/lib/auth-storage";

/*
  The full MCD Appraisals report in the Salvage preview (owner, 2026-11-01:
  "yes go ahead with the form and upload side"):
    - SalvageAppraisalFields: the report's front-sheet fields and unit 1's
      appraisal fields (licence plate, limit of insurance, coverage,
      deductible, repairable status, Actual Cash Value or Replacement Cost,
      recommended reserve, salvage value, betterment, shop supplies, taxes).
    - SalvageUnitsPreview: units 2 onward, edited like unit 1; a unit keeps its
      saved photos and research (server-owned) and can have its loops changed.
    - SalvageAppendicesPanel: uploaded PDFs and photos printed as Appendix A, B,
      C. Appendix changes save at once with their own requests, separate from
      Save changes, and mark the report files out of date.
*/

type Change = (key: string, value: unknown) => void;
const scalar = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : "");
const object = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const numberOrNull = (raw: string) => (raw === "" ? null : Number(raw));
const errorMessage = (error: unknown, fallback: string) => {
  const value = error as { response?: { data?: { message?: string } }; message?: string };
  return salvageSystemText(value?.response?.data?.message || value?.message, fallback);
};

function Text({ id, label, value, onChange, disabled, wide, area, placeholder }: {
  id: string; label: string; value: unknown; onChange: (value: string) => void; disabled: boolean; wide?: boolean; area?: boolean; placeholder?: string;
}) {
  return <label htmlFor={id} className={`${styles.field} ${wide ? styles.wide : ""}`}>{label}
    {area ? <textarea id={id} value={scalar(value)} disabled={disabled} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      : <input id={id} value={scalar(value)} disabled={disabled} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />}
  </label>;
}
function Money({ id, label, value, onChange, disabled }: { id: string; label: string; value: unknown; onChange: (value: number | null) => void; disabled: boolean }) {
  return <label htmlFor={id} className={styles.field}>{label}
    <input id={id} type="number" min={0} step="any" value={value === null || value === undefined ? "" : scalar(value)} disabled={disabled}
      onChange={(e) => onChange(numberOrNull(e.target.value))} />
  </label>;
}
function Choice({ id, label, value, options, onChange, disabled }: {
  id: string; label: string; value: unknown; options: readonly (readonly [string, string])[]; onChange: (value: string) => void; disabled: boolean;
}) {
  return <label htmlFor={id} className={styles.field}>{label}
    <select id={id} value={scalar(value)} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">Not specified</option>{options.map(([value, title]) => <option key={value} value={value}>{title}</option>)}
    </select>
  </label>;
}

const REPAIRABLE = [["Yes", "Yes"], ["No", "No"], ["To Be Determined", "To Be Determined"]] as const;
const VALUE_BASIS = [["acv", "Actual Cash Value"], ["replacement", "Replacement Cost"]] as const;
const LOSS = SALVAGE_LOSS_STATUSES.map((status) => [status, status] as const);
const appendixOptions = (appendices: SalvageAppendix[]) => appendices.map((a, index) => [a.id, `Appendix ${String.fromCharCode(65 + index)} — ${a.title}`] as const);

/**
 * Fields every unit shares (unit 1 at the top level, units 2+ on themselves).
 * repair: "all" asks for parts and labour too (a unit without research),
 * "extras" only betterment, shop supplies, miscellaneous and taxes (research
 * supplies parts and labour), "none" when the report's own repair cost
 * section already has them (an older, unresearched unit 1).
 */
function UnitAppraisalFields({ prefix, unit, change, disabled, appendices, repair, omitLabel = false }: {
  prefix: string; unit: Record<string, unknown>; change: Change; disabled: boolean; appendices: SalvageAppendix[]; repair: "all" | "extras" | "none";
  /** Units 2+ show their name first, before their identity fields. */
  omitLabel?: boolean;
}) {
  const summary = object(unit.repair_summary);
  const setSummary = (key: string, value: number | null) => change("repair_summary", { ...summary, [key]: value });
  return <>
    {omitLabel ? null : <Text id={`${prefix}unit_label`} label="Unit name" value={unit.unit_label} onChange={(v) => change("unit_label", v)} disabled={disabled} placeholder="Heavy Truck #807" />}
    <Text id={`${prefix}licence_plate`} label="Licence plate" value={unit.licence_plate} onChange={(v) => change("licence_plate", v)} disabled={disabled} />
    <Text id={`${prefix}limit_of_insurance`} label="Limit of insurance" value={unit.limit_of_insurance} onChange={(v) => change("limit_of_insurance", v)} disabled={disabled} />
    <Text id={`${prefix}coverage`} label="Coverage" value={unit.coverage} onChange={(v) => change("coverage", v)} disabled={disabled} />
    <Text id={`${prefix}deductible`} label="Deductible" value={unit.deductible} onChange={(v) => change("deductible", v)} disabled={disabled} />
    <Text id={`${prefix}hours`} label="Hour / kilometre reading" value={unit.hours} onChange={(v) => change("hours", v)} disabled={disabled} />
    <Choice id={`${prefix}loss_status`} label="Status" value={unit.loss_status} options={LOSS} onChange={(v) => change("loss_status", v)} disabled={disabled} />
    <Choice id={`${prefix}value_basis`} label="Value basis" value={unit.value_basis} options={VALUE_BASIS} onChange={(v) => change("value_basis", v)} disabled={disabled} />
    {/* An older, unresearched unit 1 keeps its reserve in the Valuation section. */}
    {repair !== "none" ? <Money id={`${prefix}appraiser_reserve`} label="Recommended reserve (less the deductible)" value={unit.appraiser_reserve} onChange={(v) => change("appraiser_reserve", v)} disabled={disabled} /> : null}
    <Text id={`${prefix}salvage_value`} label="Salvage value" value={unit.salvage_value} onChange={(v) => change("salvage_value", v)} disabled={disabled} placeholder="N/A, or an amount" />
    <Choice id={`${prefix}repair_estimate_appendix`} label="Full repair estimate in" value={unit.repair_estimate_appendix} options={appendixOptions(appendices)} onChange={(v) => change("repair_estimate_appendix", v)} disabled={disabled || !appendices.length} />
    {repair === "all" ? <>
      <Money id={`${prefix}parts`} label="Repair: parts" value={summary.parts} onChange={(v) => setSummary("parts", v)} disabled={disabled} />
      <Money id={`${prefix}labour`} label="Repair: labour" value={summary.labour} onChange={(v) => setSummary("labour", v)} disabled={disabled} />
    </> : null}
    {repair !== "none" ? <>
      <Money id={`${prefix}betterment`} label="Repair: less betterment" value={summary.betterment} onChange={(v) => setSummary("betterment", v)} disabled={disabled} />
      <Money id={`${prefix}shop_supplies`} label="Repair: shop supplies" value={summary.shop_supplies} onChange={(v) => setSummary("shop_supplies", v)} disabled={disabled} />
      <Money id={`${prefix}miscellaneous`} label="Repair: miscellaneous" value={summary.miscellaneous} onChange={(v) => setSummary("miscellaneous", v)} disabled={disabled} />
      <Money id={`${prefix}taxes`} label="Repair: taxes" value={summary.taxes} onChange={(v) => setSummary("taxes", v)} disabled={disabled} />
    </> : null}
    <Text id={`${prefix}pre_existing_damage`} label="Pre-existing damage" value={unit.pre_existing_damage} onChange={(v) => change("pre_existing_damage", v)} disabled={disabled} wide area />
    <Text id={`${prefix}damage_comments`} label="Damage comments" value={unit.damage_comments} onChange={(v) => change("damage_comments", v)} disabled={disabled} wide area />
  </>;
}

/** The front sheet and unit 1's appraisal fields. */
export function SalvageAppraisalFields({ draft, update, disabled, researched, appendices }: {
  draft: SalvagePreviewData; update: Change; disabled: boolean; researched: boolean; appendices: SalvageAppendix[];
}) {
  return <>
    <section className={styles.section} aria-labelledby="appraisal-summary-heading">
      <h2 id="appraisal-summary-heading">Report summary</h2>
      <div className={styles.fields}>
        <Choice id="appraisal-report_number" label="Report number" value={draft.report_number ?? 1}
          options={["One", "Two", "Three", "Four", "Five", "Six"].map((word, index) => [String(index + 1), `Report ${word}`] as const)}
          onChange={(v) => update("report_number", v ? Number(v) : 1)} disabled={disabled} />
        <Text id="appraisal-follow_up" label="Follow-up" value={draft.follow_up} onChange={(v) => update("follow_up", v)} disabled={disabled} placeholder="Upon Request" />
        {/* Older (unresearched) reports edit these in "Vehicle & condition". */}
        {researched ? <>
          <Choice id="appraisal-is_repairable" label="Repairable" value={draft.is_repairable} options={REPAIRABLE} onChange={(v) => update("is_repairable", v)} disabled={disabled} />
          <Text id="appraisal-cause_of_loss_summary" label="Our opinion – cause of loss" value={draft.cause_of_loss_summary} onChange={(v) => update("cause_of_loss_summary", v)} disabled={disabled} wide area />
        </> : null}
        <Text id="appraisal-cause_of_loss_comments" label="Cause of loss – comments" value={draft.cause_of_loss_comments} onChange={(v) => update("cause_of_loss_comments", v)} disabled={disabled} wide area placeholder="None" />
        {researched ? <>
          <Text id="appraisal-repair_facility" label="Repair facility" value={draft.repair_facility} onChange={(v) => update("repair_facility", v)} disabled={disabled} />
          <Text id="appraisal-appraiser_comments" label="Comments" value={draft.appraiser_comments} onChange={(v) => update("appraiser_comments", v)} disabled={disabled} wide area />
        </> : null}
      </div>
    </section>
    <section className={styles.section} aria-labelledby="appraisal-unit1-heading">
      <h2 id="appraisal-unit1-heading">Unit 1 — appraisal details</h2>
      <div className={styles.fields}>
        <UnitAppraisalFields prefix="unit1-" unit={draft} change={update} disabled={disabled} appendices={appendices} repair={researched ? "extras" : "none"} />
      </div>
      <p className={`${styles.muted} mt-2`}>{researched
        ? "The value comes from the market research (change it with an appraiser override in the assessment). Parts and labour come from the assessment's repair lines."
        : "Actual Cash Value, Replacement Cost and the repair estimate are edited in the sections below."}</p>
    </section>
  </>;
}

const UNIT_DETAILS = [
  ["item_type", "Type"], ["year", "Year"], ["make", "Make"], ["item_model", "Model"], ["vin", "VIN / serial number"],
  ["item_condition", "Condition"], ["repair_facility", "Repair facility"],
] as const;

/** Units 2 onward. */
export function SalvageUnitsPreview({ units, onChange, disabled, appendices }: {
  units: SalvageUnit[]; onChange: (units: SalvageUnit[]) => void; disabled: boolean; appendices: SalvageAppendix[];
}) {
  const [marking, setMarking] = useState<{ unit: number; photo: number } | null>(null);
  const set = (index: number, key: string, value: unknown) => onChange(units.map((unit, i) => (i === index ? { ...unit, [key]: value } : unit)));
  const move = (index: number, by: number) => {
    const next = [...units];
    const [unit] = next.splice(index, 1);
    next.splice(index + by, 0, unit);
    onChange(next);
  };
  const markingUnit = marking ? units[marking.unit] : null;
  return <section className={styles.section} aria-labelledby="appraisal-units-heading">
    <div className={styles.sectionHeading}><h2 id="appraisal-units-heading">More units</h2>
      <button type="button" className="app-button" disabled={disabled || units.length >= SALVAGE_MAX_ADDITIONAL_UNITS}
        onClick={() => onChange([...units, { research: false }])}><Plus className="size-4" /> Add unit</button></div>
    <p className={`${styles.muted} mb-3`}>Each unit prints on its own pages with its value, reserve and salvage value, and in the summary totals. A unit added here has no photos; units with photos are added when the report is created. Research again re-runs the market research for every unit with research turned on.</p>
    {!units.length ? <p className={styles.muted}>This report has one unit.</p> : <div className={styles.rows}>{units.map((unit, index) => {
      const photos = unit.imageUrls || [];
      const marks: SalvageDamageMark[] = Array.isArray(unit.damage_marks) ? unit.damage_marks : [];
      const value = object(object(unit.assessment).valuations);
      const preLoss = object(value.preLoss).amount;
      return <div key={unit.id || `new-${index}`} className={styles.row}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <strong className="text-sm">Unit {index + 2}{unit.unit_label ? ` — ${unit.unit_label}` : ""}</strong>
          <div className={styles.actions}>
            <button type="button" className="app-button" aria-label={`Move unit ${index + 2} up`} disabled={disabled || index === 0} onClick={() => move(index, -1)}><ArrowUp className="size-4" /></button>
            <button type="button" className="app-button" aria-label={`Move unit ${index + 2} down`} disabled={disabled || index === units.length - 1} onClick={() => move(index, 1)}><ArrowDown className="size-4" /></button>
            <button type="button" className="app-button" disabled={disabled} onClick={() => {
              if (window.confirm(`Remove unit ${index + 2}${unit.unit_label ? ` (${unit.unit_label})` : ""} from this report? Its photos stay stored but will not print.`)) onChange(units.filter((_, i) => i !== index));
            }}><Trash2 className="size-4" /> Remove</button>
          </div>
        </div>
        <div className={styles.fields}>
          <Text id={`unit${index + 2}-unit_label`} label="Unit name" value={unit.unit_label} onChange={(v) => set(index, "unit_label", v)} disabled={disabled} placeholder="Semi Trailer #01 (Lead)" />
          {UNIT_DETAILS.map(([key, label]) => <Text key={key} id={`unit${index + 2}-${key}`} label={label} value={unit[key]} onChange={(v) => set(index, key, v)} disabled={disabled} />)}
          <Choice id={`unit${index + 2}-is_repairable`} label="Repairable" value={unit.is_repairable} options={REPAIRABLE} onChange={(v) => set(index, "is_repairable", v)} disabled={disabled} />
          <Money id={`unit${index + 2}-actual_cash_value`} label="Actual Cash Value (our opinion)" value={unit.actual_cash_value} onChange={(v) => set(index, "actual_cash_value", v)} disabled={disabled} />
          <Money id={`unit${index + 2}-replacement_cost`} label="Replacement Cost" value={unit.replacement_cost} onChange={(v) => set(index, "replacement_cost", v)} disabled={disabled} />
          <UnitAppraisalFields prefix={`unit${index + 2}-`} unit={unit as Record<string, unknown>} change={(key, v) => set(index, key, v)} disabled={disabled} appendices={appendices} repair={unit.assessment ? "extras" : "all"} omitLabel />
          <Text id={`unit${index + 2}-damage_description`} label="Description of damage" value={unit.damage_description} onChange={(v) => set(index, "damage_description", v)} disabled={disabled} wide area />
          <Text id={`unit${index + 2}-inspection_comments`} label="Inspection comments" value={unit.inspection_comments} onChange={(v) => set(index, "inspection_comments", v)} disabled={disabled} wide area />
          <Text id={`unit${index + 2}-replacement_cost_references`} label="References" value={unit.replacement_cost_references} onChange={(v) => set(index, "replacement_cost_references", v)} disabled={disabled} wide area placeholder="Kijiji, Marketbook.ca, dealers" />
        </div>
        <div className="mt-3">
          <p className={`${styles.muted} mb-2`}>{photos.length ? `${photos.length} photo${photos.length === 1 ? "" : "s"}` : "No photos"}{unit.assessment ? ` · researched${typeof preLoss === "number" ? `: pre-loss value ${preLoss.toLocaleString("en-CA", { style: "currency", currency: "CAD" })}` : ""}` : ""}</p>
          {photos.length ? <div className={styles.photos}>{photos.map((url, photo) => {
            const loops = photoLoops(marks, photo);
            return <button key={`${url}-${photo}`} type="button" className={`${styles.photo} relative`} disabled={disabled} onClick={() => setMarking({ unit: index, photo })} aria-label={`Mark damage on unit ${index + 2} photo ${photo + 1}`}>
              <img src={url} alt={`Unit ${index + 2} photo ${photo + 1}`} loading="lazy" />
              {loops.length ? <span className="absolute left-1.5 top-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold text-white" style={{ background: DAMAGE_COLOR }}>{loops.length} damage</span> : null}
              <span><Lasso className="inline size-3" /> Photo {photo + 1}</span>
            </button>;
          })}</div> : null}
          <label className="mt-2 inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={unit.research === true} disabled={disabled || !photos.length} onChange={(e) => set(index, "research", e.target.checked)} />
            Research the market for this unit on Research again
          </label>
        </div>
      </div>;
    })}</div>}
    <ImageAnnotatorModal
      open={marking !== null}
      file={null}
      imageUrl={marking && markingUnit ? (markingUnit.imageUrls || [])[marking.photo] : undefined}
      damageOnly
      defaultMode="damage"
      initialDamageLoops={marking && markingUnit ? photoLoops((markingUnit.damage_marks || []) as SalvageDamageMark[], marking.photo) : undefined}
      onClose={() => setMarking(null)}
      onSave={(_, edit) => {
        if (!marking || !markingUnit) return;
        set(marking.unit, "damage_marks", marksWithLoops((markingUnit.damage_marks || []) as SalvageDamageMark[], marking.photo, edit.damageLoops));
        setMarking(null);
      }}
    />
  </section>;
}

/** Uploaded documents printed as appendices; each change saves at once. */
export function SalvageAppendicesPanel({ report, disabled, onReport, beginMutation, endMutation }: {
  report: SalvageReport; disabled: boolean; onReport: (report: SalvageReport) => void;
  beginMutation?: () => boolean; endMutation?: () => void;
}) {
  const appendices = report.appendices || [];
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [edits, setEdits] = useState<Record<string, { title: string; note: string }>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const version = Number(report.appendices_version || 0);
  const reportId = report.reportId || report._id;
  const request = useRef<symbol | null>(null);
  useEffect(() => () => { request.current = null; }, []);

  /** Runs one appendix change; true when the server accepted it. */
  async function act(work: () => Promise<{ data: SalvageReport }>, done: string): Promise<boolean> {
    if (disabled || request.current || (beginMutation && !beginMutation())) return false;
    const operation = Symbol();
    const session = captureAuthSession();
    request.current = operation;
    const current = () => request.current === operation && isAuthSessionCurrent(session);
    setBusy(true); setMessage(null);
    try {
      const response = await work();
      if (!current()) return false;
      onReport(response.data); setMessage({ error: false, text: done }); return true;
    }
    catch (error) {
      if (current()) setMessage({ error: true, text: errorMessage(error, "The appendices could not be changed. Reload and try again.") });
      return false;
    }
    finally {
      if (request.current === operation) { request.current = null; setBusy(false); endMutation?.(); }
    }
  }
  const listed = (next: SalvageAppendix[]) => next.map((a) => ({ id: a.id, title: edits[a.id]?.title ?? a.title, note: edits[a.id]?.note ?? a.note }));
  const reorder = (index: number, by: number) => {
    const next = [...appendices];
    const [entry] = next.splice(index, 1);
    next.splice(index + by, 0, entry);
    void act(() => SalvageService.updateAppendices(reportId, listed(next), version), "Order saved.");
  };
  const off = disabled || busy;

  return <section className={styles.section} aria-labelledby="appendices-heading">
    <h2 id="appendices-heading">Appendices</h2>
    <p className={`${styles.muted} mb-3`}>Repair estimates, invoices, quotes, valuation guide printouts or photos of paperwork. Each prints after the report as Appendix A, B, C, fitted to A4, and is listed in the contents. PDF (up to 60 pages) or a photo; changes here save at once and mark the report files out of date.</p>
    {appendices.length ? <div className={styles.rows}>{appendices.map((appendix, index) => {
      const edit = edits[appendix.id];
      const changed = edit && (edit.title !== appendix.title || edit.note !== appendix.note);
      return <div key={appendix.id} className={styles.row}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong className="text-sm">{appendix.kind === "pdf" ? <FileText className="mr-1 inline size-4" /> : <ImageIcon className="mr-1 inline size-4" />}Appendix {String.fromCharCode(65 + index)} · {appendix.pageCount} page{appendix.pageCount === 1 ? "" : "s"}{appendix.filename ? ` · ${appendix.filename}` : ""}</strong>
          <div className={styles.actions}>
            <a className="app-button" href={appendix.url} target="_blank" rel="noreferrer"><ExternalLink className="size-4" /> Open</a>
            <button type="button" className="app-button" aria-label={`Move appendix ${String.fromCharCode(65 + index)} up`} disabled={off || index === 0} onClick={() => reorder(index, -1)}><ArrowUp className="size-4" /></button>
            <button type="button" className="app-button" aria-label={`Move appendix ${String.fromCharCode(65 + index)} down`} disabled={off || index === appendices.length - 1} onClick={() => reorder(index, 1)}><ArrowDown className="size-4" /></button>
            <button type="button" className="app-button" disabled={off} onClick={() => {
              if (window.confirm(`Remove Appendix ${String.fromCharCode(65 + index)} (${appendix.title}) from the report?`)) void act(() => SalvageService.updateAppendices(reportId, listed(appendices.filter((a) => a.id !== appendix.id)), version), "Appendix removed.");
            }}><Trash2 className="size-4" /> Remove</button>
          </div>
        </div>
        <div className={`${styles.fields} mt-2`}>
          <Text id={`appendix-${appendix.id}-title`} label="Title" value={edit?.title ?? appendix.title} disabled={off} onChange={(v) => setEdits((all) => ({ ...all, [appendix.id]: { title: v, note: all[appendix.id]?.note ?? appendix.note } }))} />
          <Text id={`appendix-${appendix.id}-note`} label="Note (optional)" value={edit?.note ?? appendix.note} disabled={off} onChange={(v) => setEdits((all) => ({ ...all, [appendix.id]: { title: all[appendix.id]?.title ?? appendix.title, note: v } }))} />
          {changed ? <div className="flex items-end"><button type="button" className="app-button app-button--primary" disabled={off || !edit.title.trim()}
            onClick={() => void act(() => SalvageService.updateAppendices(reportId, listed(appendices), version), "Appendix saved.").then((ok) => { if (ok) setEdits((all) => { const next = { ...all }; delete next[appendix.id]; return next; }); })}>Save title and note</button></div> : null}
        </div>
      </div>;
    })}</div> : <p className={styles.muted}>No appendices yet.</p>}
    <div className={`${styles.row} mt-3`}>
      <strong className="text-sm">Add an appendix</strong>
      <div className={`${styles.fields} mt-2`}>
        <Text id="appendix-new-title" label="Title" value={title} onChange={setTitle} disabled={off} placeholder="Repair estimate — Unit 1" />
        <Text id="appendix-new-note" label="Note (optional)" value={note} onChange={setNote} disabled={off} placeholder="From the repair facility, 27 Oct" />
        <div className={styles.field}>File
          <input ref={input} type="file" aria-label="Appendix file" accept="application/pdf,.pdf,image/jpeg,image/png,image/webp,image/heic,image/heif" disabled={off}
            onChange={(e) => {
              const chosen = e.target.files?.[0] || null;
              setFile(chosen);
              if (chosen && !title.trim()) setTitle(chosen.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 120));
            }} />
        </div>
      </div>
      <button type="button" className="app-button app-button--primary mt-2" disabled={off || !file || !title.trim()}
        onClick={() => void act(() => SalvageService.addAppendix(reportId, file!, { title: title.trim(), note: note.trim() }, version), "Appendix attached.").then((ok) => {
          if (!ok) return;
          setFile(null); setTitle(""); setNote(""); if (input.current) input.current.value = "";
        })}><Upload className="size-4" /> {busy ? "Uploading…" : "Attach"}</button>
    </div>
    {message ? <p role={message.error ? "alert" : "status"} className={`${styles.notice} ${message.error ? styles.error : ""} mt-3`}>{message.text}</p> : null}
  </section>;
}
