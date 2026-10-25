import { formClassNames, primaryButtonClass, secondaryButtonClass } from "./ui/FormUI";

export default function AuctioneerContinueAction({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex w-full flex-wrap items-center justify-end gap-2 border-t border-[var(--app-border)] pt-3">
      <p className="text-xs leading-5 text-[var(--app-text-muted)]">
        Continue opens a fresh lot after upload acceptance. Review each preview before generating files.
      </p>
      <button
        type="submit"
        className={formClassNames(primaryButtonClass, "w-full sm:w-auto")}
        disabled={disabled}
        title="Create this lot and close this form; the auction contract stays open"
      >
        Create Lot &amp; Close
      </button>
      <button
        type="button"
        className={formClassNames(secondaryButtonClass, "w-full sm:w-auto")}
        disabled={disabled}
        onClick={onClick}
        title="Create this lot, then open a fresh form for the same contract while processing continues"
      >
        Create Lot &amp; Continue
      </button>
    </div>
  );
}
