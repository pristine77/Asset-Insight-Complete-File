import { beforeEach, describe, expect, it, vi } from "vitest";
import API from "@/lib/api";
import { SupportService } from "./support";

vi.mock("@/lib/api", () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

vi.mock("@/services/directUpload", () => ({
  mapWithConcurrency: async <T>(
    items: T[],
    worker: (item: T, index: number) => Promise<void>,
  ) => {
    await Promise.all(items.map(worker));
  },
}));

const conversationDto = {
  id: "conversation-1",
  subject: "Preview upload fails",
  category: "error",
  source: "web",
  status: "in_progress",
  priority: "high",
  unread: { user: 2, agent: 0 },
  lastMessage: {
    preview: "We are checking this now.",
    at: "2026-08-16T10:10:00.000Z",
    senderRole: "agent",
  },
  createdAt: "2026-08-16T09:00:00.000Z",
  updatedAt: "2026-08-16T10:10:00.000Z",
};

const messageDto = {
  id: "message-1",
  conversationId: "conversation-1",
  sender: { id: "agent-1", username: "Taylor", email: "support@example.test" },
  senderRole: "agent",
  type: "message",
  body: "We are checking this now.",
  attachments: [
    {
      id: "attachment-ready",
      originalName: "screen.png",
      contentType: "image/png",
      sizeBytes: 2048,
      status: "ready",
      url: "https://media.example.test/screen.png",
    },
    {
      id: "attachment-pending",
      originalName: "pending.png",
      contentType: "image/png",
      sizeBytes: 100,
      status: "pending",
      url: "https://media.example.test/must-not-render.png",
    },
  ],
  createdAt: "2026-08-16T10:10:00.000Z",
};

describe("SupportService", () => {
  beforeEach(() => {
    vi.mocked(API.get).mockReset();
    vi.mocked(API.post).mockReset();
  });

  it("uses the server's deployment-specific upload limits", async () => {
    vi.mocked(API.get).mockResolvedValueOnce({
      data: {
        constraints: {
          imageContentTypes: ["image/png"],
          videoContentTypes: ["video/mp4"],
          maxImageBytes: 1_000,
          maxVideoBytes: 2_000,
          maxAttachmentsPerMessage: 4,
          maxPendingUploads: 10,
        },
      },
    });

    await expect(SupportService.getUploadConstraints()).resolves.toEqual({
      imageContentTypes: ["image/png"],
      videoContentTypes: ["video/mp4"],
      maxImageBytes: 1_000,
      maxVideoBytes: 2_000,
      maxAttachmentsPerMessage: 4,
      maxPendingUploads: 10,
    });
  });

  it("normalizes customer conversation and message DTOs", async () => {
    vi.mocked(API.get)
      .mockResolvedValueOnce({
        data: { items: [conversationDto], nextCursor: "older-conversations" },
      })
      .mockResolvedValueOnce({
        data: { items: [messageDto], nextCursor: "older-messages" },
      });

    const conversations = await SupportService.listConversations();
    const messages = await SupportService.listMessages("conversation-1");

    expect(conversations.nextCursor).toBe("older-conversations");
    expect(conversations.items[0]).toMatchObject({
      id: "conversation-1",
      preview: "We are checking this now.",
      unreadCount: 2,
      status: "in_progress",
    });
    expect(messages.nextCursor).toBe("older-messages");
    expect(messages.items[0]).toMatchObject({
      senderRole: "support",
      senderName: "Taylor",
      body: "We are checking this now.",
    });
    expect(messages.items[0].attachments).toHaveLength(1);
    expect(messages.items[0].attachments[0]).toMatchObject({
      id: "attachment-ready",
      size: 2048,
      status: "ready",
    });
    expect(API.get).toHaveBeenLastCalledWith(
      "/support/conversations/conversation-1/messages",
      { params: { limit: 50 } },
    );
  });

  it("uses the exact create and idempotent message payload contract", async () => {
    vi.mocked(API.post)
      .mockResolvedValueOnce({ data: { conversation: conversationDto } })
      .mockResolvedValueOnce({ data: { message: messageDto } });

    await SupportService.createConversation({
      subject: "Preview upload fails",
      category: "error",
      message: "The upload stops at 90%.",
      diagnostics: {
        occurredAt: "2026-08-16T09:00:00.000Z",
        route: "/previews",
        platform: "web",
      },
    });
    await SupportService.sendMessage("conversation-1", {
      body: "Here is another example.",
      attachmentIds: ["attachment-ready"],
      clientMessageId: "web-message-1",
    });

    expect(API.post).toHaveBeenNthCalledWith(1, "/support/conversations", {
      subject: "Preview upload fails",
      category: "error",
      source: "web",
      message: "The upload stops at 90%.",
      diagnostics: expect.objectContaining({ route: "/previews" }),
    });
    expect(API.post).toHaveBeenNthCalledWith(
      2,
      "/support/conversations/conversation-1/messages",
      {
        body: "Here is another example.",
        attachmentIds: ["attachment-ready"],
        clientMessageId: "web-message-1",
      },
    );
  });

  it("streams raw file bytes through the authenticated support upload endpoint", async () => {
    vi.mocked(API.post).mockImplementation(async (_url, _body, config) => {
      config?.onUploadProgress?.({ loaded: 6, total: 6 } as never);
      return {
        data: {
          attachment: {
            id: "attachment-1",
            type: "image",
            originalName: "screen.png",
            contentType: "image/png",
            sizeBytes: 6,
            status: "ready",
            url: "https://media.example.test/screen.png",
          },
        },
      } as never;
    });
    const file = new File(["screen"], "screen.png", { type: "image/png" });
    const progress = vi.fn();

    const result = await SupportService.uploadAttachments(
      "conversation-1",
      [file],
      progress,
    );

    expect(result).toEqual({ attachmentIds: ["attachment-1"], failures: [] });
    expect(API.post).toHaveBeenCalledWith(
      "/support/conversations/conversation-1/attachments/upload",
      file,
      expect.objectContaining({
        params: { fileName: "screen.png" },
        headers: { "Content-Type": "image/png", "X-File-Size": "6" },
        timeout: 15 * 60 * 1000,
        onUploadProgress: expect.any(Function),
      }),
    );
    expect(progress).toHaveBeenLastCalledWith(1);
  });

  it("does not return an attachment id unless the backend publishes a ready URL", async () => {
    vi.mocked(API.post).mockResolvedValueOnce({
      data: {
        attachment: {
          id: "attachment-pending",
          type: "video",
          originalName: "recording.mp4",
          contentType: "video/mp4",
          sizeBytes: 5,
          status: "pending",
        },
      },
    } as never);
    const file = new File(["video"], "recording.mp4", { type: "video/mp4" });

    await expect(
      SupportService.uploadAttachments("conversation-1", [file]),
    ).resolves.toEqual({
      attachmentIds: [],
      failures: [
        expect.objectContaining({
          file,
          message:
            "The server did not return a ready attachment for this file.",
        }),
      ],
    });
  });
});
