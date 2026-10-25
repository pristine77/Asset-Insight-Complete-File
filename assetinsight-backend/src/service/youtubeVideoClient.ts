import { validateYoutubeSessionUrl, youtubeUploadOffset, youtubeWatchUrl, type YoutubePrivacyStatus } from "./youtubeVideoPolicy.js";

export class YoutubeProviderError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) { super(message); }
}

function transportFailure(error: unknown): YoutubeProviderError {
  // Never persist raw fetch messages/causes: they may contain upload capabilities
  // or credentials. Only known transport categories may cross this boundary.
  const codes = new Set<string>();
  let cause: any = error;
  for (let depth = 0; cause && typeof cause === "object" && depth < 4; depth += 1, cause = cause.cause) {
    if (typeof cause.code === "string") codes.add(cause.code);
    if (cause.name === "TimeoutError") codes.add("ETIMEDOUT");
  }
  const has = (...values: string[]) => values.some((value) => codes.has(value));
  const retry = " Retry checks the same upload before sending more data.";
  if (has("ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT")) {
    return new YoutubeProviderError("YOUTUBE_TRANSPORT_TIMEOUT", `The connection to YouTube timed out.${retry}`);
  }
  if (has("ENOTFOUND", "EAI_AGAIN")) {
    return new YoutubeProviderError("YOUTUBE_DNS_UNAVAILABLE", `The server could not find YouTube's network address.${retry}`);
  }
  if (has("CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN")) {
    return new YoutubeProviderError("YOUTUBE_TLS_FAILED", `The server could not establish a trusted secure connection to YouTube.${retry}`);
  }
  if (has("ECONNRESET", "ECONNREFUSED", "EPIPE", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_SOCKET")) {
    return new YoutubeProviderError("YOUTUBE_CONNECTION_INTERRUPTED", `The server's YouTube connection was interrupted.${retry}`);
  }
  return new YoutubeProviderError("YOUTUBE_TRANSPORT_UNCERTAIN", `YouTube did not confirm the request.${retry}`);
}

async function request(url: string, token: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, {
      ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` },
      // YouTube's resumable protocol uses 308 Resume Incomplete, which native
      // fetch treats as a redirect even without Location. Inspect it ourselves;
      // manual mode never forwards credentials/media to a redirected endpoint.
      redirect: "manual", signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    throw transportFailure(error);
  }
}
async function failure(response: Response): Promise<never> {
  const body: any = await response.json().catch(() => ({}));
  const reason = String(body?.error?.errors?.[0]?.reason || "");
  const code = ["quotaExceeded", "uploadLimitExceeded", "forbiddenPrivacySetting", "insufficientPermissions", "invalidGrant"].includes(reason) ? reason : "requestFailed";
  const message = code === "quotaExceeded" || code === "uploadLimitExceeded"
    ? "YouTube upload quota was reached. Wait for the channel quota to reset, then retry."
    : code === "forbiddenPrivacySetting"
      ? "YouTube has not allowed public visibility. Check the Google API project audit and channel permissions."
      : `YouTube request failed (${response.status}). Check the admin channel connection before retrying.`;
  throw new YoutubeProviderError(code, message, response.status);
}

export async function startYoutubeUpload(token: string, metadata: { title: string; description: string }, size: number, contentType = "video/mp4"): Promise<string> {
  const response = await request("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers=false", token, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Upload-Content-Length": String(size), "X-Upload-Content-Type": contentType },
    body: JSON.stringify({ snippet: { ...metadata, categoryId: "2" }, status: { privacyStatus: "private", selfDeclaredMadeForKids: false } }),
  });
  if (!response.ok) await failure(response);
  return validateYoutubeSessionUrl(response.headers.get("location") || "");
}

export type YoutubeUploadResult = { videoId: string; url: string } | { offset: number };
async function uploadResult(response: Response, size: number): Promise<YoutubeUploadResult> {
  if (response.status === 308) return { offset: youtubeUploadOffset(response.headers.get("range"), size) };
  if (!response.ok) await failure(response);
  const body: any = await response.json();
  return { videoId: String(body.id), url: youtubeWatchUrl(body.id) };
}
export async function checkYoutubeUpload(token: string, sessionUrl: string, size: number) {
  return uploadResult(await request(validateYoutubeSessionUrl(sessionUrl), token, {
    method: "PUT", headers: { "Content-Length": "0", "Content-Range": `bytes */${size}` },
  }), size);
}
export async function sendYoutubeChunk(token: string, sessionUrl: string, size: number, offset: number, bytes: Buffer, contentType = "video/mp4") {
  return uploadResult(await request(validateYoutubeSessionUrl(sessionUrl), token, {
    method: "PUT", headers: { "Content-Type": contentType, "Content-Length": String(bytes.length), "Content-Range": `bytes ${offset}-${offset + bytes.length - 1}/${size}` },
    body: new Uint8Array(bytes),
  }), size);
}

export async function publishYoutubeVideo(token: string, videoId: string, channelId: string, assertAuthorized: () => Promise<void> = async () => {}, metadata?: { title: string; description: string }, privacyStatus: YoutubePrivacyStatus = "public"): Promise<boolean> {
  youtubeWatchUrl(videoId);
  const read = async () => {
    const response = await request(`https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=${videoId}`, token, { method: "GET" });
    if (!response.ok) await failure(response);
    const body: any = await response.json();
    const video = body?.items?.find((item: any) => item.id === videoId);
    if (video?.snippet?.channelId !== channelId) throw new YoutubeProviderError("YOUTUBE_VIDEO_UNAVAILABLE", "The uploaded video is unavailable in the connected channel.");
    return video;
  };
  const video = await read();
  if (video.status?.privacyStatus === privacyStatus && (!metadata ||
    (video.snippet?.title === metadata.title && video.snippet?.description === metadata.description))) return true;
  if (["failed", "rejected", "deleted"].includes(video.status?.uploadStatus)) throw new YoutubeProviderError("YOUTUBE_VIDEO_REJECTED", "YouTube could not process this video. Review it in YouTube Studio.");
  // Do not erase unrelated mutable status fields when updating visibility.
  const status: Record<string, unknown> = { privacyStatus };
  for (const key of ["license", "embeddable", "publicStatsViewable", "selfDeclaredMadeForKids", "containsSyntheticMedia"]) {
    if (video.status?.[key] !== undefined) status[key] = video.status[key];
  }
  await assertAuthorized();
  const response = await request(`https://www.googleapis.com/youtube/v3/videos?part=${metadata ? "snippet,status" : "status"}`, token, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: videoId, status,
      ...(metadata ? { snippet: { title: metadata.title, description: metadata.description, categoryId: video.snippet.categoryId || "2",
        ...(video.snippet.tags ? { tags: video.snippet.tags } : {}), ...(video.snippet.defaultLanguage ? { defaultLanguage: video.snippet.defaultLanguage } : {}),
      } } : {}),
    }),
  });
  if (!response.ok) await failure(response);
  const confirmed = await read();
  return confirmed.status?.privacyStatus === privacyStatus && (!metadata ||
    (confirmed.snippet?.title === metadata.title && confirmed.snippet?.description === metadata.description));
}

/** One bounded metadata read. Never changes visibility or upload bytes. */
export async function readYoutubeVideoStates(token: string, ids: string[], channelId: string): Promise<Map<string, YoutubePrivacyStatus>> {
  if (!ids.length || ids.length > 50 || new Set(ids).size !== ids.length) throw new Error("A bounded unique video list is required.");
  ids.forEach(youtubeWatchUrl);
  const response = await request(`https://www.googleapis.com/youtube/v3/videos?part=snippet,status&id=${ids.join(",")}`, token, { method: "GET" });
  if (!response.ok) await failure(response);
  const body: any = await response.json();
  const result = new Map<string, YoutubePrivacyStatus>();
  for (const video of Array.isArray(body?.items) ? body.items : []) {
    if (ids.includes(video?.id) && video?.snippet?.channelId === channelId &&
      ["private", "unlisted", "public"].includes(video?.status?.privacyStatus) &&
      !["failed", "rejected", "deleted"].includes(video?.status?.uploadStatus)) result.set(video.id, video.status.privacyStatus);
  }
  return result;
}
