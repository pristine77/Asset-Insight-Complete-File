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

/** Stop publication before duplicate labels overwrite identity in downstream imports or edits. */
export function assertUniqueInitialLotNumbers(lots: any[]): void {
  const seen = new Set<string>();
  for (const lot of lots) {
    const label = normalizeEditableLotNumber(lot?.lot_number);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate lot number ${label}. Original photos are retained. Review the capture lot numbers before retrying; no lots have been renumbered.`);
    seen.add(key);
  }
}
