"use client";

import { isSalvageReportEnrichment } from "@/lib/salvageReportEnrichment";
import { memo } from "react";
import styles from "./SalvageReportEnrichment.module.css";

/** Render saved backend strings only: no regenerated claims, arithmetic or HTML. */
function SalvageReportEnrichment({ value, language = "en", dirty = false }: { value: unknown; language?: string; dirty?: boolean }) {
  if (!isSalvageReportEnrichment(value)) return null;
  const copy = language === "fr" ? ["Contenu du rapport enregistré", "Ces sections proviennent de la révision enregistrée. Enregistrez vos modifications pour les actualiser.", "Tableau"]
    : language === "es" ? ["Contenido guardado del informe", "Estas secciones corresponden a la revisión guardada. Guarde los cambios para actualizarlas.", "Tabla"]
      : ["Saved report content", "These sections reflect the saved revision. Save changes to refresh them.", "Table"];
  return <section className={styles.content} aria-label={copy[0]}>
    <h2>{copy[0]}</h2><p className={styles.hint} role={dirty ? "status" : undefined}>{copy[1]}</p>
    {value.sections.map((section, sectionIndex) => <details className={styles.section} key={section.id} open={sectionIndex === 0}>
      <summary>{section.title}</summary><div className={styles.body}>
        {section.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
        {section.tables.map((table, index) => <div className={styles.tableScroll} role="region" aria-label={`${section.title} — ${copy[2]} ${index + 1}`} tabIndex={0} key={index}>
          <table><caption>{section.title}</caption><thead><tr>{table.headers.map((header, column) => <th scope="col" key={column}>{header}</th>)}</tr></thead>
            <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody>
          </table></div>)}
      </div></details>)}
  </section>;
}
export default memo(SalvageReportEnrichment);
