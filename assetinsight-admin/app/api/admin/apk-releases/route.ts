import { NextResponse, type NextRequest } from "next/server";
import { SERVER_URL } from "@/lib/api";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function normalizeErrorMessage(text: string, fallback: string): string {
  if (!text) return fallback;
  const preMatch = text.match(/<pre>([\s\S]*?)<\/pre>/i);
  const body = preMatch?.[1] || text;
  return body
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500) || fallback;
}

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

function getMultipartContentType(request: NextRequest): string {
  const contentType = request.headers.get("content-type");
  if (!contentType?.includes("multipart/form-data")) {
    throw new Error("Multipart APK upload is required");
  }
  return contentType;
}

async function forwardUpload(request: NextRequest, token: string, contentType: string) {
  const body = Buffer.from(await request.arrayBuffer());
  if (body.length === 0) {
    throw new Error("APK upload body is empty");
  }

  return fetch(`${SERVER_URL}/api/admin/apk-releases`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": contentType,
      "content-length": String(body.length),
    },
    body,
    cache: "no-store",
  });
}

export async function GET(request: NextRequest) {
  return proxyJsonWithAdminAuth(request, "/api/admin/apk-releases");
}

export async function POST(request: NextRequest) {
  try {
    const existingToken = request.cookies.get("cv_admin")?.value;
    if (!existingToken) return NextResponse.json({ message: "Not authenticated" }, { status: 401 });

    // Refresh before reading and forwarding the upload so expired admin tokens
    // do not force a second parse of the APK body.
    const refreshedToken = await tryRefresh(request);
    const token = refreshedToken || existingToken;
    const contentType = getMultipartContentType(request);
    const res = await forwardUpload(request, token, contentType);
    const text = await res.text();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { message: normalizeErrorMessage(text, "Failed to upload APK") };
    }
    const response = NextResponse.json(data, { status: res.status });
    if (refreshedToken) setAccessCookie(response, refreshedToken);
    return response;
  } catch (error: any) {
    return NextResponse.json(
      { message: error?.message || "Failed to upload APK. Please try again." },
      { status: 502 }
    );
  }
}
