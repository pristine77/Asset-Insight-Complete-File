import { isRetryableRequestError } from './connectivityService';
import { isUploadStalled } from './uploadCancellation';

export const UPLOAD_WAITING_FOR_CONNECTION = 'UPLOAD_WAITING_FOR_CONNECTION';

/** Classifies feedback only. Nothing here schedules uploads or observes reconnects. */
export function isInterruptedUpload(error: any): boolean {
  if (error?.code === UPLOAD_WAITING_FOR_CONNECTION || error?.pauseReason === 'connection') return true;
  return isUploadStalled(error) || isRetryableRequestError(error);
}
