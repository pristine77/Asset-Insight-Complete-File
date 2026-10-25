import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContextType } from "@/context/AuthContext";
import { useAuthContext } from "@/context/AuthContext";
import type {
  SupportConversation,
  SupportMessage,
} from "@/services/support";
import { SupportService } from "@/services/support";
import SupportWorkspace from "./SupportWorkspace";

vi.mock("@/context/AuthContext", () => ({
  useAuthContext: vi.fn(),
}));

vi.mock("@/services/support", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/support")>();
  return {
    ...actual,
    SupportService: {
      getUploadConstraints: vi.fn(),
      listConversations: vi.fn(),
      getConversation: vi.fn(),
      createConversation: vi.fn(),
      listMessages: vi.fn(),
      sendMessage: vi.fn(),
      markRead: vi.fn(),
      uploadAttachments: vi.fn(),
    },
  };
});

const conversation: SupportConversation = {
  id: "conversation-1",
  subject: "Preview upload fails",
  category: "error",
  status: "in_progress",
  priority: "high",
  source: "web",
  preview: "We are checking this now.",
  unreadCount: 1,
  createdAt: "2026-08-16T09:00:00.000Z",
  updatedAt: "2026-08-16T10:10:00.000Z",
  lastMessageAt: "2026-08-16T10:10:00.000Z",
};

const supportMessage: SupportMessage = {
  id: "message-1",
  conversationId: conversation.id,
  body: "We are checking this now.",
  senderRole: "support",
  senderName: "Taylor",
  createdAt: "2026-08-16T10:10:00.000Z",
  attachments: [
    {
      id: "attachment-1",
      fileName: "screen.png",
      contentType: "image/png",
      size: 2048,
      status: "ready",
      url: "https://media.example.test/screen.png",
    },
  ],
};

const userContext: AuthContextType = {
  user: {
    _id: "user-1",
    email: "appraiser@example.test",
    username: "Alex Morgan",
  },
  sessionPresent: true,
  loading: false,
  error: null,
  loggingOut: false,
  deviceAccess: null,
  refresh: vi.fn(),
  login: vi.fn(),
  acceptAuthResponse: vi.fn(),
  registerDevice: vi.fn(),
  refreshDeviceStatus: vi.fn(),
  rerequestDevice: vi.fn(),
  logout: vi.fn(),
};

function renderWorkspace() {
  return render(
    <SWRConfig
      value={{
        provider: () => new Map(),
        dedupingInterval: 0,
        errorRetryCount: 0,
      }}
    >
      <SupportWorkspace />
    </SWRConfig>
  );
}

describe("SupportWorkspace", () => {
  beforeEach(() => {
    vi.mocked(useAuthContext).mockReturnValue(userContext);
    vi.mocked(SupportService.getUploadConstraints).mockReset().mockResolvedValue({
      imageContentTypes: ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"],
      videoContentTypes: ["video/mp4", "video/quicktime", "video/webm", "video/x-m4v"],
      maxImageBytes: 20 * 1024 * 1024,
      maxVideoBytes: 250 * 1024 * 1024,
      maxAttachmentsPerMessage: 8,
      maxPendingUploads: 20,
    });
    vi.mocked(SupportService.listConversations).mockReset().mockResolvedValue({
      items: [conversation],
      nextCursor: null,
    });
    vi.mocked(SupportService.getConversation).mockReset().mockResolvedValue(conversation);
    vi.mocked(SupportService.listMessages).mockReset().mockResolvedValue({
      items: [supportMessage],
      nextCursor: null,
    });
    vi.mocked(SupportService.markRead).mockReset().mockResolvedValue();
    vi.mocked(SupportService.createConversation).mockReset().mockResolvedValue(conversation);
    vi.mocked(SupportService.sendMessage).mockReset().mockResolvedValue({
      ...supportMessage,
      id: "message-user-2",
      body: "I can reproduce it on another report.",
      senderRole: "user",
      senderName: undefined,
      attachments: [],
    });
    vi.mocked(SupportService.uploadAttachments).mockReset().mockResolvedValue({
      attachmentIds: [],
      failures: [],
    });
  });

  it("renders a persisted attachment and sends an idempotent chat reply", async () => {
    renderWorkspace();

    fireEvent.click(
      await screen.findByRole("button", { name: /Preview upload fails/i })
    );

    expect(await screen.findByText("We are checking this now.")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Attachment: screen.png" })
    ).toHaveAttribute("src", "https://media.example.test/screen.png");
    expect(SupportService.markRead).toHaveBeenCalledWith("conversation-1");

    fireEvent.change(screen.getByLabelText("Reply to support"), {
      target: { value: "I can reproduce it on another report." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));

    await waitFor(() =>
      expect(SupportService.sendMessage).toHaveBeenCalledWith(
        "conversation-1",
        expect.objectContaining({
          body: "I can reproduce it on another report.",
          clientMessageId: expect.any(String),
        })
      )
    );
  });

  it("creates an error report with consented, allow-listed diagnostics", async () => {
    vi.mocked(SupportService.listConversations).mockResolvedValue({
      items: [],
      nextCursor: null,
    });
    renderWorkspace();

    fireEvent.click(screen.getByRole("button", { name: "New request" }));
    await screen.findByRole("dialog", { name: "New support request" });
    fireEvent.change(screen.getByLabelText("Subject"), {
      target: { value: "Camera upload stops" },
    });
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "The upload remains at 90 percent after I select a recording." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create request" }));

    await waitFor(() =>
      expect(SupportService.createConversation).toHaveBeenCalledWith({
        subject: "Camera upload stops",
        category: "error",
        message: "The upload remains at 90 percent after I select a recording.",
        diagnostics: expect.objectContaining({
          platform: "web",
          route: expect.any(String),
          occurredAt: expect.any(String),
        }),
      })
    );
  });
});
