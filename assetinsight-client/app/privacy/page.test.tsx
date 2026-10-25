import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import PrivacyPage, { metadata } from "./page";

describe("public privacy notice", () => {
  it("covers the web/mobile account, report, media, CRM and offline operational data used by the service", () => {
    render(<PrivacyPage />);
    for (const heading of ["Account and profile information", "Reports, photos and videos", "Camera, microphone, photos and location permissions", "CRM and support information", "Offline work and operational activity", "Service providers and optional sharing", "Report records and retention"]) {
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    expect(screen.getByText(/Offline photographs are not cloud-backed up/)).toHaveTextContent("does not automatically upload offline photos or submit a report");
    expect(screen.getByText(/Optional location access can add location information/)).toBeInTheDocument();
    expect(screen.getByText(/Optional Outlook exports send selected CRM task details/)).toBeInTheDocument();
  });

  it("links public account/data deletion instructions without implying all associated records are purged", () => {
    render(<PrivacyPage />);
    expect(screen.getByRole("link", { name: "How to delete your account and request data removal" })).toHaveAttribute("href", "/account-deletion");
    expect(screen.getByRole("link", { name: "Account and data deletion" })).toHaveAttribute("href", "#account-and-data-deletion");
    expect(screen.getByText(/Account deletion does not automatically purge report or cloud-draft data/)).toHaveTextContent("no automatic expiry");
    expect(screen.getByText(/Account deletion does not automatically purge report or cloud-draft data/)).toHaveTextContent("not confirmation that removal has completed");
  });

  it("renders device and YouTube disclosures without authentication or a consent form", () => {
    render(<PrivacyPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Asset Insight privacy notice" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Device and network security data" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "YouTube and Google data" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(metadata.description).toContain("YouTube");
    expect(screen.getByText(/New report Excel files do not include a YouTube column/)).toBeInTheDocument();
    expect(screen.queryByText(/include confirmed YouTube links in report Excel files/)).not.toBeInTheDocument();
  });

  it("provides direct policy, revocation and video-management links", () => {
    render(<PrivacyPage />);
    expect(screen.getByRole("link", { name: "Google Privacy Policy" })).toHaveAttribute("href", "https://policies.google.com/privacy");
    expect(screen.getByRole("link", { name: "YouTube Terms of Service" })).toHaveAttribute("href", "https://www.youtube.com/t/terms");
    expect(screen.getByRole("link", { name: "Revoke access in Google account permissions" })).toHaveAttribute("href", "https://security.google.com/settings/security/permissions");
    expect(screen.getByRole("link", { name: "Manage published videos in YouTube Studio" })).toHaveAttribute("href", "https://studio.youtube.com/");
    expect(screen.getByRole("link", { name: "Back to Asset Insight" })).toHaveAttribute("href", "/");
  });

  it("distinguishes local disconnect, public publication and retained receipts", () => {
    render(<PrivacyPage />);
    expect(screen.getByText(/requests Google permission revocation/)).toBeInTheDocument();
    expect(screen.getByText(/Public videos, titles, and descriptions can be viewed and found by anyone/)).toBeInTheDocument();
    expect(screen.getByText(/minimal suppression and administrative receipts/)).toBeInTheDocument();
    expect(screen.getByText(/does not rewrite historical report submission provenance/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "manom8193@gmail.com" })).toHaveAttribute("href", "mailto:manom8193@gmail.com");
    expect(screen.getByRole("link", { name: "Asset Insight YouTube feature terms" })).toHaveAttribute("href", "/terms/youtube");
  });

  it("discloses automatic public submission, original media and truthful staging without promising a separate review", () => {
    render(<PrivacyPage />);
    expect(screen.getByText(/explicitly submitting or resubmitting an Asset or Lot Listing report/)).toHaveTextContent("There is no separate per-video administrator review or visibility selection");
    const sharing = screen.getByText(/Public titles and descriptions use the saved lot number/);
    expect(sharing).toHaveTextContent("Original video bytes, including audio and embedded metadata");
    expect(sharing).toHaveTextContent("only after YouTube confirms it");
    expect(sharing).toHaveTextContent("existing approval and release requirements");
    expect(screen.getByText(/Eligible videos already queued by an explicit report submission/)).toHaveTextContent("previously waiting for manual review");
    expect(screen.getByText(/Eligible videos already queued by an explicit report submission/)).toHaveTextContent("does not scan or submit unrelated, unsubmitted historical reports");
    expect(screen.getByText(/Historical administrator video-review records/)).toHaveTextContent("automatic publication does not create a human review");
    expect(screen.queryByText(/Each video requires a separate administrator review/)).not.toBeInTheDocument();
    expect(screen.queryByText(/choose Private, Unlisted, or Public/)).not.toBeInTheDocument();
  });
});
