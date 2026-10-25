import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  canUseDirectBrowserUpload: vi.fn(),
  mapWithConcurrency: vi.fn(),
  putFileWithRetry: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  default: {
    get: mocks.apiGet,
    post: mocks.apiPost,
  },
}));

vi.mock("@/services/directUpload", () => ({
  canUseDirectBrowserUpload: mocks.canUseDirectBrowserUpload,
  mapWithConcurrency: mocks.mapWithConcurrency,
  putFileWithRetry: mocks.putFileWithRetry,
}));

import { ReportDraftService } from "./reportDrafts";
import { advanceAuthSession } from "@/lib/auth-storage";

const input = {
  clientDraftId: "draft-client-1",
  kind: "asset" as const,
  revision: 1,
  deviceId: "device-1",
  contractNo: "CONTRACT-1",
  title: "Cancellation test draft",
  formData: { clientName: "Cancellation test" },
};

function draftRecord() {
  return {
    _id: "draft-1",
    id: "draft-1",
    user: "user-1",
    clientDraftId: input.clientDraftId,
    type: "asset",
    storageMode: "r2_media",
    revision: 1,
    contractNo: input.contractNo,
    formData: input.formData,
    lots: [],
    media: [],
    createdAt: "2026-08-31T10:00:00.000Z",
    updatedAt: "2026-08-31T10:00:00.000Z",
  };
}

function mediaLots() {
  return [
    {
      id: "lot-1",
      files: [new File(["photo"], "photo.jpg", { type: "image/jpeg" })],
      extraFiles: [],
      videoFiles: [],
    },
  ];
}

describe("ReportDraftService draft-save cancellation", () => {
  it("stops after metadata receipt when the account session changes", async () => {
    mocks.apiPost.mockImplementation(async () => { advanceAuthSession(); return { data: { data: draftRecord() } }; });
    await expect(ReportDraftService.upsertWithMedia(input, mediaLots())).rejects.toMatchObject({ code: "ERR_CANCELED" });
    expect(mocks.apiPost).toHaveBeenCalledTimes(1);
    expect(mocks.apiPost.mock.calls[0][2]._authSession).toHaveProperty("revision");
    expect(mocks.apiGet).not.toHaveBeenCalled();
  });

  it("does not mark a draft saved without a server identifier", async () => {
    mocks.apiPost.mockResolvedValue({ data: { data: { ...draftRecord(), _id: undefined, id: undefined } } });
    const progress = vi.fn();
    await expect(ReportDraftService.upsertWithMedia(input, mediaLots(), progress)).rejects.toThrow(/did not confirm the draft save/);
    expect(progress.mock.calls.some(([, , details]) => details.phase === "complete")).toBe(false);
    expect(mocks.apiPost).toHaveBeenCalledTimes(1);
  });

  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
  });

  it("passes the signal to draft API requests and stops fallback and verification after abort", async () => {
    const controller = new AbortController();

    mocks.apiPost.mockImplementation(
      (url: string, _body?: unknown, config?: { signal?: AbortSignal }) => {
        if (url === "/report-drafts") {
          return Promise.resolve({ data: { data: draftRecord() } });
        }
        if (url === "/report-drafts/draft-1/media/targets") {
          return new Promise((_resolve, reject) => {
            const signal = config?.signal;
            const rejectAsAborted = () =>
              reject(
                signal?.reason ||
                  new DOMException("The operation was aborted", "AbortError")
              );
            if (signal?.aborted) rejectAsAborted();
            else signal?.addEventListener("abort", rejectAsAborted, { once: true });
          });
        }
        throw new Error(`Unexpected draft API call: ${url}`);
      }
    );

    const saving = ReportDraftService.upsertWithMedia(
      input,
      mediaLots(),
      undefined,
      controller.signal
    );

    await vi.waitFor(() => expect(mocks.apiPost).toHaveBeenCalledTimes(2));
    expect(mocks.apiPost.mock.calls[0][2]).toMatchObject({
      signal: controller.signal,
    });
    expect(mocks.apiPost.mock.calls[1][2]).toMatchObject({
      signal: controller.signal,
    });

    controller.abort();

    await expect(saving).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.apiPost.mock.calls.map(([url]) => url)).toEqual([
      "/report-drafts",
      "/report-drafts/draft-1/media/targets",
    ]);
    expect(mocks.putFileWithRetry).not.toHaveBeenCalled();
    expect(mocks.apiGet).not.toHaveBeenCalled();
  });

  it("aborts an active draft PUT with the same signal and never confirms or verifies it", async () => {
    const controller = new AbortController();
    let activePutSignal: AbortSignal | undefined;

    mocks.canUseDirectBrowserUpload.mockReturnValue(true);
    mocks.mapWithConcurrency.mockImplementation(
      async (
        items: unknown[],
        worker: (item: unknown, index: number) => Promise<void>,
        _concurrency: number,
        signal?: AbortSignal
      ) => {
        for (let index = 0; index < items.length; index += 1) {
          signal?.throwIfAborted();
          await worker(items[index], index);
        }
      }
    );
    mocks.putFileWithRetry.mockImplementation(
      (
        _url: string,
        _file: File,
        _contentType: string,
        _onDelta: unknown,
        _headers: unknown,
        signal?: AbortSignal
      ) => {
        activePutSignal = signal;
        return new Promise<void>((_resolve, reject) => {
          const rejectAsAborted = () =>
            reject(
              signal?.reason ||
                new DOMException("The operation was aborted", "AbortError")
            );
          if (signal?.aborted) rejectAsAborted();
          else signal?.addEventListener("abort", rejectAsAborted, { once: true });
        });
      }
    );
    mocks.apiPost.mockImplementation(
      (
        url: string,
        body?: { media?: Array<{ clientFileId: string; mimeType: string }> }
      ) => {
        if (url === "/report-drafts") {
          return Promise.resolve({ data: { data: draftRecord() } });
        }
        if (url === "/report-drafts/draft-1/media/targets") {
          const media = body?.media?.[0];
          if (!media) throw new Error("Expected one media target request");
          return Promise.resolve({
            data: {
              data: [
                {
                  clientFileId: media.clientFileId,
                  uploadUrl: "https://uploads.example.test/draft-photo",
                  contentType: media.mimeType,
                  headers: {},
                },
              ],
            },
          });
        }
        throw new Error(`Unexpected draft API call: ${url}`);
      }
    );

    const saving = ReportDraftService.upsertWithMedia(
      input,
      mediaLots(),
      undefined,
      controller.signal
    );

    await vi.waitFor(() => expect(mocks.putFileWithRetry).toHaveBeenCalledOnce());
    expect(mocks.mapWithConcurrency.mock.calls[0][3]).toBe(controller.signal);
    expect(activePutSignal).toBe(controller.signal);

    controller.abort();

    await expect(saving).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.apiPost.mock.calls.map(([url]) => url)).toEqual([
      "/report-drafts",
      "/report-drafts/draft-1/media/targets",
    ]);
    expect(mocks.apiGet).not.toHaveBeenCalled();
  });
});
