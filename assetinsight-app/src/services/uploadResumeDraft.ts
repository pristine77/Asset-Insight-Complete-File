import type { OfflineReportDraft } from './autoSaveService';

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]));
  return value;
}

/** Status/cloud bookkeeping changes revisions too. Only the exact submitted
 * identity, editable details and ordered original-media snapshot may resume. */
export function uploadResumeDraftKey(draft: OfflineReportDraft): string {
  return JSON.stringify(stable({
    id: draft.id, ownerId: draft.ownerId, captureId: draft.captureId, type: draft.type,
    title: draft.title, contractNo: draft.contractNo, captureMode: draft.captureMode,
    manualSubmissionRequired: draft.manualSubmissionRequired, formData: draft.formData, lots: draft.lots,
  }));
}

export function canResumeDraftSnapshot(draft: OfflineReportDraft | null, expected: string | undefined): boolean {
  return Boolean(draft && expected && !['accepted', 'submitted', 'discarded'].includes(draft.submissionState || '')
    && uploadResumeDraftKey(draft) === expected);
}
