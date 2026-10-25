import { describe, expect, it } from "vitest";
import { advanceSalvageProgress, salvageWorkflowSteps } from "../src/service/salvageProgress.js";
import { presentSalvageSnapshot } from "../src/service/salvagePresentation.js";

describe("Salvage processing presentation", () => {
  it("records observed steps without inventing completed stages", () => {
    const first = advanceSalvageProgress(undefined, 10, "Saving original photos");
    const repeated = advanceSalvageProgress(first, 25, "Saving original photos");
    expect(repeated.steps).toHaveLength(1);
    const photos = advanceSalvageProgress(repeated, 32, "Inspecting uploaded photo evidence");
    expect(photos.steps.map(step => step.status)).toEqual(["completed", "active"]);
    const stopped = salvageWorkflowSteps({ job_status: "cancelled", generation_progress: photos });
    expect(stopped.map(step => step.status)).toEqual(["completed", "cancelled"]);
    expect(stopped.some(step => step.key === "research")).toBe(false);
    const done = salvageWorkflowSteps({ job_status: "done", generation_kind: "preview", generation_progress: photos });
    expect(done.at(-1)).toMatchObject({ key: "preview", status: "completed" });
  });
  it("removes provider labels only from system presentation, retaining source quotations and saved diagnostics", () => {
    const source = { analysis_model: "gpt-6-astra", analysis_warning: "AI quality review raised an unverified concern.",
      estimate_warning: "AI-assisted estimates require appraiser verification.", appraiser_comments: "User note about AI equipment",
      assessment: { schemaVersion: 2, limitations: [{ code: "SCOPE", message: "AI-assisted valuation support, not certification." }],
        references: [{ excerpt: "AI source exact quotation" }], research: { model: "gpt-6-astra", calls: [{ model: "gpt-6-astra" }],
          plan: { label: "Unverified AI research notes — not evidence", summary: "Retained research note" } } } };
    const snapshot = structuredClone(source);
    const shown = presentSalvageSnapshot(source);
    expect(shown).not.toHaveProperty("analysis_model"); expect(shown.assessment.research).not.toHaveProperty("model");
    expect(shown.analysis_warning).toBe("quality review raised an unverified concern.");
    expect(shown.estimate_warning).toBe("estimates require appraiser verification.");
    expect(shown.assessment.research.plan.label).toContain("Unverified research notes");
    expect(shown.assessment.references).toEqual(source.assessment.references);
    expect(shown.appraiser_comments).toBe(source.appraiser_comments);
    expect(source).toEqual(snapshot);
  });
});
