/**
 * Lots Auctioneer 2.0 sends before they have a sale.
 *
 * Owner, 2026-11-05 (Auctioneer 2.0's Bank/Corporate Board): "Allow push to
 * Asset Insight without a sale event. Yes, only from this board". A Bank
 * customer's lot waits there for its sale date; its condition report is done
 * now, and Auctioneer 2.0 numbers the lot when it assigns the sale. Auctioneer
 * 2.0 marks such a task `saleEventPending: true` (GET /tasks/incoming: on the
 * task, its lot and its contract), and only that board can send one.
 *
 * For such work Asset Insight therefore:
 *   - does not allocate an event lot number (there is no event to number it
 *     in): allocateInitialAuctioneerLotNumbers keeps the lot's own number;
 *   - never sends a lot number back (complete-cr, number reconcile), so the
 *     Auctioneer 2.0 number is never replaced by a capture-order "1", a
 *     photographed number or a LOT-#### placeholder.
 *
 * Narrow on purpose: only an Auctioneer 2.0 one-lot ("scheduleA") work item
 * with no event whose every task carries the flag. Ordinary contract,
 * Proposal, Unknown and continuation work has no flagged task, so it keeps the
 * event check unchanged.
 */
import { normalizeAuctioneerEventId } from "../utils/auctioneerEventIdentity.js";

const record = (value: unknown): Record<string, any> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : null;

/** The flag Auctioneer 2.0 puts on a task, at the top or on its lot. */
export function taskIsSaleEventPending(task: unknown): boolean {
  const raw = record(task);
  return raw?.saleEventPending === true || record(raw?.lot)?.saleEventPending === true;
}

/** Whether a work item is a sale-pending lot sent from the Bank/Corporate Board. */
export function isSaleEventPendingWorkItem(work: unknown): boolean {
  const item = record(work);
  if (!item) return false;
  if (item.source !== undefined && item.source !== "auctioneer2") return false;
  if (item.kind !== "scheduleA") return false;
  if (normalizeAuctioneerEventId(record(item.contract)?.eventId)) return false;
  const tasks = Array.isArray(record(item.snapshot)?.tasks) ? (item.snapshot.tasks as unknown[]) : [];
  return tasks.length > 0 && tasks.every(taskIsSaleEventPending);
}

/** Keeps the lot's number; records why no event number was given. */
export function markSaleEventPending(lot: any): any {
  return {
    ...lot,
    analysis_metadata: {
      ...(lot?.analysis_metadata || {}),
      auctioneer_lot_number: { version: 1, source: "sale_event_pending" },
    },
  };
}
