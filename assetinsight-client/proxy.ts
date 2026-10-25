import { NextResponse, type NextRequest } from "next/server";
import { safeAppNextPath } from "@/lib/workspace";

const ACCESS_COOKIE = "cv_access_token";
const REFRESH_COOKIE = "cv_refresh_token";
const DEVICE_PENDING_COOKIE = "cv_device_pending";

function isPublicPath(pathname: string) {
  return (
    pathname === "/" ||
    pathname === "/welcome" ||
    pathname === "/privacy" ||
    pathname === "/account-deletion" ||
    pathname === "/terms/youtube" ||
    pathname.startsWith("/login") ||
    pathname.startsWith("/signup") ||
    pathname.startsWith("/verify-email") ||
    pathname.startsWith("/forgot-password") ||
    pathname.startsWith("/reset-password")
    || pathname.startsWith("/device-access")
  );
}

function isAuthPath(pathname: string) {
  return (
    pathname.startsWith("/login") ||
    pathname.startsWith("/signup") ||
    pathname.startsWith("/verify-email") ||
    pathname.startsWith("/forgot-password") ||
    pathname.startsWith("/reset-password")
  );
}

function getSessionState(request: NextRequest) {
  const hasAccessToken = Boolean(request.cookies.get(ACCESS_COOKIE)?.value);
  const hasRefreshToken = Boolean(request.cookies.get(REFRESH_COOKIE)?.value);

  return hasAccessToken || hasRefreshToken;
}

function getSafeNextPath(request: NextRequest) {
  return safeAppNextPath(request.nextUrl.searchParams.get("next"));
}

export function proxy(request: NextRequest) {
  const { nextUrl } = request;
  const pathname = nextUrl.pathname;
  const hasSession = getSessionState(request);
  const hasDeviceRequest = Boolean(request.cookies.get(DEVICE_PENDING_COOKIE)?.value);

  if (hasDeviceRequest && !hasSession && !isPublicPath(pathname)) {
    const deviceUrl = new URL("/device-access", request.url);
    deviceUrl.searchParams.set("next", `${pathname}${nextUrl.search}`);
    return NextResponse.redirect(deviceUrl);
  }

  if (pathname.startsWith("/device-access") && hasSession && !hasDeviceRequest) {
    return NextResponse.redirect(new URL(getSafeNextPath(request), request.url));
  }

  if (!hasSession && !isPublicPath(pathname)) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", `${pathname}${nextUrl.search}`);
    return NextResponse.redirect(loginUrl);
  }

  if (isAuthPath(pathname) && hasSession) {
    return NextResponse.redirect(new URL(getSafeNextPath(request), request.url));
  }

  if (hasSession && (pathname === "/" || pathname === "/welcome")) {
    return NextResponse.redirect(new URL("/workspaces", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
