export type WorkspaceMode = "listings" | "crm";

const sharedPaths = ["/support", "/settings", "/notifications"];
const authPaths = ["/login", "/signup", "/verify-email", "/forgot-password", "/reset-password", "/device-access"];

export const pathMatches = (pathname: string, base: string) =>
  pathname === base || pathname.startsWith(`${base}/`);

/** A navigation preference only; CRM authorization always comes from the current user. */
export const workspaceStorageKey = (ownerId: string) => `cv-workspace:${ownerId}`;

export function routeWorkspace(pathname: string): WorkspaceMode | null {
  if (pathMatches(pathname, "/crm")) return "crm";
  if (pathname === "/workspaces" || sharedPaths.some((base) => pathMatches(pathname, base))) return null;
  return "listings";
}

/** Retain internal deep links, without allowing an external redirect or authentication loop. */
export function safeAppNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/workspaces";
  try {
    const decoded = decodeURIComponent(value);
    if (/[\\\u0000-\u001f\u007f]/.test(decoded) || decoded.startsWith("//")) return "/workspaces";
    const url = new URL(value, "https://workspace.invalid");
    if (url.origin !== "https://workspace.invalid") return "/workspaces";
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === "/" || pathname === "/welcome" || authPaths.some((base) => pathMatches(pathname, base))) return "/workspaces";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/workspaces";
  }
}
