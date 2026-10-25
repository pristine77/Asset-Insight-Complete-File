import * as FileSystem from 'expo-file-system/legacy';
import { uploadLocalSupportFileToBackend } from './supportUploadTransport';

jest.mock('expo-file-system/legacy', () => ({
  __esModule: true,
  FileSystemUploadType: { BINARY_CONTENT: 'BINARY_CONTENT' },
  createUploadTask: jest.fn(),
}));

jest.mock('../config/api', () => ({
  API_BASE_URL: 'https://api.example.test/api',
}));

jest.mock('./deviceAccessStorage', () => ({
  getMemoryAccessToken: jest.fn(() => 'access-token'),
  getOrCreateDeviceKey: jest.fn(async () => 'device-key'),
}));

jest.mock('./deviceReinstallIdentity', () => ({
  getAndroidReinstallId: jest.fn(async () => 'reinstall-id'),
}));

const mockUploadAsync = jest.fn();
const mockCreateUploadTask = jest.mocked(FileSystem.createUploadTask);

describe('support upload transport', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUploadAsync.mockResolvedValue({
      status: 201,
      headers: { 'content-type': 'application/json' },
      body: '{"attachment":{"id":"attachment-1"}}',
    });
    mockCreateUploadTask.mockImplementation((_url, _uri, _options, onProgress) => {
      onProgress?.({ totalBytesSent: 512, totalBytesExpectedToSend: 1024 });
      return { uploadAsync: mockUploadAsync } as unknown as ReturnType<
        typeof FileSystem.createUploadTask
      >;
    });
  });

  it('posts raw bytes to the authenticated backend with exact size metadata', async () => {
    const onProgress = jest.fn();

    await expect(
      uploadLocalSupportFileToBackend({
        uri: 'file:///support/screen.png',
        endpointPath: '/support/conversations/case%2F1/attachments/upload',
        fileName: 'screen shot #1.png',
        contentType: 'image/png',
        sizeBytes: 1024,
        onProgress,
      })
    ).resolves.toEqual({
      status: 201,
      headers: { 'content-type': 'application/json' },
      body: '{"attachment":{"id":"attachment-1"}}',
    });

    expect(mockCreateUploadTask).toHaveBeenCalledWith(
      'https://api.example.test/api/support/conversations/case%2F1/attachments/upload?fileName=screen%20shot%20%231.png',
      'file:///support/screen.png',
      expect.objectContaining({
        httpMethod: 'POST',
        uploadType: 'BINARY_CONTENT',
        headers: expect.objectContaining({
          Authorization: 'Bearer access-token',
          Accept: 'application/json',
          'Content-Type': 'image/png',
          'X-File-Size': '1024',
          'X-Device-Key': 'device-key',
          'X-Device-Reinstall-Id': 'reinstall-id',
        }),
      }),
      expect.any(Function)
    );
    expect(onProgress).toHaveBeenNthCalledWith(1, 0.5);
    expect(onProgress).toHaveBeenLastCalledWith(1);
  });

  it('preserves the backend error response for actionable upload feedback', async () => {
    mockUploadAsync.mockResolvedValueOnce({
      status: 413,
      headers: { 'content-type': 'application/json' },
      body: '{"code":"UPLOAD_TOO_LARGE","message":"The selected video is too large."}',
    });

    await expect(
      uploadLocalSupportFileToBackend({
        uri: 'file:///support/recording.mp4',
        endpointPath: '/support/conversations/case-1/attachments/upload',
        fileName: 'recording.mp4',
        contentType: 'video/mp4',
        sizeBytes: 1024,
      })
    ).rejects.toMatchObject({
      status: 413,
      message: 'The selected video is too large.',
      response: {
        status: 413,
        data: {
          code: 'UPLOAD_TOO_LARGE',
          message: 'The selected video is too large.',
        },
      },
    });
  });
});
