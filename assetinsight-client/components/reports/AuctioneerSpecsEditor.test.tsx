import React, { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import AuctioneerSpecsEditor from "./AuctioneerSpecsEditor";
import { applyPreviewSpecEdit } from "@/lib/previewSpecEdits";

const baseProps = {
  lot: {
    title: "Mack Dump Truck",
    categories: "Trucks",
    specifications: [],
  },
  lotIndex: 0,
  specsByCategory: new Map(),
  onChange: vi.fn(),
  onDelete: vi.fn(),
  includeDamageAnalysis: true,
  damageAnalysis: "",
  onDamageAnalysisChange: vi.fn(),
};

describe("AuctioneerSpecsEditor Damage Analysis policy", () => {
  it("renders the Damages editor for an eligible lot", () => {
    render(<AuctioneerSpecsEditor {...baseProps} damageEligible />);

    expect(screen.getByText("Damages")).toBeInTheDocument();
    expect(screen.queryByText("Damage Analysis not required")).not.toBeInTheDocument();
  });

  it("renders the corrected exclusion notice for a lot above 1000", () => {
    render(<AuctioneerSpecsEditor {...baseProps} damageEligible={false} />);

    expect(screen.getByText("Damage Analysis not required")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This lot is above 1000, so Damage Analysis is excluded from the report and generated files."
      )
    ).toBeInTheDocument();
  });
});

describe('reviewed spec authority', () => {
  const category = { parentCategory: 'Assets', childCategory: 'Equipment', fields: ['Overall Length', 'Overall Width', 'Overall Height'] };
  const categories = new Map([['equipment', category]]);

  it.each(['Scratches visible on left side', 'Serial label is not visible under the panel', 'Visible wear and damage'])('preserves narrative text on opening and saving: %s', value => {
    const changed = vi.fn();
    render(<AuctioneerSpecsEditor {...baseProps} lot={{ condition_report_specs_reviewed: true, condition_report_specs: { Notes: value } }} onChange={changed} />);
    fireEvent.click(screen.getByRole('button', { name: value }));
    expect(screen.getByPlaceholderText('Edit the full field value')).toHaveValue(value);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(changed).toHaveBeenCalledWith(0, 'Notes', value);
  });

  it('keeps explicit blanks and meaningful missing labels editable after review', () => {
    render(<AuctioneerSpecsEditor {...baseProps} lot={{ categories: 'Equipment', condition_report_specs_reviewed: true,
      condition_report_specs: { 'Overall Length': '', Notes: 'N/A' } }} specsByCategory={categories} />);
    expect(screen.getByRole('button', { name: 'Remove Overall Length' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'N/A' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Overall Width' })).not.toBeInTheDocument();
  });

  it('does not recreate cleared rows after reopen or category changes', () => {
    const lot = { categories: 'Equipment', condition_report_specs_reviewed: true, condition_report_specs: {} };
    const { rerender } = render(<AuctioneerSpecsEditor {...baseProps} lot={lot} specsByCategory={categories} />);
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
    rerender(<AuctioneerSpecsEditor {...baseProps} lot={{ ...lot, categories: 'Other' }} specsByCategory={new Map([['other', { ...category, fields: ['Weight', 'Fuel'] }]])} />);
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Add field' })).toBeInTheDocument();
  });

  it('deletes every spec and explicitly re-adds a field without restoring stale values', () => {
    function Editor() {
      const [lot, setLot] = useState<any>({ categories: 'Equipment', condition_report_specs_reviewed: true,
        condition_report_specs: { Length: '10 ft' }, condition_report_specs_manual_overrides: { Length: 'old length' } });
      return <><AuctioneerSpecsEditor {...baseProps} lot={lot} specsByCategory={categories}
        onChange={(_, field, value) => setLot((current: any) => applyPreviewSpecEdit(current, field, value, category.fields))}
        onDelete={(_, field) => setLot((current: any) => applyPreviewSpecEdit(current, field, '', category.fields, { deleted: true }))}
        onAdd={(_, field, value) => setLot((current: any) => applyPreviewSpecEdit(current, field, value, category.fields, { added: true }))} />
        <output data-testid="reviewed-lot">{JSON.stringify(lot)}</output></>;
    }
    render(<Editor />);
    expect(screen.queryByRole('button', { name: 'Remove Length' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Overall Length' }));
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
    expect(JSON.parse(screen.getByTestId('reviewed-lot').textContent!).condition_report_specs).toEqual({});
    fireEvent.click(screen.getByRole('button', { name: '+ Add field' }));
    fireEvent.change(screen.getByPlaceholderText('Example: Engine Hours'), { target: { value: 'Length' } });
    fireEvent.change(screen.getByPlaceholderText('Edit the full field value'), { target: { value: '14 ft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('button', { name: '14 ft' })).toBeInTheDocument();
    const edited = JSON.parse(screen.getByTestId('reviewed-lot').textContent!);
    expect(edited.condition_report_specs_manual_overrides).toEqual({ Length: '14 ft' });
    expect(edited.condition_report_specs_deleted).toEqual([]);
  });

  it('keeps explicitly distinct registry dimension fields and working dimensions separate', () => {
    render(<AuctioneerSpecsEditor {...baseProps} lot={{ categories: 'Equipment', condition_report_specs_reviewed: true,
      condition_report_specs: { Length: '10 ft', 'Overall Length': '12 ft', 'Working Width': '8 ft' } }}
      specsByCategory={new Map([['equipment', { ...category, fields: ['Length', 'Overall Length', 'Working Width'] }]])} />);
    for (const field of ['Length', 'Overall Length', 'Working Width']) expect(screen.getByRole('button', { name: `Remove ${field}` })).toBeInTheDocument();
  });
});
