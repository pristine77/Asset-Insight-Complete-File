/**
 * The mixed_lots field naming the Schedule A item a lot belongs to (owner
 * 2026-10-28): the Auctioneer parent lot of the item the appraiser chose.
 * Nothing when none was chosen, so other reports send exactly what they did.
 *
 * Every path that builds or rebuilds mixed_lots (the two forms, both upload
 * services and the offline queue) uses this, so the field is never dropped on
 * its way to the server, which refuses a Schedule A lot without it. It has no
 * imports so tests that replace other services still get the real one.
 */
export function scheduleAItemLotField(parentLotId: unknown): { schedule_a_parent_lot_id?: string } {
  return typeof parentLotId === 'string' && parentLotId ? { schedule_a_parent_lot_id: parentLotId } : {};
}
