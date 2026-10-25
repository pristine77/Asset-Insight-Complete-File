export type SalvageWorkflowStep = {
  key: string;
  label: string;
  status: "pending" | "active" | "completed" | "error" | "cancelled";
};

const labels: Record<string, string> = {
  queued: "Waiting to start",
  originals: "Saving original photos",
  photos: "Inspecting uploaded photo evidence",
  research: "Researching the Canadian market",
  review: "Calculating values and reviewing evidence",
  preview: "Preview available",
  pdf: "Creating PDF report",
  docx: "Creating Word report",
  xlsx: "Creating Excel workbook",
  images: "Packing original photos",
  publish: "Publishing complete file set",
  complete: "Files ready for approval",
};

function keyFor(label: string): string {
  if (label === "Saving original photos") return "originals";
  if (label === "Inspecting uploaded photo evidence") return "photos";
  if (/Planning Canadian|Researching |Verifying repair/.test(label)) return "research";
  if (/Calculating |assessment ready|valuation review/i.test(label)) return "review";
  if (/Creating PDF/.test(label)) return "pdf";
  if (/Creating Word/.test(label)) return "docx";
  if (/Creating Excel/.test(label)) return "xlsx";
  if (/Packing original/.test(label)) return "images";
  if (/Publishing complete/.test(label)) return "publish";
  return "review";
}

/** A history of observed stages, never a guessed checklist of verified evidence. */
export function advanceSalvageProgress(previous: any, percent: number, label: string) {
  const key = keyFor(label);
  const steps: SalvageWorkflowStep[] = (Array.isArray(previous?.steps) ? previous.steps : [])
    .filter((step: any) => labels[step.key])
    .map((step: SalvageWorkflowStep) => ({ key: step.key, label: labels[step.key], status: step.key === key ? "active" : "completed" }));
  if (!steps.some(step => step.key === key)) steps.push({ key, label: labels[key], status: "active" });
  return { percent: Math.max(0, Math.min(99, percent)), message: labels[key], steps };
}

export function salvageWorkflowSteps(report: any): SalvageWorkflowStep[] {
  const busy = ["queued", "processing"].includes(report.job_status) || report.files_generating === true;
  const cancelled = report.job_status === "cancelled";
  const failed = ["error", "failed"].includes(report.job_status);
  const stored = Array.isArray(report.generation_progress?.steps) ? report.generation_progress.steps : [];
  const steps: SalvageWorkflowStep[] = stored.filter((step: any) => labels[step.key]).map((step: any) => ({
    key: step.key, label: labels[step.key], status: step.status === "completed" ? "completed"
      : cancelled ? "cancelled" : failed ? "error" : busy ? "active" : "completed",
  }));
  if (!steps.length && (busy || cancelled || failed)) {
    steps.push({ key: "queued", label: labels.queued, status: cancelled ? "cancelled" : failed ? "error" : "active" });
  }
  if (!busy && !cancelled && !failed) {
    const key = report.generation_kind === "files" ? "complete" : "preview";
    steps.push({ key, label: labels[key], status: "completed" });
  }
  return steps;
}
