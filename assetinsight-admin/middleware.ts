import { NextResponse, type NextRequest } from "next/server";

const AUTH_COOKIE = "cv_admin";

function tokenNeedsRefresh(token?: string) {
  if (!token) return true;
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))) as {
      exp?: number;
    };
    return !payload.exp || payload.exp <= Math.floor(Date.now() / 1000) + 30;
  } catch {
    return true;
  }
}

function nextWithAccessToken(request: NextRequest, accessToken: string) {
  const headers = new Headers(request.headers);
  const existing = (headers.get("cookie") || "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${AUTH_COOKIE}=`));
  existing.push(`${AUTH_COOKIE}=${accessToken}`);
  headers.set("cookie", existing.join("; "));
  const response = nextAdminPage(request, headers);
  response.cookies.set(AUTH_COOKIE, accessToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 60,
  });
  return response;
}

function nextAdminPage(request: NextRequest, headers?: Headers) {
  const options = headers ? { request: { headers } } : undefined;
  if (request.nextUrl.pathname === "/youtube/callback" && request.nextUrl.search) {
    // Keep the browser callback for one-time client consumption, but exclude
    // provider codes/state from Next's serialized server-component payload.
    const renderUrl = request.nextUrl.clone();
    renderUrl.search = "";
    const response = NextResponse.rewrite(renderUrl, options);
    response.headers.set("Referrer-Policy", "no-referrer");
    return response;
  }
  return NextResponse.next(options);
}

function isAuthPath(pathname: string) {
  return pathname.startsWith("/login");
}

function isPublicPath(pathname: string) {
  return pathname === "/api-documentation";
}

export async function middleware(request: NextRequest) {
  const { nextUrl, cookies } = request;
  const pathname = nextUrl.pathname;

  // Allow static assets
  if (pathname.endsWith(".png") || pathname.endsWith(".svg") || pathname.endsWith(".ico")) {
    return NextResponse.next();
  }

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  const accessToken = cookies.get(AUTH_COOKIE)?.value;
  const refreshToken = cookies.get("cv_admin_refresh")?.value;
  const hasSession = Boolean(accessToken) && !tokenNeedsRefresh(accessToken);
  const hasRefresh = Boolean(refreshToken);

  // If no access token but refresh exists, try to refresh silently
  if (!hasSession && hasRefresh && !isAuthPath(pathname)) {
    try {
      const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:4000";
      const refreshRes = await fetch(`${serverUrl}/api/admin/refresh`, {
        method: "POST",
        headers: { "x-refresh-token": refreshToken as string },
        cache: "no-store",
      });
      if (refreshRes.ok) {
        const data = await refreshRes.json().catch(() => ({}));
        const refreshedAccessToken = data?.accessToken as string | undefined;
        if (refreshedAccessToken) {
          return nextWithAccessToken(request, refreshedAccessToken);
        }
      }
    } catch {}
  }

  // Protect all non-auth pages (including "/")
  if (!hasSession && !isAuthPath(pathname)) {
    const url = new URL("/login", request.url);
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  // Expiry is only a navigation hint: a revoked/blocked session can still have
  // an unexpired cookie. Verify it before bouncing away from login, otherwise
  // the protected page and login redirect to each other indefinitely.
  if (isAuthPath(pathname) && hasSession) {
    try {
      const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:4000";
      const response = await fetch(`${serverUrl}/api/admin/me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        const payload = await response.json().catch(() => ({}));
        if (payload.user?.role === "admin" || payload.user?.role === "superadmin") {
          return NextResponse.redirect(new URL("/reports", request.url));
        }
      } else if (response.status === 401 || response.status === 403) {
        const login = NextResponse.next();
        login.cookies.delete(AUTH_COOKIE);
        login.cookies.delete("cv_admin_refresh");
        return login;
      }
    } catch {
      // A temporary outage must not discard a session. Keep login reachable.
    }
  }

  return nextAdminPage(request);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|assets|public).*)"],
};
