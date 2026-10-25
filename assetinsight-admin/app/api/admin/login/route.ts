import { NextResponse } from "next/server";
import { SERVER_URL } from "@/lib/api";

export async function POST(request: Request) {
  try {
    const { email, password } = await request.json();

    const res = await fetch(`${SERVER_URL}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return NextResponse.json({ message: data?.message || "Login failed" }, { status: res.status });
    }

    const { accessToken, refreshToken, user } = data || {};

    const response = NextResponse.json({ user, role: user?.role }, { status: 200 });
    // Store short-lived access token for Authorization
    response.cookies.set("cv_admin", accessToken || "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 60, // 30 minutes
    });
    // Store long-lived refresh token
    if (refreshToken) {
      response.cookies.set("cv_admin_refresh", refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 7 * 24 * 60 * 60, // 7 days
      });
    }

    return response;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Login failed";
    return NextResponse.json({ message }, { status: 500 });
  }
}
