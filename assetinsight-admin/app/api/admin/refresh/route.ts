import { NextResponse, type NextRequest } from "next/server";
import { SERVER_URL } from "@/lib/api";

export async function POST(request: NextRequest) {
  try {
    const refresh = request.cookies.get("cv_admin_refresh")?.value;
    if (!refresh) {
      return NextResponse.json({ message: "No refresh token" }, { status: 401 });
    }

    const res = await fetch(`${SERVER_URL}/api/admin/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-refresh-token": refresh,
      },
      cache: "no-store",
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json({ message: data?.message || "Failed to refresh" }, { status: res.status });
    }

    const accessToken = data?.accessToken as string | undefined;
    if (!accessToken) {
      return NextResponse.json({ message: "No access token returned" }, { status: 500 });
    }

    const response = NextResponse.json({ accessToken }, { status: 200 });
    response.cookies.set("cv_admin", accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 60,
    });
    return response;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to refresh";
    return NextResponse.json({ message }, { status: 500 });
  }
}
