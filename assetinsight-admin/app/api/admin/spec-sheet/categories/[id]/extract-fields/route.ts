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
    const res = await fetch(url, { method: "POST", cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return (data?.accessToken as string) || null;
  } catch {
    return null;
  }
}

async function forwardExtraction(request: Request, id: string, token: string) {
  const formData = await request.formData();
  return fetch(`${SERVER_URL}/api/admin/spec-sheet/categories/${id}/extract-fields`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
    cache: "no-store",
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const token = request.cookies.get("cv_admin")?.value;
  if (!token) return NextResponse.json({ message: "Not authenticated" }, { status: 401 });

  const retryRequest = request.clone();
  let res = await forwardExtraction(request, id, token);
  if (res.status !== 401) {
    const data = await res.json().catch(() => ({}));
    return NextResponse.json(data, { status: res.status });
  }

  const newToken = await tryRefresh(request);
  if (!newToken) {
    const data = await res.json().catch(() => ({ message: "Unauthorized" }));
    return NextResponse.json(data, { status: 401 });
  }

  res = await forwardExtraction(retryRequest, id, newToken);
  const data = await res.json().catch(() => ({}));
  const response = NextResponse.json(data, { status: res.status });
  setAccessCookie(response, newToken);
  return response;
}
