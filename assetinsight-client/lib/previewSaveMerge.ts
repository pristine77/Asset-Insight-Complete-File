type PreviewRecord = Record<string, any>;

function getLotKey(lot: PreviewRecord | undefined, index: number): string {
  const identity = lot?.lot_id ?? lot?.id ?? lot?._id ?? lot?.lot_number;
  return identity === undefined || identity === null || String(identity).trim() === ""
    ? `index:${index}`
    : `lot:${String(identity).trim()}`;
}

/**
 * Keeps the exact edits submitted by the user while retaining server-only fields.
 * File refresh responses must never be able to restore an older lot snapshot.
 */
export function mergeSubmittedPreviewData(
  serverPreview: PreviewRecord | null | undefined,
  submittedPreview: PreviewRecord
): PreviewRecord {
  if (!serverPreview || typeof serverPreview !== "object") return submittedPreview;

  const submittedLots = Array.isArray(submittedPreview?.lots) ? submittedPreview.lots : [];
  const serverLots = Array.isArray(serverPreview?.lots) ? serverPreview.lots : [];
  const submittedByKey = new Map<string, PreviewRecord[]>();
  submittedLots.forEach((lot: PreviewRecord, index: number) => {
    const key = getLotKey(lot, index);
    submittedByKey.set(key, [...(submittedByKey.get(key) || []), lot]);
  });
  const consumedByKey = new Map<string, number>();

  const mergedLots = (serverLots.length > 0 ? serverLots : submittedLots).map(
    (serverLot: PreviewRecord, index: number) => {
      const key = getLotKey(serverLot, index);
      const candidates = submittedByKey.get(key) || [];
      const candidateIndex = consumedByKey.get(key) || 0;
      const submittedLot =
        candidates[candidateIndex] ||
        (candidates.length === 0 ? submittedLots[index] : undefined);
      if (candidates[candidateIndex]) consumedByKey.set(key, candidateIndex + 1);
      return submittedLot ? { ...serverLot, ...submittedLot } : serverLot;
    }
  );

  return {
    ...serverPreview,
    ...submittedPreview,
    lots: mergedLots,
  };
}
