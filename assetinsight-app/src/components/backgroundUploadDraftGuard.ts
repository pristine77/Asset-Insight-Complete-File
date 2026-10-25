import { Alert } from 'react-native';
import backgroundUploadManager from '../services/backgroundUploadManager';

/**
 * Before a saved draft is opened from Drafts or the upload bar (2026-10-02).
 *
 * A draft that is queued or uploading in the background must not be edited
 * at the same time: the form would save new photos or a new submission
 * identity under an upload that is already on its way. The person is told to
 * pause it from the upload bar first. A paused or needs-attention draft is
 * handed back to the form, which then owns it (its next Submit starts again).
 *
 * Returns true when the draft may be opened.
 */
export function claimDraftForEditing(draftId: string): boolean {
  if (backgroundUploadManager.isBusy(draftId)) {
    Alert.alert(
      'Uploading in the background',
      'This report is uploading in the background. Pause it from the upload bar to edit it, or open it when the upload finishes.',
    );
    return false;
  }
  backgroundUploadManager.forget(draftId);
  return true;
}
