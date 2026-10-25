import {
  ASSET_CONDITION_SELECTION_GROUPS,
  normalizeAssetConditionSelection,
  type AssetConditionSelectionKey,
} from "@/lib/assetConditionSelections";

type Props = {
  lot: any;
  lotIndex: number;
  lotLabel: string;
  variant: "mobile" | "desktop";
  disabled: boolean;
  onChange: (index: number, key: AssetConditionSelectionKey, value: string) => void;
};

/** Native selects keep all required groups reachable without inflating table rows. */
export default function AssetConditionSelectionFields({
  lot, lotIndex, lotLabel, variant, disabled, onChange,
}: Props) {
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-2 rounded-lg border border-[var(--app-border)] bg-[var(--app-panel-alt)] p-2.5">
      <legend className="px-1 text-[11px] font-bold uppercase tracking-wide text-[var(--app-text-muted)]">
        Required selections
      </legend>
      {ASSET_CONDITION_SELECTION_GROUPS.map((group) => {
        const current = normalizeAssetConditionSelection(
          lot?.condition_report_selections?.[group.key],
        );
        const value = group.options.find(
          (option) => normalizeAssetConditionSelection(option) === current,
        ) || "";
        const id = `asset-lot-${lotIndex}-${variant}-${group.key}`;

        return (
          <div key={group.key} className="min-w-0">
            <label htmlFor={id} className="mb-1 block text-[11px] font-semibold text-[var(--app-text-muted)]">
              {group.label}
            </label>
            <select
              id={id}
              aria-label={`${group.label} for lot ${lotLabel}, row ${lotIndex + 1}`}
              value={value}
              onChange={(event) => onChange(lotIndex, group.key, event.target.value)}
              className="min-h-9 w-full min-w-0 rounded-md border border-[var(--app-border)] bg-[var(--app-panel)] px-2 py-1.5 text-xs text-[var(--app-text)] focus:border-[var(--app-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--app-accent)] disabled:opacity-60"
            >
              <option value="" disabled>Select — N/A allowed</option>
              {group.options.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </div>
        );
      })}
    </fieldset>
  );
}
