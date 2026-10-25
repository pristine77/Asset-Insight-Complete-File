"use client";

import React from "react";
import { Building2, Home, Tractor } from "lucide-react";

export type PropertyType = "agricultural" | "commercial" | "residential";

type Props = {
  value?: PropertyType;
  onChange: (type: PropertyType) => void;
};

const PROPERTY_TYPES = [
  {
    type: "residential" as PropertyType,
    label: "Residential",
    description: "Houses, apartments, condos",
    icon: Home,
    gradient: "from-blue-500 to-blue-600",
    shadow: "shadow-blue-500/40",
    selectedBg: "bg-blue-50",
    selectedBorder: "border-blue-400",
    selectedRing: "ring-blue-200",
    hoverShadow: "hover:shadow-blue-500/30",
  },
  {
    type: "commercial" as PropertyType,
    label: "Commercial",
    description: "Office, retail, industrial",
    icon: Building2,
    gradient: "from-blue-500 to-blue-600",
    shadow: "shadow-blue-500/40",
    selectedBg: "bg-blue-50",
    selectedBorder: "border-blue-400",
    selectedRing: "ring-blue-200",
    hoverShadow: "hover:shadow-blue-500/30",
  },
  {
    type: "agricultural" as PropertyType,
    label: "Agricultural",
    description: "Farmland, ranches, rural",
    icon: Tractor,
    gradient: "from-emerald-500 to-emerald-600",
    shadow: "shadow-emerald-500/40",
    selectedBg: "bg-emerald-50",
    selectedBorder: "border-emerald-400",
    selectedRing: "ring-emerald-200",
    hoverShadow: "hover:shadow-emerald-500/30",
  },
];

export default function PropertyTypeSelector({ value, onChange }: Props) {
  return (
    <section className="space-y-4">
      <div className="text-center">
        <h3 className="text-base font-semibold text-[var(--app-text)]">
          Select Property Type
        </h3>
        <p className="text-xs text-[var(--app-text-muted)] mt-1">
          Choose the type of property you want to appraise
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {PROPERTY_TYPES.map((pt) => {
          const isSelected = value === pt.type;
          const Icon = pt.icon;
          return (
            <button
              key={pt.type}
              type="button"
              onClick={() => onChange(pt.type)}
              className={`
                group relative rounded-lg p-5 text-center transition-all duration-200 ease-out
                ${
                  isSelected
                    ? `${pt.selectedBg} ${pt.selectedBorder} border ring-4 ${pt.selectedRing} shadow-sm translate-y-0`
                    : `bg-[var(--app-panel)] border border-[var(--app-border)] shadow-md hover:shadow-sm ${pt.hoverShadow} hover:-translate-y-1 active:translate-y-0`
                }
              `}
            >
              {/* 3D bottom shadow effect */}
              <div
                className={`
                  absolute inset-x-2 -bottom-1 h-2 rounded-b-2xl transition-all duration-200
                  ${
                    isSelected
                      ? `bg-[var(--app-panel)] ${pt.gradient} opacity-30`
                      : "bg-gray-200 group-hover:bg-gray-300"
                  }
                `}
                style={{ zIndex: -1 }}
              />
              
              {/* Icon container with gradient */}
              <div
                className={`
                  mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-xl
                  transition-all duration-200 ease-out
                  ${
                    isSelected
                      ? `bg-[var(--app-panel)] ${pt.gradient} text-white shadow-sm ${pt.shadow}`
                      : "bg-[var(--app-panel-alt)] text-[var(--app-text-muted)] group-hover:bg-gray-200 group-hover:scale-105"
                  }
                `}
              >
                <Icon className="h-7 w-7" strokeWidth={2} />
              </div>
              
              {/* Label */}
              <div
                className={`font-semibold text-sm transition-colors ${
                  isSelected ? "text-[var(--app-text)]" : "text-[var(--app-text-muted)]"
                }`}
              >
                {pt.label}
              </div>
              
              {/* Description */}
              <div className="mt-1 text-xs text-[var(--app-text-muted)]">{pt.description}</div>
              
              {/* Selected indicator */}
              {isSelected && (
                <div
                  className={`
                    absolute -top-1 -right-1 h-5 w-5 rounded-full
                    bg-[var(--app-panel)] ${pt.gradient} text-white
                    flex items-center justify-center shadow-md
                  `}
                >
                  <svg
                    className="h-3 w-3"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={3}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                </div>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
