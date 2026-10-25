"use client";

import { useId } from "react";
import type { SalvageVehicleDetails as VehicleDetails, SalvageVehicleField } from "@/lib/salvageAssessment";
import styles from "./SalvagePreviewWorkspace.module.css";

type Props = {
  details: VehicleDetails;
  overrides?: Record<string, string | null>;
  disabled: boolean;
  onChange: (overrides: Record<string, string | null>) => void;
  onViewPhoto?: (index: number) => void;
  photoCount?: number;
};

function photoIndex(photoId: string, count: number): number | null {
  const match = /^photo-(\d+)$/.exec(photoId);
  if (!match) return null;
  const index = Number(match[1]) - 1;
  return Number.isInteger(index) && index >= 0 && index < count ? index : null;
}

/** Workbook labels define the field list; only saved evidence or owner edits supply values. */
export default function SalvageVehicleDetails({ details, overrides = {}, disabled, onChange, onViewPhoto, photoCount = 0 }: Props) {
  const prefix = useId();
  const effective = (field: SalvageVehicleField) => Object.hasOwn(overrides, field.key) ? overrides[field.key] : field.value;
  const manual = (field: SalvageVehicleField) => Object.hasOwn(overrides, field.key) || field.status === "manual";
  const missing = details.fields.filter((field) => !effective(field)).length;
  const renderField = (field: SalvageVehicleField) => {
    const inputId = `${prefix}-${encodeURIComponent(field.key)}`;
    const value = effective(field) ?? "";
    const selectOptions = field.key === "odometerUnit" ? ["km", "mi"] : field.type === "checkbox" ? ["Yes", "No"] : field.key === "category" ? field.options || [] : [];
    const options = [...new Set([...selectOptions, ...(value && !selectOptions.includes(value) ? [value] : [])])];
    const status = manual(field) ? value ? "User entered" : "Cleared by user"
      : field.status === "conflict" ? "Conflicting image evidence — review required"
        : !value || field.status === "unknown" ? "Cannot find from image" : "Read from image";
    const change = (raw: string) => {
      if (!disabled) onChange({ ...overrides, [field.key]: raw === "" ? null : raw });
    };
    return <div key={field.key} className={styles.vehicleField}>
      <label className={styles.field} htmlFor={inputId}>
        <span className={styles.vehicleLabel}>{field.label}</span>
        {selectOptions.length > 0 ? <select id={inputId} value={value} disabled={disabled} aria-describedby={`${inputId}-status`} onChange={(event) => change(event.target.value)}>
          <option value="">Cannot find from image</option>{options.map((option) => <option value={option} key={option}>{field.key === "odometerUnit" ? option === "km" ? "Kilometres (km)" : option === "mi" ? "Miles (mi)" : option : option}</option>)}
        </select> : <input id={inputId} value={value} disabled={disabled} placeholder="Cannot find from image"
          aria-describedby={`${inputId}-status`} maxLength={field.key === "vin" ? 17 : 1000}
          list={field.options?.length ? `${inputId}-options` : undefined}
          inputMode={field.type === "number" || field.key === "year" || field.key === "odometer" ? "decimal" : "text"}
          autoCapitalize={field.key === "vin" || field.key === "serialNumber" ? "characters" : "sentences"}
          spellCheck={field.key === "vin" || field.key === "serialNumber" ? false : undefined}
          onChange={(event) => change(field.key === "vin" ? event.target.value.toUpperCase() : event.target.value)} />}
        {!selectOptions.length && field.options?.length ? <datalist id={`${inputId}-options`}>{field.options.map((option) => <option key={option} value={option} />)}</datalist> : null}
      </label>
      <p id={`${inputId}-status`} className={`${styles.vehicleStatus} ${!manual(field) && field.status === "conflict" ? styles.vehicleConflict : ""}`}>{status}</p>
      {field.key === "category" && Object.hasOwn(overrides, field.key) && overrides[field.key] !== details.category ? <p className={styles.vehicleStatus}>Save to update the vehicle-type specification fields. Saving does not run paid research.</p> : null}
      {field.evidence.length > 0 ? <details className={styles.vehicleEvidence}>
        <summary>Image evidence ({field.evidence.length})</summary>
        <ul>{field.evidence.map((source, index) => {
          const originalIndex = photoIndex(source.photoId, photoCount);
          return <li key={`${source.photoId}-${index}`}>
            {onViewPhoto && originalIndex !== null ? <button type="button" className={styles.evidencePhotoButton}
              aria-label={`View photo ${originalIndex + 1} for ${field.label}`} onClick={() => onViewPhoto(originalIndex)}>Photo {originalIndex + 1}</button>
              : <span>{source.photoId}</span>}
            <span> — {source.evidence || source.value}</span>
            {!source.accepted ? <p>Not accepted: {source.rejectionReason || "Insufficient readable evidence"}</p> : null}
          </li>;
        })}</ul>
      </details> : null}
    </div>;
  };
  const core = details.fields.filter((field) => !field.key.startsWith("spec:"));
  const specific = details.fields.filter((field) => field.key.startsWith("spec:"));
  return <section className={styles.section} aria-labelledby={`${prefix}-heading`}>
    <div className={styles.sectionHeading}><h2 id={`${prefix}-heading`}>Vehicle details from photos</h2><span className={styles.muted}>{missing} of {details.fields.length} fields not established</span></div>
    <p className={`${styles.muted} mb-3`}>Only readable photo evidence is filled automatically. Check the VIN / serial plate, engine and odometer details. Add missing values or correct a reading here; your changes are labelled “User entered”.</p>
    {details.warnings.length ? <ul className={`${styles.notice} mb-3`} aria-label="Vehicle evidence warnings">{details.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : null}
    <div className={styles.vehicleFields}>{core.map(renderField)}</div>
    {specific.length ? <div className={styles.vehicleSpecs}><h3>Vehicle-type specifications{details.category ? ` · ${details.category}` : ""}</h3>
      <p className={`${styles.muted} mb-3`}>Fields follow the vehicle catalogue. The catalogue does not supply or infer values.</p>
      <div className={styles.vehicleFields}>{specific.map(renderField)}</div></div> : null}
  </section>;
}
