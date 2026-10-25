import NetInfo from '@react-native-community/netinfo';
import axios from 'axios';
import { API_BASE_URL } from '../config/api';

export type ConnectivityStatus = 'online' | 'offline' | 'server_unreachable' | 'unknown';

export type ConnectivityResult = {
  status: ConnectivityStatus;
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
};

const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

export function getErrorStatus(error: any): number | undefined {
  const value = Number(error?.response?.status ?? error?.status);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function isNetworkTransportError(error: any): boolean {
  if (!error) return false;
  if (getErrorStatus(error)) return false;
  if (error?.isRecoverableUploadError === true) return true;
  if (error?.request && !error?.response) return true;

  const code = String(error?.code || '').toUpperCase();
  if (
    [
      'ECONNABORTED',
      'ECONNRESET',
      'ETIMEDOUT',
      'ENETUNREACH',
      'EAI_AGAIN',
      'ERR_NETWORK',
      'ERR_INTERNET_DISCONNECTED',
      'UPLOAD_STALLED',
      'E_UPLOAD_STALLED',
    ].includes(code)
  ) {
    return true;
  }

  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('network error') ||
    message.includes('networkerror') ||
    message.includes('network request failed') ||
    message.includes('failed to fetch') ||
    message.includes('connection reset') ||
    message.includes('connection was interrupted') ||
    message.includes('timed out') ||
    message.includes('timeout')
  );
}

export function isRetryableRequestError(error: any): boolean {
  const status = getErrorStatus(error);
  return status ? TRANSIENT_HTTP_STATUSES.has(status) : isNetworkTransportError(error);
}

export function getServerErrorMessage(error: any): string {
  const body = error?.response?.data;
  if (typeof body === 'string' && body.trim()) return body.trim();
  const message = body?.message || body?.error;
  if (typeof message === 'string' && message.trim()) return message.trim();
  return typeof error?.message === 'string' ? error.message.trim() : '';
}

export function actionableErrorMessage(error: any): string {
  const message = getServerErrorMessage(error);
  // Proxy/storage HTML, transport diagnostics and bare status codes are not
  // instructions a person can use. Keep specific plain-language validation.
  return message.length > 0 && message.length <= 500 &&
    !/<[^>]+>|https?:\/\/|(?:status(?:\s+code)?|http|error)\s*[:=]?\s*[45]\d\d|^[45]\d\d$|(?:upload|request) failed[^\n]*\([45]\d\d\)|network\s*error|failed to fetch|fetch failed|\b(?:ECONN\w*|ETIMEDOUT|ERR_\w+)\b/i.test(message)
    ? message : '';
}

export async function getConnectivityStatus(): Promise<ConnectivityResult> {
  const network = await NetInfo.fetch().catch(() => null);
  const isConnected = network?.isConnected ?? null;
  const isInternetReachable = network?.isInternetReachable ?? null;

  if (isConnected === false) {
    return { status: 'offline', isConnected, isInternetReachable };
  }

  try {
    // This endpoint intentionally requires no authentication. An expired token
    // must never make an online report look like an offline report.
    await axios.get(`${API_BASE_URL}/health`, {
      timeout: 6000,
      validateStatus: () => true,
      headers: { 'Cache-Control': 'no-cache' },
    });
    return { status: 'online', isConnected, isInternetReachable };
  } catch {
    if (isInternetReachable === false) {
      return { status: 'offline', isConnected, isInternetReachable };
    }
    if (isConnected === true && isInternetReachable === true) {
      return { status: 'server_unreachable', isConnected, isInternetReachable };
    }
    return { status: 'unknown', isConnected, isInternetReachable };
  }
}

export async function shouldQueueAfterError(error: any): Promise<boolean> {
  if (!isRetryableRequestError(error)) return false;
  const status = getErrorStatus(error);
  // A transient server/storage response is safe to retry with the same upload
  // session and client submission id. Queue it even when general internet is up.
  if (status && TRANSIENT_HTTP_STATUSES.has(status)) return true;
  if (!isNetworkTransportError(error)) return false;
  const connectivity = await getConnectivityStatus();
  return connectivity.status !== 'online';
}

export function getSubmissionError(error: any, retryAction = 'Resume upload'): { title: string; message: string } {
  // No connection at Submit: nothing failed, the report is saved and only waits
  // for signal. It used to read "Submission Failed", which alarmed staff
  // (owner, 2026-10-11 phone test). The code is uploadResumePolicy's
  // UPLOAD_WAITING_FOR_CONNECTION, spelt out here because that module imports
  // this one.
  if (error?.code === 'UPLOAD_WAITING_FOR_CONNECTION') {
    return {
      title: 'Saved on this device',
      message: typeof error?.message === 'string' && error.message
        ? error.message
        : `Your report is saved on this device. Connect, then tap ${retryAction}.`,
    };
  }
  const status = getErrorStatus(error);
  const serverMessage = actionableErrorMessage(error);
  const code = error?.response?.data?.code;
  const draftConflicts = ['STALE_DRAFT_REVISION', 'DRAFT_REVISION_CONFLICT', 'DRAFT_MEDIA_CONFLICT'];
  if (draftConflicts.includes(code)) return {
    title: 'Draft needs checking',
    message: 'The saved draft changed while this request was running. Keep this form and its originals. Reopen the latest saved draft before trying again; do not clear the draft or start another upload.',
  };
  if (code === 'DRAFT_ALREADY_PROMOTED') return {
    title: 'Earlier submission found',
    message: 'This draft was already submitted. Keep your current work and check Reports or Previews. If the report is missing, contact support before submitting it again.',
  };

  if (['UPLOAD_STALLED', 'E_UPLOAD_STALLED'].includes(String(error?.code || ''))) {
    return {
      title: 'Upload Interrupted',
      message: `The upload stopped making progress. Keep this draft and its originals. Check the connection, then tap ${retryAction}. The same submission will be checked before it is completed.`,
    };
  }

  if (status === 401 || status === 403) {
    return {
      title: 'Sign In Required',
      message: status === 401 ? 'Sign in again, then reopen this draft and resume. Keep the draft and its originals.' : 'This account or device cannot complete the upload. Check its access or contact support. Keep the draft and its originals.',
    };
  }
  if (status === 408 || status === 425 || status === 429) {
    return {
      title: 'Upload Delayed',
      message: serverMessage || 'The server is busy. Keep this draft and its originals; wait a moment, then resume the same upload.',
    };
  }
  if (status && status >= 400 && status < 500) {
    return {
      title: 'Report Needs Attention',
      message: serverMessage || (status === 409
        ? 'The earlier upload needs checking. Keep this draft and its originals. Resume the same upload; if this continues, contact support before starting another report.'
        : status === 413 ? 'This upload exceeds the allowed size. Keep the originals and review the file sizes or contact support before retrying.'
        : 'The upload could not be completed. Keep this form and its originals, review the entered information, then try again.'),
    };
  }
  if (status && status >= 500) {
    return {
      title: 'Server Temporarily Unavailable',
      message: 'The server could not confirm the upload. Keep this draft and its originals; wait a moment, then resume the same submission.',
    };
  }
  if (isNetworkTransportError(error)) {
    return {
      title: 'Upload Interrupted',
      message: `The upload connection was interrupted before confirmation. Keep this draft and its originals. Check the connection and tap ${retryAction} to check the same submission.`,
    };
  }
  return {
    title: 'Submission Failed',
    message: serverMessage || 'The upload could not be confirmed. Keep this form and its originals. Try saving on this device, then resume the same submission.',
  };
}
