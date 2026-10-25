import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import AccountDeletionPage, { metadata } from "./page";

describe("public account and data deletion instructions", () => {
  it("provides a no-login help route and a protected self-service route without performing deletion", () => {
    render(<AccountDeletionPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Delete your Asset Insight account and request data removal" })).toBeInTheDocument();
    expect(screen.getByText(/without signing in or installing the app/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
    expect(screen.getByRole("link", { name: "manom8193@gmail.com" })).toHaveAttribute("href", "mailto:manom8193@gmail.com?subject=Asset%20Insight%20account%20and%20data%20deletion");
    expect(screen.getByText(/cannot sign in, your device is pending approval, or you no longer have the app/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(metadata.description).toContain("without app access");
  });

  it("distinguishes account/security deletion from associated data and local or third-party copies", () => {
    render(<AccountDeletionPage />);
    expect(screen.getByText(/Successful account deletion removes your account record and associated device registrations/)).toHaveTextContent("does not automatically purge reports, cloud drafts, uploaded media, CRM records, support records or report-activity history");
    expect(screen.getByText(/Report-activity history has no automatic expiry/)).toHaveTextContent("minimal receipt");
    expect(screen.getByText(/offline drafts and original photos or videos/)).toHaveTextContent("not removed by server account deletion");
    expect(screen.getByText(/Uploaded YouTube videos must be managed separately/)).toHaveTextContent("revoking the connection does not delete those videos");
    expect(screen.getByText(/Export or download work you need and are authorized to keep/)).toBeInTheDocument();
  });

  it("does not send email, request passwords by email or claim that a deletion request is completion", () => {
    render(<AccountDeletionPage />);
    expect(screen.getByText(/Do not send passwords, reset codes, access tokens/)).toHaveTextContent("does not send a request automatically");
    expect(screen.getByText(/Do not send passwords, reset codes, access tokens/)).toHaveTextContent("not confirmation that removal has completed");
    expect(screen.getByRole("link", { name: "Asset Insight privacy notice" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByRole("link", { name: "Back to Asset Insight" })).toHaveAttribute("href", "/");
    expect(screen.queryByText(/within 30 days|all data is deleted|GDPR compliant/i)).not.toBeInTheDocument();
  });
});
