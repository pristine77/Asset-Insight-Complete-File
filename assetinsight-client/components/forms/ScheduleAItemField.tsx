import type { AuctioneerScheduleAChoice } from "@/services/auctioneer";
import { SCHEDULE_A_NO_CHOICES_MESSAGE } from "./auctioneerSeed";
import { FormAlert, FormField, formSelectClass } from "./ui/FormUI";

/**
 * The required "Schedule A item" choice on a work item whose lots must name
 * one (owner 2026-10-28). The choice covers every lot in the form.
 *
 * With nothing to choose from — no item on the contract is ticked "Several
 * lots" — the owner's explanation replaces the picker, since the appraiser
 * cannot fix that here; the office ticks it in Auctioneer 2.0.
 */
export default function ScheduleAItemField({
  id,
  choices,
  value,
  onChange,
  error,
  disabled,
}: {
  id: string;
  choices: AuctioneerScheduleAChoice[];
  value: string;
  onChange: (parentLotId: string) => void;
  error?: string;
  disabled?: boolean;
}) {
  if (!choices.length) {
    return (
      // Focus target for the form's validation, like the field it replaces.
      <div id={id} tabIndex={-1} className="mb-4 outline-none">
        <FormAlert tone={error ? "error" : "warning"} title="Schedule A item">
          {SCHEDULE_A_NO_CHOICES_MESSAGE}
        </FormAlert>
      </div>
    );
  }

  return (
    <FormField
      id={id}
      label="Schedule A item"
      required
      hint="Every lot in this form is sent against the item you choose."
      error={error}
      className="mb-4"
    >
      <select
        className={formSelectClass}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Choose a Schedule A item</option>
        {choices.map((choice) => (
          <option key={choice.parentLotId} value={choice.parentLotId}>
            {choice.title}
          </option>
        ))}
      </select>
    </FormField>
  );
}
