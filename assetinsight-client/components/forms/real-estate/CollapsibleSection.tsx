"use client";

import { Check, AlertCircle } from "lucide-react";

interface CollapsibleSectionProps {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
  filledCount?: number;
  totalCount?: number;
  variant?: "default" | "success" | "warning" | "info";
  required?: boolean;
}

export default function CollapsibleSection({
  title,
  icon,
  children,
  filledCount = 0,
  totalCount = 0,
  variant = "default",
  required = false,
}: CollapsibleSectionProps) {
  const isComplete = totalCount > 0 && filledCount === totalCount;
  const hasPartial = filledCount > 0 && filledCount < totalCount;

  const variantStyles = {
    default: "border-[var(--app-border)] bg-[var(--app-panel)] from-white via-gray-50/60 to-gray-100/80",
    success: "border-emerald-300/90 bg-[var(--app-panel)] from-emerald-50/40 via-white to-emerald-100/50",
    warning: "border-amber-300/90 bg-[var(--app-panel)] from-amber-50/40 via-white to-amber-100/50",
    info: "border-blue-300/90 bg-[var(--app-panel)] from-blue-50/40 via-white to-blue-100/50",
  };

  return (
    <div className={`rounded-xl border shadow-sm overflow-hidden ${variantStyles[variant]}`}>
      {/* Header - Always visible, not clickable */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-[var(--app-panel)] from-gray-100/90 via-gray-50/70 to-white/80 border-b-2 border-[var(--app-border)] shadow-sm">
        <div className="flex items-center gap-2 min-w-0">
          <span className="flex-shrink-0 text-[var(--app-text-muted)] [&>svg]:h-4 [&>svg]:w-4 drop-shadow-sm">{icon}</span>
          <span className="font-semibold text-sm text-[var(--app-text)] truncate">{title}</span>
          {required && (
            <span className="flex-shrink-0 text-[9px] font-medium text-blue-500 bg-blue-50 px-1 py-0.5 rounded shadow-sm">
              *
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {totalCount > 0 && (
            <>
              {isComplete ? (
                <span className="flex items-center gap-0.5 text-[10px] font-medium text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded-full shadow-sm">
                  <Check className="h-2.5 w-2.5" />
                  Complete
                </span>
              ) : hasPartial ? (
                <span className="text-[10px] font-medium text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded-full shadow-sm">
                  {filledCount}/{totalCount}
                </span>
              ) : (
                <span className="flex items-center gap-0.5 text-[10px] font-medium text-[var(--app-text-muted)] bg-[var(--app-panel-alt)] px-1.5 py-0.5 rounded-full shadow-sm">
                  <AlertCircle className="h-2.5 w-2.5" />
                  {totalCount} fields
                </span>
              )}
            </>
          )}
        </div>
      </div>

      {/* Content - Always expanded */}
      <div className="px-4 py-4 bg-[var(--app-panel)] from-transparent to-gray-50/30">{children}</div>
    </div>
  );
}
