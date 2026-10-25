import { deleteCookie, setCookie } from "./cookies";

export type Tokens = {
  accessToken: string;
  refreshToken: string;
};

export const ACCESS_KEY = "cv_access_token";
export const REFRESH_KEY = "cv_refresh_token";
export const AUTH_COOKIE = "cv_auth";

const COOKIE_DAYS = 7;

let sessionRevision = 0;
let observedRefreshToken: string | null | undefined;
export type AuthSessionSnapshot = { revision: number };

/** Token rotation stays in one session; login/logout/restriction starts a new one. */
export function captureAuthSession(): AuthSessionSnapshot {
  const refreshToken = getRefreshToken();
  if (observedRefreshToken !== undefined && observedRefreshToken !== refreshToken) sessionRevision += 1;
  observedRefreshToken = refreshToken;
  // Keep the refresh credential out of Axios request/error configuration.
  return { revision: sessionRevision };
}

export function isAuthSessionCurrent(session: AuthSessionSnapshot): boolean {
  return session.revision === captureAuthSession().revision;
}

export function advanceAuthSession(): AuthSessionSnapshot {
  sessionRevision += 1;
  return captureAuthSession();
}

export class AuthSessionChangedError extends Error {
  readonly code = "ERR_CANCELED";
  readonly __CANCEL__ = true;
  constructor() { super("The account session changed. Please try again in the current session."); this.name = "CanceledError"; }
}

export function assertAuthSessionCurrent(session: AuthSessionSnapshot): void {
  if (!isAuthSessionCurrent(session)) throw new AuthSessionChangedError();
}

export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(ACCESS_KEY);
  } catch {
    return null;
  }
}

export function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

export function hasStoredTokens(): boolean {
  return Boolean(getAccessToken() || getRefreshToken());
}

export function setTokens(tokens: Tokens) {
  advanceAuthSession();
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(ACCESS_KEY, tokens.accessToken);
    localStorage.setItem(REFRESH_KEY, tokens.refreshToken);
  } catch {}

  setCookie(ACCESS_KEY, tokens.accessToken, COOKIE_DAYS);
  setCookie(REFRESH_KEY, tokens.refreshToken, COOKIE_DAYS);
  setCookie(AUTH_COOKIE, "1", COOKIE_DAYS);
}

export function setAccessToken(accessToken: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(ACCESS_KEY, accessToken);
  } catch {}

  setCookie(ACCESS_KEY, accessToken, COOKIE_DAYS);
  setCookie(AUTH_COOKIE, "1", COOKIE_DAYS);
}

export function clearTokens() {
  advanceAuthSession();
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  } catch {}

  deleteCookie(ACCESS_KEY);
  deleteCookie(REFRESH_KEY);
  deleteCookie(AUTH_COOKIE);
}
