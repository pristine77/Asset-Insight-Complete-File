"use client";

import { isSalvageReportEnrichment } from "@/lib/salvageReportEnrichment";
import styles from "./SalvageReportEnrichment.module.css";

/** Read-only shared report content; source claims and calculations remain backend-owned. */
export default function SalvageReportEnrichment({ value, language = "en" }: { value: unknown; language?: string }) {
  if (!isSalvageReportEnrichment(value)) return null;
  const title = language === "fr" ? "Contenu du rapport enregistré" : language === "es" ? "Contenido guardado del informe" : "Saved report content";
  return <section className={styles.content} aria-label={title}><h2>{title}</h2>
    {value.sections.map((section, index) => <details className={styles.section} key={section.id} open={index === 0}>
      <summary>{section.title}</summary><div className={styles.body}>
        {section.paragraphs.map((paragraph, row) => <p key={row}>{paragraph}</p>)}
        {section.tables.map((table, tableIndex) => <div className={styles.tableScroll} role="region" aria-label={`${section.title} — ${tableIndex + 1}`} tabIndex={0} key={tableIndex}>
          <table><caption>{section.title}</caption><thead><tr>{table.headers.map((header, column) => <th scope="col" key={column}>{header}</th>)}</tr></thead>
            <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody>
          </table></div>)}
      </div></details>)}
  </section>;
}
