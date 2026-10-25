import * as FileSystem from 'expo-file-system/legacy';
import { Dimensions, Platform } from 'react-native';
import { API_BASE_URL } from '../config/api';
import { getMemoryAccessToken, getOrCreateDeviceKey } from './deviceAccessStorage';
import { getAndroidReinstallId } from './deviceReinstallIdentity';

export type SupportUploadTransportResponse = {
  status: number;
  headers?: Record<string, string>;
  body?: string;
};

function stringHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>(
    (headers, [key, item]) => {
      if (typeof item === 'string') headers[key] = item;
      return headers;
    },
    {}
  );
}

export async function getLocalSupportFileSize(uri: string): Promise<number | undefined> {
  try {
    const result = await FileSystem.getInfoAsync(uri);
    if (!result.exists) return undefined;
    const size = Number(result.size || 0);
    return Number.isFinite(size) && size > 0 ? size : undefined;
  } catch {
    return undefined;
  }
}

function uploadError(
  status: number,
  body?: string
): Error & { status: number; body?: string; response?: { status: number; data: unknown } } {
  let data: unknown;
  try {
    data = body ? JSON.parse(body) : undefined;
  } catch {
    data = body;
  }
  const message =
    data && typeof data === 'object' && typeof (data as { message?: unknown }).message === 'string'
      ? (data as { message: string }).message
      : `Media upload failed (${status || 'network error'}).`;
  const error = new Error(message) as Error & {
    status: number;
    body?: string;
    response?: { status: number; data: unknown };
  };
  error.status = status;
  error.body = body;
  if (status) error.response = { status, data };
  return error;
}

/**
 * Stream a local file without materializing large videos in JavaScript memory.
 * The caller decides whether the destination is a compatibility presign URL
 * or the authenticated first-party support upload endpoint.
 */
export async function putLocalSupportFileToUrl(args: {
  uri: string;
  uploadUrl: string;
  headers: Record<string, string>;
  httpMethod?: 'POST' | 'PUT';
  onProgress?: (progress: number) => void;
}): Promise<SupportUploadTransportResponse> {
  const uploadType = FileSystem.FileSystemUploadType?.BINARY_CONTENT ?? 'BINARY_CONTENT';
  const httpMethod = args.httpMethod || 'PUT';
  if (typeof FileSystem.createUploadTask === 'function') {
    const task = FileSystem.createUploadTask(
      args.uploadUrl,
      args.uri,
      { httpMethod, uploadType, headers: args.headers },
      (event: { totalBytesSent?: number; totalBytesExpectedToSend?: number }) => {
        const expected = Number(event.totalBytesExpectedToSend || 0);
        if (expected > 0) {
          args.onProgress?.(Math.min(1, Number(event.totalBytesSent || 0) / expected));
        }
      }
    );
    const result = await task.uploadAsync();
    const status = Number(result?.status || 0);
    if (status < 200 || status >= 300) throw uploadError(status, result?.body);
    args.onProgress?.(1);
    return {
      status,
      headers: stringHeaders(result?.headers),
      body: typeof result?.body === 'string' ? result.body : undefined,
    };
  }

  if (typeof FileSystem.uploadAsync === 'function') {
    const result = await FileSystem.uploadAsync(args.uploadUrl, args.uri, {
      httpMethod,
      uploadType,
      headers: args.headers,
    });
    const status = Number(result?.status || 0);
    if (status < 200 || status >= 300) throw uploadError(status, result?.body);
    args.onProgress?.(1);
    return {
      status,
      headers: stringHeaders(result?.headers),
      body: typeof result?.body === 'string' ? result.body : undefined,
    };
  }

  if (Platform.OS === 'web') {
    const source = await fetch(args.uri);
    const body = await source.blob();
    const response = await fetch(args.uploadUrl, {
      method: httpMethod,
      headers: args.headers,
      body,
    });
    const responseBody = await response.text();
    if (!response.ok) throw uploadError(response.status, responseBody);
    args.onProgress?.(1);
    return {
      status: response.status,
      headers: { etag: response.headers.get('etag') || '' },
      body: responseBody,
    };
  }

  throw new Error('Direct media upload is not available on this device.');
}

/**
 * Upload support media through the authenticated API instead of exposing an R2
 * presign to the device. FileSystem supplies the native Content-Length while
 * X-File-Size gives the API an explicit, cross-platform validation value.
 */
export async function uploadLocalSupportFileToBackend(args: {
  uri: string;
  endpointPath: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  onProgress?: (progress: number) => void;
}): Promise<SupportUploadTransportResponse> {
  const accessToken = getMemoryAccessToken();
  if (!accessToken) throw uploadError(401);

  const [deviceKey, reinstallId] = await Promise.all([
    getOrCreateDeviceKey(),
    getAndroidReinstallId(),
  ]);
  const screen = Dimensions.get('screen');
  const endpointPath = args.endpointPath.startsWith('/')
    ? args.endpointPath
    : `/${args.endpointPath}`;
  const uploadUrl = `${API_BASE_URL.replace(/\/+$/, '')}${endpointPath}?fileName=${encodeURIComponent(
    args.fileName
  )}`;

  return putLocalSupportFileToUrl({
    uri: args.uri,
    uploadUrl,
    httpMethod: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': args.contentType,
      'X-File-Size': String(args.sizeBytes),
      ...(deviceKey ? { 'X-Device-Key': deviceKey } : {}),
      ...(reinstallId ? { 'X-Device-Reinstall-Id': reinstallId } : {}),
      'X-Device-Platform': Platform.OS === 'ios' ? 'ios' : 'android',
      'X-Device-Form-Factor': Math.min(screen.width, screen.height) >= 600 ? 'tablet' : 'mobile',
    },
    onProgress: args.onProgress,
  });
}
