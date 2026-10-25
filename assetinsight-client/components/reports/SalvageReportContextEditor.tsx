"use client";

import { useId } from "react";
import { SALVAGE_REPORT_CONTEXT_FIELDS, editableSalvageReportContext, type SalvageReportContext } from "@/lib/salvageReportEnrichment";
import styles from "./SalvagePreviewWorkspace.module.css";

const LABELS = {
  en: ["Intended use", "Scope of work", "Valuation premise", "Pre-loss condition", "Inspection basis", "Repair estimate status", "Repair estimate date", "Lead time notes", "Market context", "Reconciliation notes", "Appraiser conclusion", "Client comments"],
  fr: ["Utilisation prévue", "Étendue des travaux", "Hypothèse d’évaluation", "État avant sinistre", "Base de l’inspection", "État du devis de réparation", "Date du devis de réparation", "Notes sur les délais", "Contexte du marché", "Notes de rapprochement", "Conclusion de l’évaluateur", "Commentaires du client"],
  es: ["Uso previsto", "Alcance del trabajo", "Premisa de valoración", "Estado previo al siniestro", "Base de inspección", "Estado de la estimación de reparación", "Fecha de estimación de reparación", "Notas sobre plazos", "Contexto del mercado", "Notas de conciliación", "Conclusión del tasador", "Comentarios del cliente"],
};
export default function SalvageReportContextEditor({ value, language = "en", disabled, onChange }: { value: unknown; language?: string; disabled: boolean; onChange: (value: SalvageReportContext) => void }) {
  const prefix = useId(), context = editableSalvageReportContext(value);
  const locale = language === "fr" || language === "es" ? language : "en";
  const title = locale === "fr" ? "Contexte fourni par l’évaluateur" : locale === "es" ? "Contexto aportado por el tasador" : "Appraiser report context";
  const hint = locale === "fr" ? "Notes facultatives fournies par l’évaluateur, non vérifiées indépendamment. Un champ vide reste inconnu. Enregistrez pour actualiser le rapport; aucune recherche ne démarre."
    : locale === "es" ? "Notas opcionales del tasador, no verificadas de forma independiente. Los campos vacíos permanecen desconocidos. Guarde para actualizar el informe; no se inicia una investigación."
      : "Optional appraiser-supplied notes, not independently verified evidence. Blank fields remain unknown. Save to update the report; no research starts.";
  return <section className={styles.section}><details><summary className="cursor-pointer font-semibold">{title}</summary>
    <p className={`${styles.muted} my-3`}>{hint}</p>
    <div className={styles.fields}>{SALVAGE_REPORT_CONTEXT_FIELDS.map((key, index) => <div className={styles.field} key={key}>
      <label htmlFor={`${prefix}-${key}`}>{LABELS[locale][index]}</label>{key === "repair_estimate_date"
        ? <input id={`${prefix}-${key}`} type="date" value={context[key] || ""} disabled={disabled} onChange={event => { if (!disabled) onChange({ ...context, [key]: event.target.value || null }); }} />
        : <textarea id={`${prefix}-${key}`} rows={3} maxLength={6000} value={context[key] || ""} disabled={disabled} onChange={event => { if (!disabled) onChange({ ...context, [key]: event.target.value || null }); }} />}
    </div>)}</div>
  </details></section>;
}
