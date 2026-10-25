import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SalvageReportEnrichment from "./SalvageReportEnrichment";
import SalvageReportContextEditor from "./SalvageReportContextEditor";
import { editableSalvageReportContext, isSalvageReportEnrichment } from "@/lib/salvageReportEnrichment";

const enrichment = { schemaVersion: 1, sections: [{ id: "executive-summary", title: "Executive summary", paragraphs: ["Incomplete evidence. Appraiser review required."],
  tables: [{ headers: ["Measure", "Saved value"], rows: [["Net recovery", "Not established"], ["Repair subtotal", "CAD 0.00 (documented)"]] }] },
  { id: "photo-findings", title: "Photo finding index", paragraphs: ["photo-001 was not analyzed"], tables: [] }] };

describe("Saved Salvage report enrichment", () => {
  it("renders canonical tables and unknowns without manufacturing numbers or executing markup", () => {
    render(<SalvageReportEnrichment value={enrichment} />);
    expect(screen.getByRole("region", { name: "Saved report content" })).toHaveTextContent("Incomplete evidence.");
    expect(screen.getByRole("table")).toHaveTextContent("Not established");
    expect(screen.getByRole("table")).toHaveTextContent("CAD 0.00 (documented)");
    fireEvent.click(screen.getByText("Photo finding index", { exact: true }));
    expect(screen.getByText("photo-001 was not analyzed")).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
  it("supports localized backend section titles and rejects malformed versions", () => {
    const { rerender, container } = render(<SalvageReportEnrichment language="fr" value={{ schemaVersion: 1, sections: [{ id: "summary", title: "Résumé", paragraphs: ["<script>alert(1)</script>"], tables: [] }] }} />);
    expect(screen.getByRole("heading", { name: "Contenu du rapport enregistré" })).toBeVisible();
    expect(screen.getByText("<script>alert(1)</script>")).toBeVisible();
    expect(container.querySelector("script")).toBeNull();
    rerender(<SalvageReportEnrichment value={{ ...enrichment, schemaVersion: 99 }} />);
    expect(container).toBeEmptyDOMElement();
    expect(isSalvageReportEnrichment({ schemaVersion: 1, sections: [{ title: "Missing fields" }] })).toBe(false);
  });
  it("keeps appraiser context separate, retains omitted keys and explicitly clears notes", () => {
    const changed = vi.fn();
    render(<SalvageReportContextEditor value={{ intended_use: "Insurance review", market_context: "Owner supplied" }} disabled={false} onChange={changed} />);
    fireEvent.click(screen.getByText("Appraiser report context", { exact: true }));
    expect(screen.getByText(/not independently verified evidence/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("Intended use", { exact: true }), { target: { value: "" } });
    expect(changed).toHaveBeenLastCalledWith({ intended_use: null, market_context: "Owner supplied" });
    fireEvent.change(screen.getByLabelText("Repair estimate date"), { target: { value: "2026-09-09" } });
    expect(changed).toHaveBeenLastCalledWith({ intended_use: "Insurance review", market_context: "Owner supplied", repair_estimate_date: "2026-09-09" });
    expect(editableSalvageReportContext({ intended_use: "", appraiser_conclusion: null, status: "approved", scope_of_work: 0 })).toEqual({ intended_use: "", appraiser_conclusion: null });
  });
  it("disables context edits and retains multilingual labels", () => {
    render(<SalvageReportContextEditor language="es" value={{}} disabled onChange={vi.fn()} />);
    fireEvent.click(screen.getByText("Contexto aportado por el tasador", { exact: true }));
    expect(screen.getByLabelText("Uso previsto")).toBeDisabled();
    expect(screen.getByLabelText("Conclusión del tasador")).toHaveAttribute("maxlength", "6000");
  });
});
