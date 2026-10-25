import { enforceLotDamageAnalysisPolicy } from "../../utils/lotDamagePolicy.js";

function cleanString(value: unknown): string {
  return String(value ?? "").trim();
}

function stableLotId(lot: any): string {
  return cleanString(lot?.lot_id || lot?.id || lot?._id);
}

function countStableIds(lots: any[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const lot of lots) {
    const stableId = stableLotId(lot);
    if (stableId) counts.set(stableId, (counts.get(stableId) || 0) + 1);
  }
  return counts;
}

/**
 * Re-applies user-owned preview fields after generated enrichment.
 *
 * Stable ids are used only when they are unique on both sides. AI-created and
 * stock-photo lots can share an id; positional fallback keeps those sibling
 * lots from all receiving the final sibling's lot number and description.
 */
export function restoreEditedLotFields(lots: any[], sourceLots: any[]): any[] {
  if (!Array.isArray(lots) || lots.length === 0 || !Array.isArray(sourceLots)) {
    return lots;
  }

  const sourceIdCounts = countStableIds(sourceLots);
  const generatedIdCounts = countStableIds(lots);
  const sourceByUniqueId = new Map<string, any>();
  sourceLots.forEach((sourceLot) => {
    const stableId = stableLotId(sourceLot);
    if (stableId && sourceIdCounts.get(stableId) === 1) {
      sourceByUniqueId.set(stableId, sourceLot);
    }
  });

  return lots.map((lot, index) => {
    if (!lot || typeof lot !== "object") return lot;
    const stableId = stableLotId(lot);
    const canMatchByUniqueId =
      Boolean(stableId) &&
      sourceIdCounts.get(stableId) === 1 &&
      generatedIdCounts.get(stableId) === 1;
    const sourceLot =
      (canMatchByUniqueId ? sourceByUniqueId.get(stableId) : undefined) ||
      sourceLots[index];
    const editedLotNumber = cleanString(sourceLot?.lot_number);
    const editedLotId = cleanString(sourceLot?.lot_id);
    const hasEditedDescription =
      Object.prototype.hasOwnProperty.call(sourceLot || {}, "description") &&
      sourceLot?.description !== undefined &&
      sourceLot?.description !== null;
    const hasEditedDamageAnalysis = Object.prototype.hasOwnProperty.call(
      sourceLot || {},
      "damage_analysis"
    );

    const restoredLot = {
      ...lot,
      ...(editedLotId ? { lot_id: editedLotId } : {}),
      ...(editedLotNumber ? { lot_number: editedLotNumber } : {}),
      ...(hasEditedDescription ? { description: sourceLot.description } : {}),
      ...(hasEditedDamageAnalysis ? { damage_analysis: sourceLot.damage_analysis } : {}),
      ...(sourceLot?.condition_report_specs
        ? { condition_report_specs: sourceLot.condition_report_specs }
        : {}),
      ...(sourceLot?.condition_report_specs_reviewed === true
        ? { condition_report_specs_reviewed: true } : {}),
      ...(sourceLot?.condition_report_specs_manual_overrides
        ? { condition_report_specs_manual_overrides: sourceLot.condition_report_specs_manual_overrides } : {}),
      ...(Array.isArray(sourceLot?.condition_report_specs_deleted)
        ? { condition_report_specs_deleted: sourceLot.condition_report_specs_deleted }
        : {}),
      ...(Array.isArray(sourceLot?.condition_report_specs_custom_order)
        ? { condition_report_specs_custom_order: sourceLot.condition_report_specs_custom_order }
        : {}),
    };
    return enforceLotDamageAnalysisPolicy(restoredLot, {
      fallbackLotNumber: index + 1,
    });
  });
}
