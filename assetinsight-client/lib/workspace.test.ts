import { describe, expect, it } from "vitest";
import { routeWorkspace, safeAppNextPath, workspaceStorageKey } from "./workspace";

describe("workspace navigation policy", () => {
  it.each(["/crm", "/crm/tasks", "/crm/outlook", "/crm/coverage"])("identifies explicit CRM route %s", (path) => expect(routeWorkspace(path)).toBe("crm"));
  it.each(["/dashboard", "/incoming/id", "/previews", "/reports/id", "/create/asset", "/crm-old"])("preserves explicit Listings route %s", (path) => expect(routeWorkspace(path)).toBe("listings"));
  it.each(["/workspaces", "/settings", "/support/conversation", "/notifications"])("shared route has no forced workspace %s", (path) => expect(routeWorkspace(path)).toBeNull());
  it("scopes preferences to owner identity, never contract or role", () => expect(workspaceStorageKey("a")).not.toBe(workspaceStorageKey("b")));
  it.each([null, undefined, "", "https://evil.test", "//evil.test", "/\\evil.test", "/%2fexample.test", "/%5cexample.test", "/%00", "/login", "/login?next=/crm", "/device-access", "/../login", "/", "/welcome", "/%xx"])("falls back safely for %s", (next) => expect(safeAppNextPath(next)).toBe("/workspaces"));
  it.each(["/crm/tasks?task=abc", "/previews?reportId=abc&reportType=asset", "/reports?search=John%20Smith", "/workspaces"])("retains an explicit deep link %s", (next) => expect(safeAppNextPath(next)).toBe(next));
});
