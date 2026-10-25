/** Actual persisted status wins over an outdated screen/navigation mode. */
export function shouldResubmitRealEstate(status: string, mode: string) {
  if (status === 'preview' || status === 'declined') return false;
  if (status === 'pending_approval' || status === 'approved') return true;
  return mode === 'submitted';
}

export function realEstateSubmissionPath(reportId: string, status: string, mode: string) {
  const id = encodeURIComponent(reportId);
  return shouldResubmitRealEstate(status, mode)
    ? `/real-estate/${id}/resubmit`
    : `/real-estate/preview/${id}/submit`;
}
