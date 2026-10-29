/**
 * The mixed_lots field naming the listed Proposal item a lot captures (owner
 * 2026-10-28): its source key, "proposal-line:<line id>". Nothing for any
 * other key, so a path that used to drop source keys still drops every other
 * one and other reports send exactly what they did.
 *
 * Used where mixed_lots is rebuilt from stored lots (the offline queue); the
 * forms and both upload services already pass source_key through. It has no
 * imports so tests that replace other services still get the real one.
 */
export const PROPOSAL_ITEM_SOURCE_PREFIX = 'proposal-line:';

export function proposalItemLotField(sourceKey: unknown): { source_key?: string } {
  return typeof sourceKey === 'string' &&
    sourceKey.startsWith(PROPOSAL_ITEM_SOURCE_PREFIX) &&
    sourceKey.length > PROPOSAL_ITEM_SOURCE_PREFIX.length
    ? { source_key: sourceKey }
    : {};
}
