import { NextResponse, type NextRequest } from "next/server";
import { SERVER_URL } from "@/lib/api";

function setAccessCookie(resp: NextResponse, token: string) {
  resp.cookies.set("cv_admin", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 60,
  });
}

async function tryRefresh(request: NextRequest): Promise<string | null> {
  try {
    const url = new URL("/api/admin/refresh", request.url);
    const res = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: { cookie: request.headers.get("cookie") || "" },
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return (data?.accessToken as string) || null;
  } catch {
    return null;
  }
}

export async function proxyJsonWithAdminAuth(
  request: NextRequest,
  targetPath: string,
  init: { method?: string; headers?: Record<string, string>; body?: BodyInit | undefined; replayAfterRefresh?: boolean } = {}
) {
  let token = request.cookies.get("cv_admin")?.value;
  let refreshedInitially = false;
  if (!token) {
    token = (await tryRefresh(request)) || undefined;
    refreshedInitially = Boolean(token);
  }
  if (!token) return NextResponse.json({ message: "Not authenticated" }, { status: 401 });

  const headers: Record<string, string> = {
    ...(init.headers || {}),
    Authorization: `Bearer ${token}`,
  };

  const res = await fetch(`${SERVER_URL}${targetPath}`, {
    method: init.method || "GET",
    headers,
    body: init.body,
    cache: "no-store",
  });

  if (res.status !== 401 || init.replayAfterRefresh === false) {
    if (res.status === 204) {
      const response = new NextResponse(null, { status: 204 });
      if (refreshedInitially) setAccessCookie(response, token);
      return response;
    }
    const data = await res.json().catch(() => ({}));
    const response = NextResponse.json(data, { status: res.status });
    if (refreshedInitially) setAccessCookie(response, token);
    return response;
  }

  // Attempt refresh
  const newToken = await tryRefresh(request);
  if (!newToken) {
    const data = await res.json().catch(() => ({ message: "Unauthorized" }));
    return NextResponse.json(data, { status: 401 });
  }

  const retried = await fetch(`${SERVER_URL}${targetPath}`, {
    method: init.method || "GET",
    headers: { ...(init.headers || {}), Authorization: `Bearer ${newToken}` },
    body: init.body,
    cache: "no-store",
  });

  if (retried.status === 204) {
    const response = new NextResponse(null, { status: 204 });
    setAccessCookie(response, newToken);
    return response;
  }
  const data = await retried.json().catch(() => ({}));
  const response = NextResponse.json(data, { status: retried.status });
  setAccessCookie(response, newToken);
  return response;
}

export async function proxyStreamWithAdminAuth(
  request: NextRequest,
  targetPath: string
) {
  let token = request.cookies.get("cv_admin")?.value;
  let refreshedInitially = false;
  if (!token) {
    token = (await tryRefresh(request)) || undefined;
    refreshedInitially = Boolean(token);
  }
  if (!token) return NextResponse.json({ message: "Not authenticated" }, { status: 401 });

  const doFetch = (auth: string) =>
    fetch(`${SERVER_URL}${targetPath}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${auth}` },
      cache: "no-store",
    });

  let res = await doFetch(token);
  if (res.status === 401) {
    const newToken = await tryRefresh(request);
    if (!newToken) {
      const err = await res.json().catch(() => ({ message: "Unauthorized" }));
      return NextResponse.json(err, { status: 401 });
    }
    res = await doFetch(newToken);
    const response = streamedAdminResponse(res);
    setAccessCookie(response, newToken);
    return response;
  }

  const response = streamedAdminResponse(res);
  if (refreshedInitially) setAccessCookie(response, token);
  return response;
}

function streamedAdminResponse(upstream: Response) {
  const headers = new Headers();
  const contentType =
    upstream.headers.get("content-type") || "application/octet-stream";
  const contentDisposition = upstream.headers.get("content-disposition");

  headers.set("content-type", contentType);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  if (contentDisposition) {
    headers.set("content-disposition", contentDisposition);
  }

  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers,
  });
}

/**
 * Forward multipart uploads without materializing FormData in the Next.js
 * process. The body is a one-shot stream, so authentication is refreshed
 * before forwarding and the upload is never replayed after consumption.
 */
export async function proxyMultipartWithAdminAuth(request: NextRequest, targetPath: string) {
  const currentToken = request.cookies.get("cv_admin")?.value;
  const refreshedToken = await tryRefresh(request);
  const token = refreshedToken || currentToken;
  if (!token) return NextResponse.json({ message: "Not authenticated" }, { status: 401 });

  const contentType = request.headers.get("content-type");
  if (!contentType?.toLowerCase().startsWith("multipart/form-data")) {
    return NextResponse.json({ message: "A multipart form upload is required" }, { status: 400 });
  }

  const headers = new Headers({ Authorization: `Bearer ${token}` });
  headers.set("content-type", contentType);
  const contentLength = request.headers.get("content-length");
  if (contentLength) headers.set("content-length", contentLength);

  const response = await fetch(`${SERVER_URL}${targetPath}`, {
    method: request.method,
    headers,
    body: request.body,
    cache: "no-store",
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  const responseText = await response.text();
  let data: Record<string, unknown>;
  try {
    data = responseText ? JSON.parse(responseText) : {};
  } catch {
    data = { message: responseText || "The upload could not be processed" };
  }
  const proxied = NextResponse.json(data, { status: response.status });
  if (refreshedToken) setAccessCookie(proxied, refreshedToken);
  return proxied;
}
