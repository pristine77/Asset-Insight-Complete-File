import { NextResponse, type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";
import { PreviewResubmitRequestError, readPreviewMutationJson } from "@/lib/previewResubmitRequest";
import { parseYouTubeAuthorization, parseYouTubeStatus, youtubeCompleteBody, youtubeConnectBody, youtubeDisconnectBody, youtubeEraseBody, youtubeConnectionFailure } from "@/lib/youtube";

export async function youtubeProxy(request: NextRequest, action: "status" | "connect" | "complete" | "disconnect" | "revoke" | "erase-data" | "acknowledge-revocation") {
  let body: string | undefined;
  if (action !== "status") {
    try {
      const input = await readPreviewMutationJson(request, action === "complete" ? 8192 : 1024);
      const parsed = action === "connect" ? youtubeConnectBody(input) : action === "complete" ? youtubeCompleteBody(input) : action === "revoke" || action === "erase-data" || action === "acknowledge-revocation" ? youtubeEraseBody(input) : youtubeDisconnectBody(input);
      body = JSON.stringify(parsed);
    } catch (error) {
      return NextResponse.json({ message: error instanceof Error ? error.message : "Invalid connection request." }, { status: error instanceof PreviewResubmitRequestError ? error.status : 400, headers: { "Cache-Control": "no-store" } });
    }
  }
  try {
    const response = await proxyJsonWithAdminAuth(request, `/api/admin/youtube/${action}`, {
      method: action === "status" ? "GET" : "POST",
      ...(body ? { headers: { "Content-Type": "application/json" }, body } : {}),
      replayAfterRefresh: action === "status",
    });
    const payload: unknown = await response.json();
    // Return only this integration's public DTO, never upstream token fields.
    const result = response.ok
      ? action === "connect" ? parseYouTubeAuthorization(payload) : parseYouTubeStatus(payload)
      : { ...(action === "complete" ? youtubeConnectionFailure(payload, response.status) : { message: safeIssue(payload) }), ...(response.status === 401 ? { signInRequired: true } : {}) };
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("Referrer-Policy", "no-referrer");
    return NextResponse.json(result, { status: response.status, headers });
  } catch {
    return NextResponse.json({ message: action === "status" ? "The YouTube connection could not be loaded. Refresh to try again." : "The connection change could not be confirmed. Refresh the connection status before starting again." }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
function safeIssue(value: unknown): string {
  // Backend owns safe user-facing error text; never expose arbitrary provider bodies.
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string" && value.message.length <= 1000 && !/[\x00-\x1f\x7f]/.test(value.message)) return value.message;
  return "This YouTube action could not be completed. Refresh the connection status and try again.";
}
