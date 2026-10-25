import api from './api';
import {
  createSupportConversation,
  getSupportUploadConstraints,
  listSupportMessages,
  normalizeSupportConversationPage,
  normalizeSupportMessage,
  uploadSupportAttachment,
} from './supportService';
import { getLocalSupportFileSize, uploadLocalSupportFileToBackend } from './supportUploadTransport';

jest.mock('./supportUploadTransport', () => ({
  __esModule: true,
  uploadLocalSupportFileToBackend: jest.fn(),
  getLocalSupportFileSize: jest.fn(),
}));

jest.mock('./api', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
  },
}));

const mockedApi = api as jest.Mocked<typeof api>;
const mockUploadLocalSupportFileToBackend = jest.mocked(uploadLocalSupportFileToBackend);
const mockGetLocalSupportFileSize = jest.mocked(getLocalSupportFileSize);

beforeEach(() => {
  jest.clearAllMocks();
  mockGetLocalSupportFileSize.mockResolvedValue(1024);
});

describe('support API DTO compatibility', () => {
  it('normalizes the stable backend conversation and message fields', () => {
    expect(
      normalizeSupportConversationPage({
        items: [
          {
            id: 'case-1',
            subject: 'Photo upload fails',
            category: 'error',
            status: 'waiting_on_user',
            source: 'mobile',
            unread: { user: 2, agent: 0 },
            lastMessage: {
              preview: 'Please send a screen recording.',
              at: '2026-08-16T10:04:00.000Z',
              senderRole: 'agent',
            },
            createdAt: '2026-08-16T10:00:00.000Z',
            updatedAt: '2026-08-16T10:05:00.000Z',
          },
        ],
        nextCursor: 'next-page',
      })
    ).toMatchObject({
      conversations: [
        {
          id: 'case-1',
          category: 'error',
          unreadCount: 2,
          lastMessage: 'Please send a screen recording.',
          lastMessageAt: '2026-08-16T10:04:00.000Z',
        },
      ],
      nextCursor: 'next-page',
    });

    expect(
      normalizeSupportMessage({
        id: 'message-1',
        conversationId: 'case-1',
        senderRole: 'developer',
        sender: { username: 'Support Agent' },
        body: 'We are investigating this.',
        attachments: [
          {
            id: 'attachment-1',
            type: 'video',
            originalName: 'reproduction.mp4',
            contentType: 'video/mp4',
            verifiedSizeBytes: 1234,
            status: 'ready',
            url: 'https://media.example/reproduction.mp4',
          },
        ],
        createdAt: '2026-08-16T10:06:00.000Z',
      })
    ).toMatchObject({
      senderType: 'developer',
      senderName: 'Support Agent',
      attachments: [
        {
          kind: 'video',
          fileName: 'reproduction.mp4',
          size: 1234,
        },
      ],
    });
  });

  it('uses the stable create and cursor paging contracts', async () => {
    mockedApi.post.mockResolvedValueOnce({
      data: {
        conversation: {
          id: 'case-2',
          subject: 'New idea',
          category: 'feature',
          status: 'open',
          source: 'mobile',
          createdAt: '2026-08-16T10:00:00.000Z',
          updatedAt: '2026-08-16T10:00:00.000Z',
        },
      },
    } as never);
    await createSupportConversation({
      subject: 'New idea',
      category: 'feature',
      message: 'Please add a faster workflow.',
    });
    expect(mockedApi.post).toHaveBeenCalledWith('/support/conversations', {
      subject: 'New idea',
      category: 'feature',
      message: 'Please add a faster workflow.',
      source: 'mobile',
    });

    mockedApi.get.mockResolvedValueOnce({ data: { items: [], nextCursor: 'older' } } as never);
    await listSupportMessages('case/2', { cursor: 'before-1', limit: 25 });
    expect(mockedApi.get).toHaveBeenCalledWith('/support/conversations/case%2F2/messages', {
      params: { before: 'before-1', limit: 25 },
    });

    mockedApi.get.mockResolvedValueOnce({
      data: {
        constraints: {
          imageContentTypes: ['image/png'],
          videoContentTypes: ['video/mp4'],
          maxImageBytes: 12,
          maxVideoBytes: 34,
          maxAttachmentsPerMessage: 6,
        },
      },
    } as never);
    await expect(getSupportUploadConstraints()).resolves.toEqual({
      imageContentTypes: ['image/png'],
      videoContentTypes: ['video/mp4'],
      maxImageBytes: 12,
      maxVideoBytes: 34,
      maxAttachmentsPerMessage: 6,
    });
  });

  it('streams raw media through the authenticated conversation upload endpoint', async () => {
    mockUploadLocalSupportFileToBackend.mockResolvedValueOnce({
      status: 201,
      body: JSON.stringify({
        attachment: {
          id: 'attachment-2',
          type: 'image',
          originalName: 'screen.png',
          contentType: 'image/png',
          verifiedSizeBytes: 1024,
          status: 'ready',
          url: 'https://media.example/screen.png',
        },
      }),
    });

    await expect(
      uploadSupportAttachment({
        conversationId: 'case-2',
        file: {
          uri: 'file:///screen.png',
          fileName: 'screen.png',
          contentType: 'image/png',
          kind: 'image',
          size: 1024,
        },
      })
    ).resolves.toMatchObject({ id: 'attachment-2', status: 'ready' });

    expect(mockUploadLocalSupportFileToBackend).toHaveBeenCalledWith({
      uri: 'file:///screen.png',
      endpointPath: '/support/conversations/case-2/attachments/upload',
      fileName: 'screen.png',
      contentType: 'image/png',
      sizeBytes: 1024,
      onProgress: undefined,
    });
    expect(mockedApi.post).not.toHaveBeenCalled();
  });

  it('refreshes authentication before retrying a body that auth middleware rejected', async () => {
    mockUploadLocalSupportFileToBackend
      .mockRejectedValueOnce(Object.assign(new Error('Expired'), { status: 401 }))
      .mockResolvedValueOnce({
        status: 201,
        body: JSON.stringify({
          attachment: {
            id: 'attachment-3',
            type: 'image',
            originalName: 'screen.png',
            contentType: 'image/png',
            verifiedSizeBytes: 1024,
            status: 'ready',
            url: 'https://media.example/screen.png',
          },
        }),
      });
    mockedApi.get.mockResolvedValueOnce({ data: { constraints: {} } } as never);

    await expect(
      uploadSupportAttachment({
        conversationId: 'case-3',
        file: {
          uri: 'file:///screen.png',
          fileName: 'screen.png',
          contentType: 'image/png',
          kind: 'image',
          size: 1024,
        },
      })
    ).resolves.toMatchObject({ id: 'attachment-3', status: 'ready' });
    expect(mockedApi.get).toHaveBeenCalledWith('/support/constraints');
    expect(mockUploadLocalSupportFileToBackend).toHaveBeenCalledTimes(2);
  });
});
