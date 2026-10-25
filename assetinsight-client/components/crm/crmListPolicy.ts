import type { CrmTaskSummary } from "@/services/crm";

/** Matches the backend's legacy Quick Add source classification. */
export function crmSource(task: Pick<CrmTaskSummary, "title" | "leadSource">) {
  return task.leadSource === "organic" || /^quick add/i.test(task.title || "") ? "Organic" : task.leadSource === "generic" ? "Imported" : "Not recorded";
}
