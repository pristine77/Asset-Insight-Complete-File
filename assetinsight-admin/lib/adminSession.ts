/** Account transitions invalidate open editors before cookies can change. */
export const ADMIN_SESSION_EVENT = "asset-insight-admin-session-change";
export const ADMIN_SESSION_STORAGE = "asset-insight-admin-session-generation";
export function notifyAdminSessionChange() {
  const generation = crypto.randomUUID();
  // Same-window listeners run synchronously; storage notifies other tabs.
  window.dispatchEvent(new Event(ADMIN_SESSION_EVENT));
  try { window.localStorage.setItem(ADMIN_SESSION_STORAGE, generation); } catch { /* /me still fences saves. */ }
}
