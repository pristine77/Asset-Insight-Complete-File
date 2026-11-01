"use client";

import React from "react";
import { Building2, Check, Home, Tractor } from "lucide-react";

export type PropertyType = "agricultural" | "commercial" | "residential";

type Props = {
  value?: PropertyType;
  onChange: (type: PropertyType) => void;
};

const PROPERTY_TYPES = [
  { type: "residential" as PropertyType, label: "Residential", description: "Houses, apartments, condos", icon: Home },
  { type: "commercial" as PropertyType, label: "Commercial", description: "Office, retail, industrial", icon: Building2 },
  { type: "agricultural" as PropertyType, label: "Agricultural", description: "Farmland, ranches, rural", icon: Tractor },
];

/*
   Three choices in one row, the chosen one outlined and ticked (owner,
   2026-11-01: "professional and easy usability"). A radio group, so the
   keyboard and screen readers treat it as one choice. The selected icon used
   white on a white tile after the gradients were flattened; it now uses the
   accent colour.
*/
export default function PropertyTypeSelector({ value, onChange }: Props) {
  return (
    <div role="radiogroup" aria-label="Property type" className="grid gap-2.5 sm:grid-cols-3">
      {PROPERTY_TYPES.map((pt) => {
        const isSelected = value === pt.type;
        const Icon = pt.icon;
        return (
          <button
            key={pt.type}
            type="button"
            role="radio"
            aria-checked={isSelected}
            onClick={() => onChange(pt.type)}
            className={`flex min-w-0 items-center gap-3 rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent-ring)] ${
              isSelected
                ? "border-[var(--app-accent)] bg-[var(--app-accent-soft)]"
                : "border-[var(--app-border)] bg-[var(--app-panel)] hover:border-[var(--app-control-border-hover)] hover:bg-[var(--app-panel-alt)]"
            }`}
          >
            <span
              className={`grid size-10 shrink-0 place-items-center rounded-lg ${
                isSelected ? "bg-[var(--app-accent)] text-[var(--app-on-accent)]" : "bg-[var(--app-panel-alt)] text-[var(--app-text-muted)]"
              }`}
              aria-hidden="true"
            >
              <Icon className="size-5" strokeWidth={2} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-[var(--app-text-strong)]">{pt.label}</span>
              <span className="block text-xs text-[var(--app-text-muted)]">{pt.description}</span>
            </span>
            {isSelected ? <Check className="size-4 shrink-0 text-[var(--app-accent)]" aria-hidden="true" /> : null}
          </button>
        );
      })}
    </div>
  );
}
