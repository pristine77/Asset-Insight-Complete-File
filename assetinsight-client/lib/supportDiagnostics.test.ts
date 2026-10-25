import { describe, expect, it } from "vitest";
import { collectSafeSupportDiagnostics } from "./supportDiagnostics";

describe("safe support diagnostics", () => {
  it("keeps secrets and customer input out of the diagnostic snapshot", () => {
    window.history.replaceState(
      {},
      "",
      "/support?access_token=very-secret&client=private#password"
    );
    window.localStorage.setItem("accessToken", "stored-secret");
    document.cookie = "session=hidden-value";

    const diagnostics = collectSafeSupportDiagnostics();
    const serialized = JSON.stringify(diagnostics);

    expect(diagnostics.route).toBe("/support");
    expect(diagnostics.platform).toBe("web");
    expect(diagnostics.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(diagnostics.screen).toMatch(/CSS px/);
    expect(Object.keys(diagnostics)).toEqual(
      expect.arrayContaining(["occurredAt", "route", "platform", "screen"])
    );
    expect(serialized).not.toContain("very-secret");
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("stored-secret");
    expect(serialized).not.toContain("hidden-value");
  });
});
