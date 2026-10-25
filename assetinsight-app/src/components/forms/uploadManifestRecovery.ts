import { Alert } from 'react-native';

export function uploadConflictSource(error: any, fallback: string): string {
  // The server may have followed a prior replacement alias. Its canonical job
  // identity is also the client submission identity for these upload sessions.
  const value = error?.response?.data?.data?.jobId;
  return typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(value) ? value : fallback;
}

/**
 * Whether showUploadManifestRecovery() would handle this error. A background
 * upload (backgroundUploadManager.ts) cannot show the prompt itself; it hands
 * such a draft back to the form, where the prompt appears on the next Submit.
 */
export function isUploadManifestConflict(error: any): boolean {
  const code = error?.response?.data?.code;
  return error?.response?.status === 409 && ['SUBMISSION_MANIFEST_CHANGED', 'UPLOAD_SESSION_REPORT_UNAVAILABLE'].includes(code);
}

/** Recovery is an explicit action, never an automatic identity change/retry. */
export function showUploadManifestRecovery(error: any, actions: { replace?: () => void; startSeparate?: () => void } = {}): boolean {
  if (!isUploadManifestConflict(error)) return false;
  const code = error.response.data.code;
  const receipt = error.response.data.data;
  const keepDraft = { text: 'Keep Draft', style: 'cancel' as const };
  if (code === 'UPLOAD_SESSION_REPORT_UNAVAILABLE' && receipt?.accepted === true && receipt?.reportAvailable === false) {
    const startSeparate = receipt.canCreateSeparate === true ? actions.startSeparate : undefined;
    Alert.alert('Earlier report unavailable', startSeparate
      ? 'The earlier upload was accepted, but its report is no longer available. Keep this draft, or explicitly submit these photos as a new report. The earlier submission will not be retried or replaced, and its saved history will be kept.'
      : 'The earlier upload was accepted, but its report is no longer available. Keep this draft and its originals. For Incoming work, contact support to recover the assigned upload; do not create an unrelated report.',
    [keepDraft, ...(startSeparate ? [{ text: 'Start separate report', onPress: startSeparate }] : [])]);
    return true;
  }
  if (receipt?.accepted === true && receipt?.reportAvailable === true) {
    Alert.alert('Existing report found', 'The server confirms the earlier upload was accepted. Keep your draft and open Reports or Previews to review it. It will not be replaced or submitted again.', [keepDraft]);
    return true;
  }
  // A reserved report ID is not proof of acceptance, and missing legacy fields
  // are not permission to rotate identities. The server rechecks on replacement.
  const replace = code === 'SUBMISSION_MANIFEST_CHANGED' && receipt?.accepted === false && receipt?.canSupersede === true ? actions.replace : undefined;
  Alert.alert(
    replace ? 'Upload needs updating' : 'Upload needs checking',
    replace
      ? 'The photos or lot grouping differ from the earlier upload. Upload the current version? Your draft and originals are kept. The server will replace only an unfinished upload; an already-accepted report will not be replaced or duplicated.'
      : 'The earlier upload cannot safely be replaced yet. Keep this draft and its originals. Try Resume upload to check the same submission, or contact support if this continues. Incoming work must keep its assigned upload.',
    [
      keepDraft,
      ...(replace ? [{ text: 'Upload updated version', onPress: replace }] : []),
    ],
  );
  return true;
}
