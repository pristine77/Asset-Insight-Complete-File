import { NextResponse, type NextRequest } from "next/server";

import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";
import { SERVER_URL } from "@/lib/api";

const SAFE_PATH_SEGMENT = /^[a-zA-Z0-9_-]+$/;
const SUPPORT_ID = /^[a-fA-F0-9]{24}$/;
const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000;

type RouteContext = { params: Promise<{ path: string[] }> };
type StreamRequestInit = RequestInit & { duplex: "half" };

/**
 * Support mutations use the admin session cookies, so they must originate from
 * this application. Sec-Fetch-Site covers modern browsers; Origin is checked as
 * an independent defence and also makes non-browser integrations explicit.
 */
function rejectNonSameOriginMutation(request: NextRequest): NextResponse | null {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    return NextResponse.json(
      { code: "CROSS_SITE_REQUEST", message: "Cross-site requests are not allowed" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  const origin = request.headers.get("origin");
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",", 1)[0]?.trim();
  const requestHost = forwardedHost || request.headers.get("host");
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim();
  const requestProto = forwardedProto || new URL(request.url).protocol.replace(/:$/, "");
  const expectedOrigin = requestHost ? `${requestProto}://${requestHost}` : new URL(request.url).origin;
  if (origin && origin !== expectedOrigin) {
    return NextResponse.json(
      { code: "INVALID_ORIGIN", message: "Request origin is not allowed" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }
  return null;
}

function isStreamedAttachmentUpload(method: string, path: string[]): boolean {
  return method === "POST"
    && path.length === 4
    && path[0] === "conversations"
    && SUPPORT_ID.test(path[1])
    && path[2] === "attachments"
    && path[3] === "upload";
}

/**
 * This gateway deliberately exposes only the requester-facing support
 * surface. The upstream ownership checks remain authoritative, while this
 * allow-list prevents an admin browser from reaching developer queue, agent,
 * note, todo, assignment, or status-management endpoints through the proxy.
 */
function isAllowedCustomerRoute(method: string, path: string[]): boolean {
  if (method === "GET" && path.length === 1 && path[0] === "constraints") {
    return true;
  }
  if (path.length === 1 && path[0] === "conversations") {
    return method === "GET" || method === "POST";
  }
  if (
    method === "GET"
    && path.length === 2
    && path[0] === "conversations"
    && SUPPORT_ID.test(path[1])
  ) {
    return true;
  }
  if (
    path.length === 3
    && path[0] === "conversations"
    && SUPPORT_ID.test(path[1])
    && path[2] === "messages"
  ) {
    return method === "GET" || method === "POST";
  }
  if (
    method === "POST"
    && path.length === 3
    && path[0] === "conversations"
    && SUPPORT_ID.test(path[1])
    && path[2] === "read"
  ) {
    return true;
  }
  return isStreamedAttachmentUpload(method, path);
}

function setAccessCookie(response: NextResponse, token: string): void {
  response.cookies.set("cv_admin", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 60,
  });
}

/** Refresh directly against the API before consuming a one-shot upload body. */
async function refreshAccessToken(request: NextRequest): Promise<string | null> {
  const refreshToken = request.cookies.get("cv_admin_refresh")?.value;
  if (!refreshToken) return null;

  try {
    const response = await fetch(`${SERVER_URL}/api/admin/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-refresh-token": refreshToken,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null) as { accessToken?: unknown } | null;
    return typeof payload?.accessToken === "string" && payload.accessToken
      ? payload.accessToken
      : null;
  } catch {
    return null;
  }
}

function validDeclaredSize(value: string | null): boolean {
  if (!value || !/^\d+$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0;
}

/**
 * Streams authenticated media to the ownership-scoped customer endpoint
 * exactly once. A consumed request stream cannot safely be replayed, so an
 * available refresh token is used proactively and a 401 is returned to the
 * browser without retrying upstream.
 */
async function proxyAttachmentUpload(
  request: NextRequest,
  upstreamPath: string,
): Promise<NextResponse> {
  const fileName = new URL(request.url).searchParams.get("fileName")?.trim();
  if (!fileName || fileName.length > 240) {
    return NextResponse.json(
      { code: "VALIDATION_ERROR", message: "A valid fileName is required" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!request.body) {
    return NextResponse.json(
      { code: "VALIDATION_ERROR", message: "An upload body is required" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const contentType = request.headers.get("content-type");
  const contentLength = request.headers.get("content-length");
  const explicitFileSize = request.headers.get("x-file-size");
  const declaredSize = explicitFileSize || contentLength;
  if (!contentType || !validDeclaredSize(declaredSize)) {
    return NextResponse.json(
      { code: "VALIDATION_ERROR", message: "Upload content type and file size are required" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  const hasRefreshToken = Boolean(request.cookies.get("cv_admin_refresh")?.value);
  const refreshedToken = hasRefreshToken ? await refreshAccessToken(request) : null;
  const currentToken = request.cookies.get("cv_admin")?.value || null;
  // A refresh service outage must not discard an access token that is still
  // valid. Either token is selected before the one-shot body is consumed.
  const accessToken = refreshedToken || currentToken;
  if (!accessToken) {
    return NextResponse.json(
      { code: "AUTHENTICATION_REQUIRED", message: "Not authenticated" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": contentType,
  });
  if (contentLength) headers.set("Content-Length", contentLength);
  if (explicitFileSize) headers.set("X-File-Size", explicitFileSize);

  let upstream: Response;
  const uploadTimeout = AbortSignal.timeout(UPLOAD_TIMEOUT_MS);
  try {
    upstream = await fetch(`${SERVER_URL}${upstreamPath}`, {
      method: "POST",
      headers,
      body: request.body,
      cache: "no-store",
      duplex: "half",
      signal: AbortSignal.any([request.signal, uploadTimeout]),
    } as StreamRequestInit);
  } catch (error: unknown) {
    // AbortSignal.any may surface either TimeoutError or AbortError depending
    // on the Node.js release, so also inspect the dedicated timeout signal.
    const timedOut = uploadTimeout.aborted && !request.signal.aborted
      || (error instanceof DOMException && error.name === "TimeoutError");
    return NextResponse.json(
      {
        code: timedOut ? "UPLOAD_TIMEOUT" : "UPLOAD_GATEWAY_ERROR",
        message: timedOut ? "The upload timed out" : "The upload could not reach the support service",
      },
      { status: timedOut ? 504 : 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  const response = new NextResponse(upstream.body, {
    status: upstream.status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
    },
  });
  if (refreshedToken) setAccessCookie(response, refreshedToken);
  return response;
}

async function proxy(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  if (request.method === "POST" || request.method === "PATCH") {
    const rejected = rejectNonSameOriginMutation(request);
    if (rejected) return rejected;
  }

  const { path } = await context.params;
  if (!path?.length || path.some((segment) => !SAFE_PATH_SEGMENT.test(segment))) {
    return NextResponse.json(
      { code: "INVALID_SUPPORT_ROUTE", message: "Invalid support route" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (!isAllowedCustomerRoute(request.method, path)) {
    return NextResponse.json(
      { code: "INVALID_SUPPORT_ROUTE", message: "Unsupported customer support route" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }

  const requestUrl = new URL(request.url);
  const upstreamPath = `/api/support/${path.map(encodeURIComponent).join("/")}${requestUrl.search}`;
  if (isStreamedAttachmentUpload(request.method, path)) {
    return proxyAttachmentUpload(request, upstreamPath);
  }

  const body = request.method === "GET" || request.method === "HEAD"
    ? undefined
    : await request.arrayBuffer();
  const contentType = request.headers.get("content-type");
  const response = await proxyJsonWithAdminAuth(request, upstreamPath, {
    method: request.method,
    headers: contentType ? { "Content-Type": contentType, Accept: "application/json" } : { Accept: "application/json" },
    body,
  });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function methodNotAllowed(): NextResponse {
  return NextResponse.json(
    { code: "METHOD_NOT_ALLOWED", message: "Only customer support reads and submissions are allowed" },
    {
      status: 405,
      headers: {
        Allow: "GET, POST",
        "Cache-Control": "no-store",
      },
    },
  );
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const GET = proxy;
export const POST = proxy;
export const DELETE = methodNotAllowed;
export const HEAD = methodNotAllowed;
export const OPTIONS = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const PUT = methodNotAllowed;
