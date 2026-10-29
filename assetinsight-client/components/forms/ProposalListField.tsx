"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "@/components/ui/toast";
import {
  AuctioneerService,
  type AuctioneerProposalItem,
  type AuctioneerProposalItemState,
  type AuctioneerWorkItemSetup,
} from "@/services/auctioneer";
import type { MixedLot } from "./mixed/types";
import {
  ConfirmDialog,
  FormAlert,
  quietButtonClass,
  secondaryButtonClass,
} from "./ui/FormUI";

/*
   Owner 2026-10-28: a Proposal's list, pushed item by item. The appraiser
   captures each of their listed items as its own lot (returned green), marks
   an item they cannot find as not found instead (returned red, at once), and
   may add lots for items that were not on the list (returned blue). This
   panel shows the user's items, lets them put an item back into the form, and
   returns not-found items. The lots themselves stay in the media workspace.
*/

const STATE_LABELS: Record<Exclude<AuctioneerProposalItemState, "outstanding">, string> = {
  returned: "Returned",
  not_found: "Returned as not found",
  in_other_report: "In another report",
};

function itemLine(item: AuctioneerProposalItem) {
  return [
    item.lotNumber ? `Lot ${item.lotNumber}` : "",
    [item.year, item.make, item.model].filter(Boolean).join(" "),
    item.serialNumber ? `S/N ${item.serialNumber}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function notFoundError(error: unknown) {
  const message = (error as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  return typeof message === "string" && message.trim()
    ? message.trim()
    : "The item could not be returned as not found. Check your connection and try again.";
}

export default function ProposalListField({
  id,
  integration,
  lots,
  onAddItem,
  onItemNotFound,
  disabled,
}: {
  id: string;
  integration: AuctioneerWorkItemSetup;
  lots: MixedLot[];
  /** Puts a listed item back into the form as its own lot. */
  onAddItem: (item: AuctioneerProposalItem) => void;
  /** The item was returned as not found: its lot leaves the form. */
  onItemNotFound: (item: AuctioneerProposalItem) => void;
  disabled?: boolean;
}) {
  // Not-found returns answer with the refreshed list; it replaces the one
  // this form opened with until the form opens again.
  const [items, setItems] = useState<AuctioneerProposalItem[]>(
    integration.proposalList?.items ?? []
  );
  useEffect(() => {
    setItems(integration.proposalList?.items ?? []);
  }, [integration]);
  const [pending, setPending] = useState<AuctioneerProposalItem | null>(null);
  const [busy, setBusy] = useState(false);
  const inForm = useMemo(
    () => new Set(lots.map((lot) => lot.source?.key).filter(Boolean) as string[]),
    [lots]
  );

  if (!items.length) {
    return (
      <div id={id} tabIndex={-1} className="mb-4 outline-none">
        <FormAlert tone="warning" title="Proposal list">
          No item of this Proposal is pushed to you. Lots you add here are returned as items that were not on the list.
        </FormAlert>
      </div>
    );
  }

  const confirmNotFound = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const result = await AuctioneerService.markProposalItemsNotFound(
        integration.workItemId,
        [pending.lineId]
      );
      if (result.setup.proposalList) setItems(result.setup.proposalList.items);
      onItemNotFound(pending);
      toast.success(`${pending.title} was returned to Auctioneer as not found.`);
      setPending(null);
    } catch (error) {
      toast.error(notFoundError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id={id} tabIndex={-1} className="mb-4 outline-none" aria-label="Proposal list">
      <FormAlert tone="info" title="Proposal list">
        Each listed item is one lot. If you cannot find an item, mark it Not found — it is returned to Auctioneer 2.0
        straight away instead of being captured. Lots you add with New lot are returned as items that were not on the
        list.
      </FormAlert>
      <ul className="mt-3 divide-y divide-[var(--app-border)] rounded-lg border border-[var(--app-border)]">
        {items.map((item) => {
          const outstanding = item.state === "outstanding";
          const present = inForm.has(item.sourceKey);
          return (
            <li key={item.lineId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="font-medium text-[var(--app-text)]">{item.title}</div>
                {itemLine(item) ? (
                  <div className="text-xs text-[var(--app-text-muted)]">{itemLine(item)}</div>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                {!outstanding ? (
                  <span className="text-xs text-[var(--app-text-muted)]">
                    {STATE_LABELS[item.state as keyof typeof STATE_LABELS]}
                  </span>
                ) : present ? (
                  <span className="text-xs text-[var(--app-text-muted)]">In this form</span>
                ) : (
                  <button
                    type="button"
                    className={secondaryButtonClass}
                    disabled={disabled || busy}
                    onClick={() => onAddItem(item)}
                  >
                    Add to form
                  </button>
                )}
                {outstanding ? (
                  <button
                    type="button"
                    className={quietButtonClass}
                    disabled={disabled || busy}
                    onClick={() => setPending(item)}
                  >
                    Not found
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={pending !== null}
        title="Return this item as not found?"
        description={
          pending
            ? `${pending.title} will be returned to Auctioneer 2.0 now as not found, and will not be captured.${
                inForm.has(pending.sourceKey) ? " Its lot and any photos in this form are removed." : ""
              }`
            : undefined
        }
        confirmLabel="Return as not found"
        tone="danger"
        busy={busy}
        onConfirm={() => void confirmNotFound()}
        onCancel={() => {
          if (!busy) setPending(null);
        }}
      />
    </section>
  );
}
