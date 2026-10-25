import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AuthLightShell from "./AuthLightShell";

vi.mock("./ThemeToggle", () => ({ default: () => <button>Change theme</button> }));

describe("authentication public information links", () => {
  it("keeps privacy, account deletion and support discoverable outside a signed-in account", () => {
    render(<AuthLightShell title="Sign in" description="Manage your work" features={[]}><p>Account form</p></AuthLightShell>);
    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("link", { name: "Account deletion" })).toHaveAttribute("href", "/account-deletion");
    expect(screen.getByRole("link", { name: "Support" }).getAttribute("href")).toMatch(/^mailto:/);
  });
});
