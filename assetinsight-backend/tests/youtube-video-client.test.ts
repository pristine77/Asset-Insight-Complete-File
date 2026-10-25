import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { checkYoutubeUpload, publishYoutubeVideo, readYoutubeVideoStates, sendYoutubeChunk, startYoutubeUpload } from "../src/service/youtubeVideoClient.js";

const session = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=test-session";
const videoId = "AbCdEfGhI_1";
const token = "isolated-provider-token";
const fetchMock = vi.fn();
const nativeFetch = globalThis.fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const video = (privacyStatus: string, extra: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) => json({ items: [{ id: videoId, snippet: { channelId: "channel-1", ...metadata }, status: { privacyStatus, uploadStatus: "processed", ...extra } }] });

describe("YouTube resumable protocol and publication", () => {
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("starts private without subscriber notification and binds media size/type", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200, headers: { location: session } }));
    expect(await startYoutubeUpload(token, { title: "Lot 10", description: "Saved description" }, 8)).toBe(session);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain("notifySubscribers=false");
    expect(options).toMatchObject({ method: "POST", redirect: "manual", headers: { Authorization: `Bearer ${token}`, "X-Upload-Content-Length": "8", "X-Upload-Content-Type": "video/mp4" } });
    expect(JSON.parse(options.body)).toEqual({ snippet: { title: "Lot 10", description: "Saved description", categoryId: "2" }, status: { privacyStatus: "private", selfDeclaredMadeForKids: false } });
  });

  it("checks durable session position and sends exactly the requested chunk bytes", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 308, headers: { range: "bytes=0-3" } }));
    expect(await checkYoutubeUpload(token, session, 8)).toEqual({ offset: 4 });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: "PUT", headers: { "Content-Length": "0", "Content-Range": "bytes */8" } });
    fetchMock.mockResolvedValueOnce(json({ id: videoId }));
    const bytes = Buffer.from([0, 1, 2, 3]);
    expect(await sendYoutubeChunk(token, session, 8, 4, bytes)).toEqual({ videoId, url: `https://www.youtube.com/watch?v=${videoId}` });
    expect(fetchMock.mock.calls[1][1].headers["Content-Range"]).toBe("bytes 4-7/8");
    expect(Buffer.from(fetchMock.mock.calls[1][1].body)).toEqual(bytes);
  });

  it.each([false, true])("native fetch accepts resumable 308 (Location=%s) without following it", async (withLocation) => {
    const requests: Array<{ range?: string; bytes: number }> = [];
    const server = createServer((req, res) => {
      let bytes = 0;
      req.on("data", (chunk) => { bytes += chunk.length; });
      req.on("end", () => {
        requests.push({ range: req.headers["content-range"], bytes });
        if (req.headers["content-range"] === "bytes 4-7/8") {
          res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ id: videoId }));
        } else {
          res.writeHead(308, { Range: "bytes=0-3", ...(withLocation ? { Location: "/must-not-follow" } : {}) }); res.end();
        }
      });
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback test server unavailable");
    fetchMock.mockImplementation((_url, options) => nativeFetch(`http://127.0.0.1:${address.port}/session`, options));
    try {
      expect(await sendYoutubeChunk(token, session, 8, 0, Buffer.from("clip"))).toEqual({ offset: 4 });
      expect(await checkYoutubeUpload(token, session, 8)).toEqual({ offset: 4 });
      expect(await sendYoutubeChunk(token, session, 8, 4, Buffer.from("last"))).toEqual({ videoId, url: `https://www.youtube.com/watch?v=${videoId}` });
      expect(requests).toEqual([{ range: "bytes 0-3/8", bytes: 4 }, { range: "bytes */8", bytes: 0 }, { range: "bytes 4-7/8", bytes: 4 }]);
    } finally { await close(server); }
  });

  it.each([301, 302, 303, 307])("never follows an unexpected %s provider redirect with credentials or bytes", async (status) => {
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url || ""); req.resume();
      res.writeHead(status, { Location: "/must-not-follow" }); res.end();
    });
    await listen(server);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback test server unavailable");
    fetchMock.mockImplementation((_url, options) => nativeFetch(`http://127.0.0.1:${address.port}/session`, options));
    try {
      await expect(sendYoutubeChunk(token, session, 4, 0, Buffer.from("clip"))).rejects.toMatchObject({ code: "requestFailed", status });
      expect(paths).toEqual(["/session"]);
    } finally { await close(server); }
  });

  it.each([
    [new DOMException("secret timeout detail", "TimeoutError"), "YOUTUBE_TRANSPORT_TIMEOUT", "timed out"],
    [Object.assign(new Error("secret DNS detail"), { cause: { code: "EAI_AGAIN" } }), "YOUTUBE_DNS_UNAVAILABLE", "server could not find"],
    [Object.assign(new Error("secret socket detail"), { cause: { code: "ECONNRESET" } }), "YOUTUBE_CONNECTION_INTERRUPTED", "connection was interrupted"],
    [Object.assign(new Error("secret TLS detail"), { cause: { code: "CERT_HAS_EXPIRED" } }), "YOUTUBE_TLS_FAILED", "secure connection"],
    [Object.assign(new Error("secret arbitrary detail"), { cause: { code: "https://secret.invalid/token" } }), "YOUTUBE_TRANSPORT_UNCERTAIN", "did not confirm"],
  ])("exposes only allowlisted transport diagnostics %#", async (error, code, message) => {
    fetchMock.mockRejectedValueOnce(error);
    await expect(checkYoutubeUpload(token, session, 8)).rejects.toMatchObject({ code, message: expect.stringContaining(message as string) });
    fetchMock.mockRejectedValueOnce(error);
    await expect(checkYoutubeUpload(token, session, 8)).rejects.not.toThrow(/secret/);
  });

  it("retains the original supported video MIME type in session and chunk requests", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200, headers: { location: session } })).mockResolvedValueOnce(json({ id: videoId }));
    await startYoutubeUpload(token, { title: "Imported MOV", description: "Original clip" }, 4, "video/quicktime");
    await sendYoutubeChunk(token, session, 4, 0, Buffer.from("clip"), "video/quicktime");
    expect(fetchMock.mock.calls[0][1].headers["X-Upload-Content-Type"]).toBe("video/quicktime");
    expect(fetchMock.mock.calls[1][1].headers["Content-Type"]).toBe("video/quicktime");
  });

  it("rejects forged session destinations before transmitting authorization or media", async () => {
    await expect(checkYoutubeUpload(token, "https://evil.test/receive", 4)).rejects.toThrow();
    await expect(sendYoutubeChunk(token, "https://evil.test/receive", 4, 0, Buffer.from("test"))).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats lost responses as uncertain and returns safe errors without raw provider details", async () => {
    fetchMock.mockRejectedValueOnce(new Error("SECRET TRANSPORT URL"));
    await expect(sendYoutubeChunk(token, session, 4, 0, Buffer.from("test"))).rejects.toMatchObject({ code: "YOUTUBE_TRANSPORT_UNCERTAIN" });
    fetchMock.mockResolvedValueOnce(json({ error: { message: "SECRET DIAGNOSTIC", errors: [{ reason: "quotaExceeded" }] } }, 403));
    await expect(checkYoutubeUpload(token, session, 4)).rejects.toMatchObject({ code: "quotaExceeded", status: 403, message: expect.not.stringContaining("SECRET") });
  });

  it("does not replay publication when a retry discovers the video already public", async () => {
    fetchMock.mockResolvedValueOnce(video("private")).mockRejectedValueOnce(new Error("lost update response"));
    await expect(publishYoutubeVideo(token, videoId, "channel-1")).rejects.toMatchObject({ code: "YOUTUBE_TRANSPORT_UNCERTAIN" });
    fetchMock.mockResolvedValueOnce(video("public"));
    expect(await publishYoutubeVideo(token, videoId, "channel-1")).toBe(true);
    expect(fetchMock.mock.calls.filter(([, options]) => options.method === "PUT")).toHaveLength(1);
  });

  it("preserves writable status values and verifies visibility after publication", async () => {
    fetchMock.mockResolvedValueOnce(video("private", { license: "creativeCommon", embeddable: false, publicStatsViewable: false, selfDeclaredMadeForKids: true, containsSyntheticMedia: true, madeForKids: true })).mockResolvedValueOnce(json({ id: videoId })).mockResolvedValueOnce(video("public"));
    expect(await publishYoutubeVideo(token, videoId, "channel-1")).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ id: videoId, status: { privacyStatus: "public", license: "creativeCommon", embeddable: false, publicStatsViewable: false, selfDeclaredMadeForKids: true, containsSyntheticMedia: true } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("publishes exact reviewed metadata while retaining existing writable snippet settings", async () => {
    const metadata = { title: "Lot 023 — Last reviewed loader", description: "Final reviewed description" };
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: videoId, snippet: { channelId: "channel-1", title: "Old draft", description: "Old draft description", categoryId: "28", tags: ["equipment"], defaultLanguage: "en" }, status: { privacyStatus: "private", uploadStatus: "processed" } }] }))
      .mockResolvedValueOnce(json({ id: videoId })).mockResolvedValueOnce(video("public", {}, metadata));
    const authorize = vi.fn().mockResolvedValue(undefined);
    expect(await publishYoutubeVideo(token, videoId, "channel-1", authorize, metadata)).toBe(true);
    expect(authorize).toHaveBeenCalledOnce();
    expect(new URL(fetchMock.mock.calls[1][0]).searchParams.get("part")).toBe("snippet,status");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ id: videoId, status: { privacyStatus: "public" }, snippet: { ...metadata, categoryId: "28", tags: ["equipment"], defaultLanguage: "en" } });
  });

  it("changes existing public metadata only through exact explicit reviewed authorization", async () => {
    const metadata = { title: "Changed", description: "Changed" };
    fetchMock.mockResolvedValueOnce(video("public")).mockResolvedValueOnce(json({ id: videoId })).mockResolvedValueOnce(video("unlisted", {}, metadata));
    const authorize = vi.fn();
    expect(await publishYoutubeVideo(token, videoId, "channel-1", authorize, metadata, "unlisted")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).status.privacyStatus).toBe("unlisted");
    expect(authorize).toHaveBeenCalledOnce();
  });

  it("rechecks authorization after the provider read and before changing privacy", async () => {
    const authorize = vi.fn().mockRejectedValue(new Error("report release was revoked"));
    fetchMock.mockResolvedValueOnce(video("private"));
    await expect(publishYoutubeVideo(token, videoId, "channel-1", authorize)).rejects.toThrow("report release was revoked");
    expect(authorize).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
  });

  it("never updates a video belonging to another channel and reports forced-private outcomes", async () => {
    fetchMock.mockResolvedValueOnce(video("private"));
    await expect(publishYoutubeVideo(token, videoId, "other-channel")).rejects.toMatchObject({ code: "YOUTUBE_VIDEO_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock.mockReset().mockResolvedValueOnce(video("private")).mockResolvedValueOnce(json({ id: videoId })).mockResolvedValueOnce(video("private"));
    expect(await publishYoutubeVideo(token, videoId, "channel-1")).toBe(false);
  });

  it("refreshes only a bounded exact ID list and ignores foreign-channel or rejected entries", async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [
      { id: videoId, snippet: { channelId: "channel-1", title: "Provider title" }, status: { privacyStatus: "unlisted", uploadStatus: "processed" } },
      { id: "OtherVid_01", snippet: { channelId: "other" }, status: { privacyStatus: "public" } },
      { id: "RejectVid01", snippet: { channelId: "channel-1" }, status: { privacyStatus: "public", uploadStatus: "rejected" } },
    ] }));
    expect(await readYoutubeVideoStates(token, [videoId, "OtherVid_01", "RejectVid01"], "channel-1")).toEqual(new Map([[videoId, "unlisted"]]));
    expect(fetchMock.mock.calls[0][1].method).toBe("GET");
    for (const ids of [[], [videoId, videoId], ["forged&query=1"], Array.from({ length: 51 }, (_, i) => `abcdefgh${String(i).padStart(3, "0")}`)]) await expect(readYoutubeVideoStates(token, ids, "channel-1")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
