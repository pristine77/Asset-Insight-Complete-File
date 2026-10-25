import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupportMessage } from "@/services/support";
import { SupportService } from "@/services/support";
import SupportComposer from "./SupportComposer";

vi.mock("@/services/support", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/support")>();
  return {
    ...actual,
    SupportService: {
      getUploadConstraints: vi.fn(),
      uploadAttachments: vi.fn(),
      sendMessage: vi.fn(),
    },
  };
});

const sentMessage: SupportMessage = {
  id: "message-user-1",
  conversationId: "conversation-1",
  senderRole: "user",
  body: "The recording shows the failure.",
  attachments: [],
  createdAt: "2026-08-16T12:00:00.000Z",
};

describe("SupportComposer", () => {
  beforeEach(() => {
    vi.mocked(SupportService.getUploadConstraints)
      .mockReset()
      .mockResolvedValue({
        imageContentTypes: ["image/png"],
        videoContentTypes: ["video/mp4"],
        maxImageBytes: 20 * 1024 * 1024,
        maxVideoBytes: 250 * 1024 * 1024,
        maxAttachmentsPerMessage: 8,
        maxPendingUploads: 20,
      });
    vi.mocked(SupportService.uploadAttachments)
      .mockReset()
      .mockResolvedValue({
        attachmentIds: ["attachment-ready-1"],
        failures: [],
      });
    vi.mocked(SupportService.sendMessage)
      .mockReset()
      .mockRejectedValueOnce(new Error("The request timed out."))
      .mockResolvedValueOnce(sentMessage);
  });

  it("reuses confirmed attachments and the idempotency key when a timed-out send is retried", async () => {
    const onSent = vi.fn();
    render(
      <SWRConfig value={{ provider: () => new Map(), errorRetryCount: 0 }}>
        <SupportComposer conversationId="conversation-1" onSent={onSent} />
      </SWRConfig>,
    );

    const file = new File(["screen"], "failure.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Add images or videos"), {
      target: { files: [file] },
    });
    fireEvent.change(screen.getByLabelText("Reply to support"), {
      target: { value: "The recording shows the failure." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The request timed out.",
    );
    expect(SupportService.sendMessage).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));

    await waitFor(() =>
      expect(SupportService.sendMessage).toHaveBeenCalledTimes(2),
    );
    expect(SupportService.uploadAttachments).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalledTimes(1);

    const firstPayload = vi.mocked(SupportService.sendMessage).mock.calls[0][1];
    const retryPayload = vi.mocked(SupportService.sendMessage).mock.calls[1][1];
    expect(firstPayload).toMatchObject({
      attachmentIds: ["attachment-ready-1"],
      clientMessageId: expect.any(String),
    });
    expect(retryPayload).toEqual(firstPayload);
  });

  it("does not send text without selected attachments and retries only failed files", async () => {
    const onSent = vi.fn();
    const image = new File(["screen"], "failure.png", { type: "image/png" });
    const video = new File(["recording"], "failure.mp4", { type: "video/mp4" });
    vi.mocked(SupportService.uploadAttachments)
      .mockResolvedValueOnce({
        attachmentIds: ["attachment-image"],
        failures: [{ file: video, message: "Backend upload failed." }],
      })
      .mockResolvedValueOnce({
        attachmentIds: ["attachment-video"],
        failures: [],
      });
    vi.mocked(SupportService.sendMessage)
      .mockReset()
      .mockResolvedValue(sentMessage);

    render(
      <SWRConfig value={{ provider: () => new Map(), errorRetryCount: 0 }}>
        <SupportComposer conversationId="conversation-1" onSent={onSent} />
      </SWRConfig>,
    );

    fireEvent.change(screen.getByLabelText("Add images or videos"), {
      target: { files: [image, video] },
    });
    fireEvent.change(screen.getByLabelText("Reply to support"), {
      target: { value: "this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "1 attachment could not be uploaded. Nothing was sent.",
    );
    expect(SupportService.sendMessage).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Send reply" }));

    await waitFor(() =>
      expect(SupportService.sendMessage).toHaveBeenCalledTimes(1),
    );
    expect(SupportService.uploadAttachments).toHaveBeenNthCalledWith(
      1,
      "conversation-1",
      [image, video],
      expect.any(Function),
    );
    expect(SupportService.uploadAttachments).toHaveBeenNthCalledWith(
      2,
      "conversation-1",
      [video],
      expect.any(Function),
    );
    expect(SupportService.sendMessage).toHaveBeenCalledWith(
      "conversation-1",
      expect.objectContaining({
        body: "this",
        attachmentIds: ["attachment-image", "attachment-video"],
      }),
    );
    expect(onSent).toHaveBeenCalledTimes(1);
  });
});
