"use client";

import { useId } from "react";
import { formatAssessmentMoney, type SalvageAssessmentInputs, type SalvageAssessmentV2,
  type SalvageComparableEvidence, type SalvageCostInput, type SalvageReference, type SalvageAdjustment } from "@/lib/salvageAssessment";
import styles from "./SalvagePreviewWorkspace.module.css";
import SalvageVehicleDetails from "./SalvageVehicleDetails";
import { salvageSystemText } from "@/lib/salvagePresentation";

export interface SalvageAssessmentEditorProps {
  assessment: SalvageAssessmentV2;
  inputs: Partial<SalvageAssessmentInputs>;
  disabled: boolean;
  onChange: (inputs: Partial<SalvageAssessmentInputs>) => void;
  photos?: string[];
  onViewPhoto?: (index: number) => void;
}
type Value = string | number | null | undefined;
type FieldOptions = { type?: "number" | "date" | "url" | "textarea"; allowNegative?: boolean; hint?: string };
const PROVINCES = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"];
const text = (value: Value) => value === null || value === undefined ? "" : String(value);
const nullable = (value: string): string | null => value === "" ? null : value;
const id = () => `appraiser-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
const cost = (description: string): SalvageCostInput => ({ description, amount: null, referenceIds: [], appraiserReason: null });
function safeLink(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value), host = url.hostname.toLowerCase().replace(/\.$/, "");
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      && (!url.port || ["80", "443"].includes(url.port)) && host.includes(".") && !host.includes(":")
      && !/^[\d.]+$/.test(host) && !/(?:^|\.)(localhost|local|internal|test|invalid|home|lan)$/.test(host)
      ? url.toString() : null;
  } catch { return null; }
}
function sourceLink(url: string | null, label: string) {
  const target = safeLink(url);
  return target ? <a href={target} target="_blank" rel="noopener noreferrer" className="underline break-all">{label}</a> : <span>{label}{url ? " (unsafe or unsupported link)" : ""}</span>;
}

/** Edits only canonical inputs; all displayed conclusions remain the saved server values. */
export default function SalvageAssessmentEditor({ assessment, inputs, disabled, onChange, photos, onViewPhoto }: SalvageAssessmentEditorProps) {
  const prefix = useId();
  const draft: SalvageAssessmentInputs = { ...assessment.inputs, ...inputs,
    sellerCosts: { ...assessment.inputs.sellerCosts, ...inputs.sellerCosts },
    overrides: { ...assessment.inputs.overrides, ...inputs.overrides } };
  const vehicleDetails = assessment.vehicleDetails?.schemaVersion === 1 ? assessment.vehicleDetails : null;
  const previousSuppliedRefs = new Set(assessment.inputs.suppliedReferences.map((reference) => reference.id));
  const references = [...new Map([...assessment.references.filter((reference) => !previousSuppliedRefs.has(reference.id)), ...draft.suppliedReferences].map((reference) => [reference.id, reference])).values()];
  const availablePhotos = photos ? photos.slice(0, 50).map((_, index) => `photo-${String(index + 1).padStart(3, "0")}`) : assessment.photoFindings.map((photo) => photo.photoId);
  const update = <K extends keyof SalvageAssessmentInputs>(key: K, value: SalvageAssessmentInputs[K]) => { if (!disabled) onChange({ ...draft, [key]: value }); };
  const field = (label: string, value: Value, change: (value: string | number | null) => void, options: FieldOptions = {}) => {
    const fieldId = `${prefix}-${label.replace(/[^a-zA-Z0-9]/g, "-")}`;
    const invalidUrl = options.type === "url" && Boolean(value) && !safeLink(value);
    const input = options.type === "textarea"
      ? <textarea id={fieldId} aria-label={label} aria-describedby={options.hint ? `${fieldId}-hint` : undefined} value={text(value)} disabled={disabled} onChange={(event) => change(nullable(event.target.value))} />
      : <input id={fieldId} aria-label={label} aria-describedby={options.hint ? `${fieldId}-hint` : undefined} type={options.type || "text"} value={text(value)} disabled={disabled}
        min={options.type === "number" && !options.allowNegative ? 0 : undefined} step={options.type === "number" ? "any" : undefined}
        aria-invalid={invalidUrl || undefined} onChange={(event) => {
          if (options.type !== "number") { change(nullable(event.target.value)); return; }
          if (!event.target.value) { change(null); return; }
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed) && (options.allowNegative || parsed >= 0)) change(parsed);
        }} />;
    return <label key={label} className={`${styles.field} ${options.type === "textarea" ? styles.wide : ""}`} htmlFor={fieldId}>
      {label}{input}{options.hint ? <span id={`${fieldId}-hint`} className={styles.muted}>{options.hint}</span> : null}
      {invalidUrl ? <span role="status">Enter a public HTTP(S) source URL without credentials or an internal address.</span> : null}
    </label>;
  };
  const select = (label: string, value: string | null, options: readonly (readonly [string, string])[], change: (value: string | null) => void) => <label className={styles.field}>
    {label}<select aria-label={label} value={value || ""} disabled={disabled} onChange={(event) => change(nullable(event.target.value))}>
      <option value="">Unknown / not supplied</option>{options.map(([key, title]) => <option key={key} value={key}>{title}</option>)}
    </select>
  </label>;
  const refSelection = (label: string, selected: string[], change: (ids: string[]) => void) => <details className={`${styles.wide} ${styles.field}`}>
    <summary className="cursor-pointer">{label} ({selected.length})</summary>
    {!references.length ? <p className={styles.muted}>Add source evidence below, or record an appraiser rationale.</p> : references.map((reference) => <label key={reference.id} className="flex gap-2 items-start">
      <input type="checkbox" style={{ width: "auto", flexShrink: 0 }} checked={selected.includes(reference.id)} disabled={disabled} aria-label={`${label}: ${reference.id}`}
        onChange={(event) => change(event.target.checked ? [...new Set([...selected, reference.id])] : selected.filter((value) => value !== reference.id))} />
      <span>{reference.id} — {reference.title}</span>
    </label>)}
    {selected.filter((value) => !references.some((reference) => reference.id === value)).map((value) => <p role="status" key={value}>Missing evidence reference: {value}. Remove or replace this reference before relying on the value.
      <button className="app-button" type="button" disabled={disabled} onClick={() => change(selected.filter((id) => id !== value))}>Remove missing reference {value}</button>
    </p>)}
  </details>;
  const photoSelection = (label: string, selected: string[], change: (ids: string[]) => void) => <details className={`${styles.wide} ${styles.field}`}>
    <summary className="cursor-pointer">{label} ({selected.length})</summary>
    {!availablePhotos.length ? <p className={styles.muted}>This report has no uploaded photos to reference.</p> : availablePhotos.map((photoId) => <label className="flex gap-2 items-center" key={photoId}>
      <input type="checkbox" style={{ width: "auto", flexShrink: 0 }} checked={selected.includes(photoId)} disabled={disabled} aria-label={`${label}: ${photoId}`}
        onChange={(event) => change(event.target.checked ? [...new Set([...selected, photoId])] : selected.filter((value) => value !== photoId))} />{photoId}
    </label>)}
    {selected.some((value) => !availablePhotos.includes(value)) ? <p role="status">A selected photo is not in this report; it cannot support a value.</p> : null}
  </details>;
  const rationale = (label: string, value: string | null, change: (reason: string | null) => void) => field(label, value, (value) => change(value === null ? null : String(value)), {
    type: "textarea", hint: "State the source or professional reasoning (at least 10 characters). A generic citation is not evidence of a specific cost."
  });
  const costFields = (label: string, value: SalvageCostInput, change: (cost: SalvageCostInput) => void) => <div className={styles.fields}>
    {field(`${label} description`, value.description, (next) => change({ ...value, description: text(next) }))}
    {field(`${label} amount (CAD)`, value.amount, (next) => change({ ...value, amount: next as number | null }), { type: "number", hint: "Blank is unknown. Enter 0 only when confirmed not applicable, with a rationale." })}
    {rationale(`${label} rationale`, value.appraiserReason, (next) => change({ ...value, appraiserReason: next }))}
    {refSelection(`${label} evidence`, value.referenceIds, (next) => change({ ...value, referenceIds: next }))}
  </div>;
  const remove = (label: string, action: () => void) => <button className="app-button mt-2" type="button" disabled={disabled} onClick={action}>Remove {label}</button>;
  const subjectText = (key: "make" | "model" | "trim" | "powertrain" | "vin" | "market" | "lossType" | "condition" | "damageDescription" | "documentedBrand", label: string, multiline = false) => field(label, draft[key], (value) => update(key, value === null ? null : String(value)), { type: multiline ? "textarea" : undefined });
  const changeComparable = (index: number, value: SalvageComparableEvidence) => update("suppliedComparables", draft.suppliedComparables.map((row, rowIndex) => rowIndex === index ? value : row));
  const addComparable = () => {
    const newComparable: SalvageComparableEvidence = { id: id(), basket: "as_is", title: "", url: null, sourceName: null, listingId: null, vin: null,
      year: null, make: null, model: null, trim: null, powertrain: null, odometer: null, odometerUnit: null,
      condition: null, brand: null, location: null, province: null, country: "CA", eventDate: null,
      price: null, currency: "CAD", priceBasis: "unknown", verification: "appraiser_supplied", evidence: {}, referenceIds: [],
      adjustments: [], fx: null, appraiserReason: null, photoIds: [], eligible: false, selected: false, exclusionReasons: [], adjustedPrice: null, ageDays: null };
    update("suppliedComparables", [...draft.suppliedComparables, newComparable]);
  };

  return <div className={styles.rows} aria-label="Canadian salvage assessment editor">
    <section className={styles.section} aria-label="Saved assessment conclusions"><h2>Saved Canadian assessment</h2>
      <p className={`${styles.muted} mb-3`}>CAD · Last calculated from the saved revision. Editing an input does not recalculate these values in your browser or start research. Save to validate and recalculate.</p>
      <dl className={styles.analysis}>
        <dt>Pre-loss market value</dt><dd><output data-testid="saved-pre-loss-value">{formatAssessmentMoney(assessment.valuations.preLoss.amount)}</output> · {assessment.valuations.preLoss.status.replaceAll("_", " ")}</dd>
        <dt>Repair estimate</dt><dd><output data-testid="saved-repair-value">{formatAssessmentMoney(assessment.repairs.total)}</output> · {assessment.repairs.status}</dd>
        <dt>As-is salvage value</dt><dd><output data-testid="saved-as-is-value">{formatAssessmentMoney(assessment.valuations.asIs.amount)}</output> · {assessment.valuations.asIs.status.replaceAll("_", " ")}</dd>
        <dt>Net auction recovery</dt><dd><output data-testid="saved-net-value">{formatAssessmentMoney(assessment.netRecovery.total)}</output> · {assessment.netRecovery.status}</dd>
      </dl>
      {assessment.stale ? <p role="status" className={`${styles.notice} mt-3`}>Research is stale because material subject details changed. Research again before relying on previous evidence.</p> : null}
    </section>
    {vehicleDetails ? <SalvageVehicleDetails details={vehicleDetails}
      overrides={draft.vehicleOverrides} disabled={disabled} onChange={(overrides) => update("vehicleOverrides", overrides)}
      photoCount={photos?.length ?? 0} onViewPhoto={onViewPhoto} /> : null}
    <section className={styles.section}><h2>Subject and Canadian market</h2>
      {!vehicleDetails ? <p className={`${styles.muted} mb-3`}>Legacy vehicle details: saved or user-supplied values, not verified image readings. New photo-evidence fields are available only after an explicit research run.</p> : null}
      <div className={styles.fields}>
      {!vehicleDetails ? <>
      {field("Assessment year", draft.year, (value) => update("year", value as number | null), { type: "number" })}
      {subjectText("make", "Assessment make")}{subjectText("model", "Assessment model")}{subjectText("trim", "Assessment trim")}{subjectText("powertrain", "Assessment powertrain")}{subjectText("vin", "Assessment VIN")}
      {field("Assessment odometer", draft.odometer, (value) => update("odometer", value as number | null), { type: "number" })}
      {select("Odometer unit", draft.odometerUnit, [["km", "Kilometres"], ["mi", "Miles"]], (value) => update("odometerUnit", value as "km" | "mi" | null))}
      </> : null}
      {select("Market province", draft.province, PROVINCES.map((value) => [value, value]), (value) => update("province", value))}
      {subjectText("market", "Market city / region")}
      {field("Effective valuation date", draft.effectiveDate, (value) => update("effectiveDate", value as string | null), { type: "date" })}
      {subjectText("lossType", "Assessment loss type")}{subjectText("condition", "Assessment condition", true)}{subjectText("damageDescription", "Assessment damage description", true)}
      {subjectText("documentedBrand", "Documented vehicle brand")}
      {select("Brand document province", draft.brandProvince, PROVINCES.map((value) => [value, value]), (value) => update("brandProvince", value))}
      {select("Brand document evidence", draft.brandEvidenceRef, draft.suppliedReferences.map((reference) => [reference.id, `${reference.id} — ${reference.title}`]), (value) => update("brandEvidenceRef", value))}
    </div><p className={`${styles.muted} mt-2`}>A brand must come from the vehicle-specific registration/brand document, not photographs of damage or general provincial rules. Add the document evidence below.</p></section>

    <section className={styles.section}><div className={styles.sectionHeading}><h2>Supported repair parts</h2><button type="button" className="app-button" disabled={disabled || draft.repairItems.length >= 300}
      onClick={() => update("repairItems", [...draft.repairItems, { description: "", quantity: null, unitPrice: null, referenceIds: [], appraiserReason: null }])}>Add repair part</button></div>
      {!draft.repairItems.length ? <p className={styles.muted}>Parts scope is unknown. Add supported parts or a documented zero entry if none apply.</p> : <div className={styles.rows}>{draft.repairItems.map((item, index) => {
        const updatePart = (patch: Partial<typeof item>) => update("repairItems", draft.repairItems.map((row, position) => position === index ? { ...row, ...patch } : row));
        return <div key={index} className={styles.row}><h3 className="mb-2 font-semibold">Part {index + 1}</h3><div className={styles.fields}>
          {field(`Part ${index + 1} description`, item.description, (value) => updatePart({ description: text(value) }))}
          {field(`Part ${index + 1} quantity`, item.quantity, (value) => updatePart({ quantity: value as number | null }), { type: "number" })}
          {field(`Part ${index + 1} unit price (CAD)`, item.unitPrice, (value) => updatePart({ unitPrice: value as number | null }), { type: "number" })}
          {rationale(`Part ${index + 1} rationale`, item.appraiserReason, (value) => updatePart({ appraiserReason: value }))}
          {refSelection(`Part ${index + 1} evidence`, item.referenceIds, (value) => updatePart({ referenceIds: value }))}
        </div>{remove(`repair part ${index + 1}`, () => update("repairItems", draft.repairItems.filter((_, position) => position !== index)))}</div>;
      })}</div>}
    </section>
    <section className={styles.section}><div className={styles.sectionHeading}><h2>Supported labour</h2><button type="button" className="app-button" disabled={disabled || draft.labourItems.length >= 300}
      onClick={() => update("labourItems", [...draft.labourItems, { description: "", hours: null, rate: null, referenceIds: [], appraiserReason: null }])}>Add labour task</button></div>
      {!draft.labourItems.length ? <p className={styles.muted}>Labour scope is unknown; photos cannot establish required labour hours or rates.</p> : <div className={styles.rows}>{draft.labourItems.map((item, index) => {
        const updateLabour = (patch: Partial<typeof item>) => update("labourItems", draft.labourItems.map((row, position) => position === index ? { ...row, ...patch } : row));
        return <div key={index} className={styles.row}><h3 className="mb-2 font-semibold">Labour {index + 1}</h3><div className={styles.fields}>
          {field(`Labour ${index + 1} task`, item.description, (value) => updateLabour({ description: text(value) }))}
          {field(`Labour ${index + 1} hours`, item.hours, (value) => updateLabour({ hours: value as number | null }), { type: "number" })}
          {field(`Labour ${index + 1} hourly rate (CAD)`, item.rate, (value) => updateLabour({ rate: value as number | null }), { type: "number" })}
          {rationale(`Labour ${index + 1} rationale`, item.appraiserReason, (value) => updateLabour({ appraiserReason: value }))}
          {refSelection(`Labour ${index + 1} evidence`, item.referenceIds, (value) => updateLabour({ referenceIds: value }))}
        </div>{remove(`labour task ${index + 1}`, () => update("labourItems", draft.labourItems.filter((_, position) => position !== index)))}</div>;
      })}</div>}
    </section>
    <section className={styles.section}><div className={styles.sectionHeading}><h2>Other repair charges</h2><button className="app-button" type="button" disabled={disabled || draft.charges.length >= 50}
      onClick={() => update("charges", [...draft.charges, cost("")])}>Add repair charge</button></div>
      <p className={`${styles.muted} mb-3`}>Separate taxes and other charges. A missing category is unknown, not zero.</p>
      <div className={styles.rows}>{draft.charges.map((item, index) => <div key={index} className={styles.row}>
        {costFields(`Charge ${index + 1}`, item, (value) => update("charges", draft.charges.map((row, position) => position === index ? value : row)))}
        {remove(`repair charge ${index + 1}`, () => update("charges", draft.charges.filter((_, position) => position !== index)))}
      </div>)}</div>
    </section>
    <section className={styles.section}><h2>Seller-side recovery deductions</h2><p className={`${styles.muted} mb-3`}>These are seller costs, not buyer fees. Every category must be established, including explicit zero when not applicable.</p>
      <div className={styles.rows}>{(["fees", "transport", "storage", "disposal"] as const).map((key) => <details className={styles.row} key={key}>
        <summary className="cursor-pointer font-semibold">{key[0].toUpperCase() + key.slice(1)} · {draft.sellerCosts[key]?.amount === null || !draft.sellerCosts[key] ? "Not established" : "Entered; save to validate"}</summary>
        <div className="mt-3">{costFields(`Seller ${key}`, draft.sellerCosts[key] || cost(key), (value) => update("sellerCosts", { ...draft.sellerCosts, [key]: value }))}</div>
        {draft.sellerCosts[key] ? remove(`seller ${key} entry`, () => update("sellerCosts", { ...draft.sellerCosts, [key]: null })) : null}
      </details>)}</div>
    </section>
    <section className={styles.section}><h2>Appraiser valuation overrides</h2><p className={`${styles.muted} mb-3`}>Overrides are identified separately from automatic evidence-based conclusions. Document the reason; an override does not manufacture comparables.</p>
      <div className={styles.rows}>{(["preLoss", "asIs"] as const).map((key) => <details key={key} className={styles.row}>
        <summary className="cursor-pointer font-semibold">{key === "preLoss" ? "Pre-loss" : "As-is salvage"} override</summary>
        <div className="mt-3">{costFields(key === "preLoss" ? "Pre-loss override" : "As-is override", draft.overrides[key] || cost(key === "preLoss" ? "Pre-loss override" : "As-is salvage override"), (value) => update("overrides", { ...draft.overrides, [key]: value }))}</div>
        {draft.overrides[key] ? remove(`${key === "preLoss" ? "pre-loss" : "as-is"} override`, () => update("overrides", { ...draft.overrides, [key]: null })) : null}
      </details>)}</div>
    </section>

    <section className={styles.section}><details><summary className="cursor-pointer font-semibold">Appraiser-supplied source evidence ({draft.suppliedReferences.length})</summary>
      <p className={`${styles.muted} my-3`}>Record the actual document or source and exact supporting text. Owner-supplied evidence is attributed to the appraiser, never labelled independently verified web research.</p>
      <button className="app-button mb-3" type="button" disabled={disabled || draft.suppliedReferences.length >= 50} onClick={() => update("suppliedReferences", [...draft.suppliedReferences, { id: id(), kind: "appraiser", url: null, title: "", publisher: null, accessedAt: null, excerpt: "", photoIds: [] }])}>Add evidence reference</button>
      <div className={styles.rows}>{draft.suppliedReferences.map((reference, index) => {
        const change = (patch: Partial<SalvageReference>) => update("suppliedReferences", draft.suppliedReferences.map((row, position) => position === index ? { ...row, ...patch } : row));
        return <div key={reference.id} className={styles.row}><p className={`${styles.muted} mb-2`}>Reference ID: {reference.id}</p><div className={styles.fields}>
          {field(`Reference ${index + 1} title`, reference.title, (value) => change({ title: text(value) }))}
          {select(`Reference ${index + 1} kind`, reference.kind, [["appraiser", "Appraiser-supplied record"], ["photo", "Uploaded document photo"]], (value) => change({ kind: value === "photo" ? "photo" : "appraiser" }))}
          {field(`Reference ${index + 1} publisher`, reference.publisher, (value) => change({ publisher: nullable(text(value)) }))}
          {field(`Reference ${index + 1} source URL`, reference.url, (value) => change({ url: nullable(text(value)) }), { type: "url" })}
          {field(`Reference ${index + 1} accessed date`, reference.accessedAt, (value) => change({ accessedAt: nullable(text(value)) }), { type: "date" })}
          {field(`Reference ${index + 1} supporting text`, reference.excerpt, (value) => change({ excerpt: text(value) }), { type: "textarea", hint: "For a brand document include the exact VIN, brand and province shown on the registration." })}
          {photoSelection(`Reference ${index + 1} uploaded photos`, reference.photoIds, (value) => change({ photoIds: value }))}
        </div>{remove(`reference ${index + 1}`, () => update("suppliedReferences", draft.suppliedReferences.filter((_, position) => position !== index)))}</div>;
      })}</div>
    </details></section>

    <section className={styles.section}><details><summary className="cursor-pointer font-semibold">Appraiser-supplied comparables ({draft.suppliedComparables.length})</summary>
      <p className={`${styles.muted} my-3`}>Record the actual price basis. Current bids and reserves are not completed sales. At least three eligible distinct vehicles of one basis are needed for an automatic conclusion. Foreign currency conversion requires verified Bank of Canada evidence.</p>
      <button className="app-button mb-3" type="button" disabled={disabled || draft.suppliedComparables.length >= 20} onClick={addComparable}>Add supplied comparable</button>
      <div className={styles.rows}>{draft.suppliedComparables.map((comparable, index) => {
        const label = `Comparable ${index + 1}`;
        const change = (patch: Partial<SalvageComparableEvidence>) => changeComparable(index, { ...comparable, ...patch, verification: "appraiser_supplied" });
        const stringField = (key: "title" | "url" | "sourceName" | "listingId" | "vin" | "make" | "model" | "trim" | "powertrain" | "condition" | "brand" | "location" | "country" | "currency", title: string) => field(`${label} ${title}`, comparable[key], (value) => change({ [key]: value === null ? key === "title" ? "" : null : String(value) }), { type: key === "url" ? "url" : key === "condition" ? "textarea" : undefined });
        return <details className={styles.row} key={comparable.id} open><summary className="cursor-pointer font-semibold">{label} — {comparable.title || "New record"}</summary><div className={`${styles.fields} mt-3`}>
          {stringField("title", "title")}{stringField("sourceName", "source name")}{stringField("url", "source URL")}{stringField("listingId", "listing ID")}
          {select(`${label} valuation group`, comparable.basket, [["pre_loss", "Pre-loss market"], ["as_is", "As-is salvage"]], (value) => change({ basket: value === "pre_loss" ? "pre_loss" : "as_is" }))}
          {select(`${label} price basis`, comparable.priceBasis, [["sold", "Documented completed sale"], ["asking", "Advertised asking price"], ["current_bid", "Current bid (not a sale)"], ["reserve", "Reserve (not a sale)"], ["unknown", "Unknown"]], (value) => change({ priceBasis: value as SalvageComparableEvidence["priceBasis"] || "unknown" }))}
          {field(`${label} original price`, comparable.price, (value) => change({ price: value as number | null }), { type: "number" })}{stringField("currency", "original currency")}
          {field(`${label} sale / listing date`, comparable.eventDate, (value) => change({ eventDate: value as string | null }), { type: "date" })}
          {field(`${label} year`, comparable.year, (value) => change({ year: value as number | null }), { type: "number" })}
          {stringField("make", "make")}{stringField("model", "model")}{stringField("trim", "trim")}{stringField("powertrain", "powertrain")}{stringField("vin", "VIN")}
          {field(`${label} odometer`, comparable.odometer, (value) => change({ odometer: value as number | null }), { type: "number" })}
          {select(`${label} odometer unit`, comparable.odometerUnit, [["km", "Kilometres"], ["mi", "Miles"]], (value) => change({ odometerUnit: value as "km" | "mi" | null }))}
          {stringField("condition", "condition / damage")}{stringField("brand", "documented brand")}{stringField("location", "location")}
          {select(`${label} province`, comparable.province, PROVINCES.map((value) => [value, value]), (value) => change({ province: value }))}
          {stringField("country", "country code")}{rationale(`${label} appraiser rationale`, comparable.appraiserReason, (value) => change({ appraiserReason: value }))}
          {refSelection(`${label} source evidence`, comparable.referenceIds, (value) => change({ referenceIds: value }))}
          {photoSelection(`${label} uploaded evidence photos`, comparable.photoIds, (value) => change({ photoIds: value }))}
        </div>
        <details className="mt-3"><summary className="cursor-pointer">Adjustments ({comparable.adjustments.length})</summary>
          {comparable.adjustments.map((adjustment, adjustmentIndex) => {
            const adjustLabel = `${label} adjustment ${adjustmentIndex + 1}`;
            const set = (patch: Partial<SalvageAdjustment>) => change({ adjustments: comparable.adjustments.map((item, position) => position === adjustmentIndex ? { ...item, ...patch } : item) });
            return <div key={adjustmentIndex} className={`${styles.row} mt-2`}><div className={styles.fields}>
              {field(`${adjustLabel} description`, adjustment.description, (value) => set({ description: text(value) }))}
              {field(`${adjustLabel} amount (CAD)`, adjustment.amount, (value) => set({ amount: value as number | null }), { type: "number", allowNegative: true })}
              {rationale(`${adjustLabel} rationale`, adjustment.appraiserReason, (value) => set({ appraiserReason: value }))}
              {refSelection(`${adjustLabel} evidence`, adjustment.referenceIds, (value) => set({ referenceIds: value }))}
            </div>{remove(`${adjustLabel.toLowerCase()}`, () => change({ adjustments: comparable.adjustments.filter((_, position) => position !== adjustmentIndex) }))}</div>;
          })}
          <button className="app-button mt-2" type="button" disabled={disabled || comparable.adjustments.length >= 20} onClick={() => change({ adjustments: [...comparable.adjustments, { description: "", amount: null, referenceIds: [], appraiserReason: null }] })}>Add adjustment for comparable {index + 1}</button>
        </details>{remove(`supplied comparable ${index + 1}`, () => update("suppliedComparables", draft.suppliedComparables.filter((_, position) => position !== index)))}</details>;
      })}</div>
    </details></section>

    <section className={styles.section}><h2>Saved limitations and evidence</h2><p className={`${styles.muted} mb-3`}>Read-only results from the saved revision. They update after a successful save or an explicit research run.</p>
      <ul className="list-disc pl-5 space-y-2">{assessment.limitations.map((limitation) => <li key={limitation.code}><strong>{limitation.severity === "critical" ? "Review required: " : ""}</strong>{salvageSystemText(limitation.message)}{limitation.acknowledgementRequired ? <span className={styles.muted}> (Approval acknowledgement required)</span> : null}</li>)}</ul>
      <details className="mt-4"><summary className="cursor-pointer font-semibold">Investigated comparables ({assessment.candidates.length})</summary>
        <div className={`${styles.rows} mt-3`}>{assessment.candidates.map((candidate) => <details className={styles.row} key={candidate.id}>
          <summary className="cursor-pointer">{candidate.title} · {candidate.selected ? "Selected" : candidate.eligible ? "Eligible, not selected" : "Excluded"}</summary>
          <dl className={`${styles.analysis} mt-3`}>
            <dt>Evidence ID / group</dt><dd>{candidate.id} · {candidate.basket.replaceAll("_", " ")}</dd>
            <dt>Source</dt><dd>{sourceLink(candidate.url, candidate.sourceName || candidate.url || "Appraiser-supplied record")}</dd>
            <dt>Price / basis</dt><dd>{candidate.price !== null && !candidate.currency ? `${candidate.price} (currency unknown)` : formatAssessmentMoney(candidate.price, "en", candidate.currency || "CAD")} · {candidate.priceBasis.replaceAll("_", " ")}</dd>
            <dt>Adjusted CAD</dt><dd>{formatAssessmentMoney(candidate.adjustedPrice)}</dd>
            <dt>Evidence date / location</dt><dd>{candidate.eventDate || "Unknown"} · {candidate.location || "Unknown"} · {candidate.province || candidate.country || "Unknown"}</dd>
            <dt>Vehicle</dt><dd>{[candidate.year, candidate.make, candidate.model, candidate.trim, candidate.powertrain].filter(Boolean).join(" · ") || "Unknown"}</dd>
            <dt>Odometer / condition</dt><dd>{candidate.odometer === null ? "Unknown mileage" : `${candidate.odometer} ${candidate.odometerUnit || "unit unknown"}`} · {candidate.condition || "Unknown condition"}</dd>
            <dt>Evidence references</dt><dd>{candidate.referenceIds.join(", ") || "None"}</dd>
            {candidate.fx ? <><dt>FX observation</dt><dd>1 {candidate.currency} = CAD {candidate.fx.cadPerUnit} · {candidate.fx.date} · {candidate.fx.referenceId}</dd></> : null}
            {candidate.exclusionReasons.length ? <><dt>Why excluded</dt><dd>{candidate.exclusionReasons.join("; ")}</dd></> : null}
          </dl>
          {Object.keys(candidate.evidence).length ? <details className="mt-2"><summary className="cursor-pointer">Quoted field evidence</summary><dl className={`${styles.analysis} mt-2`}>{Object.entries(candidate.evidence).map(([key, value]) => <div className="contents" key={key}><dt>{key}</dt><dd>“{value.quote}” — {value.referenceId}</dd></div>)}</dl></details> : null}
        </details>)}</div>
      </details>
      <details className="mt-4"><summary className="cursor-pointer font-semibold">Saved references ({assessment.references.length})</summary>
        <ol className="list-decimal pl-5 mt-3 space-y-3">{assessment.references.map((reference) => <li key={reference.id}>
          <strong>{reference.id}</strong> · {sourceLink(reference.url, reference.title)}<p className={styles.muted}>{reference.kind === "web" ? "Retrieved web evidence" : "Appraiser-supplied evidence"} · {reference.publisher || "Publisher unspecified"} · Accessed {reference.accessedAt || "date unknown"}{reference.photoIds.length ? ` · ${reference.photoIds.join(", ")}` : ""}</p>
          {reference.excerpt ? <blockquote className="mt-1 whitespace-pre-wrap break-words">{reference.excerpt}</blockquote> : null}
        </li>)}</ol>
      </details>
    </section>
  </div>;
}
