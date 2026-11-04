import { normalizeEditableLotNumber } from "../utils/lotNumbers.js";

export type CaptureLotIdentity = { captureLotId?: string; captureLotNumber?: string };

/** Only ordinary capture groups supply this identity. Auction assignments keep their own authority. */
export function readCaptureLotIdentity(group: any): CaptureLotIdentity {
  if (group?.source_key || group?.source_parent_key || group?.source_lot_id || group?.schedule_a_parent_lot_id) return {};
  const id = typeof group?.capture_lot_id === "string" ? group.capture_lot_id.trim() : "";
  const number = typeof group?.capture_lot_number === "string" || typeof group?.capture_lot_number === "number"
    ? normalizeEditableLotNumber(group.capture_lot_number) : "";
  if (!id || id.length > 160 || !number || number.length > 64 || /[\x00-\x1f\x7f]/.test(id + number)) return {};
  return { captureLotId: id, captureLotNumber: number };
}

/** A capture group may expand into several items. Never give every child its parent's number. */
export function applyCaptureLotIdentities(lots: any[], rawGroups: unknown): any[] {
  if (!Array.isArray(rawGroups)) return lots;
  const groups = rawGroups.filter(group => Number(group?.count) > 0);
  const counts = new Map<number, number>();
  for (const lot of lots) {
    const index = Number(lot?.mixed_group_index) - 1;
    if (Number.isInteger(index) && index >= 0) counts.set(index, (counts.get(index) || 0) + 1);
  }
  return lots.map(lot => {
    const index = Number(lot?.mixed_group_index) - 1;
    const identity = readCaptureLotIdentity(groups[index]);
    if (!identity.captureLotId) return lot;
    const oneLot = counts.get(index) === 1 && lot?.analysis_metadata?.bundle_lot_number_detection?.numberSource !== "reviewed_upload";
    const metadata = {
      ...(lot.analysis_metadata || {}),
      capture_lot_identity: { id: identity.captureLotId, number: identity.captureLotNumber, applied: oneLot },
    };
    if (!oneLot) return { ...lot, analysis_metadata: metadata };
    if (metadata.bundle_lot_number_detection) metadata.bundle_lot_number_detection = {
      ...metadata.bundle_lot_number_detection, numberSource: "capture_form", resolvedLotNumber: identity.captureLotNumber,
    };
    return { ...lot, lot_number: identity.captureLotNumber, analysis_metadata: metadata };
  });
}

/**
 * Never two lots with the same number in one report, and never a stopped
 * report because of it (owner, 2026-11-04, choosing "1 and 2").
 *
 * This replaces assertUniqueInitialLotNumbers (3326c72), which stopped the
 * whole report on a repeat: "Duplicate lot number 7 ... no lots have been
 * renumbered", with no saved preview and the draft already gone, so the
 * appraiser had nothing to reopen. A repeat happens when the phone sends a
 * lot's own number beside another lot's position number (lot 3 carries "7"
 * from a lot card, the 7th lot is sent as "7"), or when the AI reads the same
 * number twice.
 *
 * The first lot in capture order keeps its number. A later lot with the same
 * number takes the lowest number no lot in the report uses, and is marked
 * lot_number_dropped { reason: "repeated" }:
 *   - the preview shows it, so the appraiser checks it before submitting;
 *   - on an Auctioneer 2.0 work item it counts as a fallback lot
 *     (initialLotNumberFallbackIndexes), so the sale gives it a free number.
 * The caller's rows are not changed; new rows are returned.
 */
export function renumberRepeatedLotNumbers(lots: any[]): any[] {
  if (!Array.isArray(lots)) return [];
  const used = new Set(
    lots.map((lot) => normalizeEditableLotNumber(lot?.lot_number).toLowerCase()).filter(Boolean)
  );
  const kept = new Set<string>();
  let next = 1;
  const nextFree = () => {
    while (used.has(String(next))) next += 1;
    used.add(String(next));
    return String(next);
  };
  return lots.map((lot) => {
    const label = normalizeEditableLotNumber(lot?.lot_number);
    if (!label) return lot;
    const key = label.toLowerCase();
    if (!kept.has(key)) {
      kept.add(key);
      return lot;
    }
    return {
      ...lot,
      lot_number: nextFree(),
      analysis_metadata: {
        ...(lot.analysis_metadata || {}),
        lot_number_dropped: { version: 1, value: label, reason: "repeated" },
      },
    };
  });
}
