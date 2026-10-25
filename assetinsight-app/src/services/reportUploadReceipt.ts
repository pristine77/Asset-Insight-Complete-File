/** A transport response alone must never hide the local draft. */
export function assertReportUploadAccepted<T>(value: T): asserts value is T & { reportId: string; jobId: string } {
  const receipt = value as any;
  if (receipt?.accepted === true && receipt?.reportAvailable === false) {
    throw Object.assign(new Error('The earlier upload was accepted, but its report is no longer available.'), {
      response: { status: 409, data: { code: 'UPLOAD_SESSION_REPORT_UNAVAILABLE', data: receipt } },
    });
  }
  const pendingStates = ['upload', 'preparing', 'uploading', 'uploaded', 'completing', 'pending', 'unavailable'];
  const pending = receipt?.readyToComplete === true || pendingStates.includes(receipt?.status) || pendingStates.includes(receipt?.phase);
  const legacyAccepted = receipt?.accepted === undefined &&
    (['processing', 'processed', 'done', 'preview', 'error'].includes(receipt?.status) ||
      ['processing', 'done', 'preview', 'error'].includes(receipt?.phase));
  if (receipt?.accepted === false || receipt?.reportAvailable === false ||
    pending || !(receipt?.accepted === true || legacyAccepted) ||
    typeof receipt?.reportId !== 'string' || !receipt.reportId.trim() ||
    typeof receipt?.jobId !== 'string' || !receipt.jobId.trim()) {
    throw Object.assign(new Error('The server response did not confirm this submission. Keep this draft and its originals, then tap Resume upload to check the same submission.'), {
      code: 'UPLOAD_RECEIPT_UNCONFIRMED',
    });
  }
}

export function isExistingReportUploadReceipt(receipt: any): boolean {
  return receipt?.alreadyQueued === true || receipt?.reusedAcceptance === true ||
    (receipt?.reusedAcceptance !== false && receipt?.processed === true);
}
