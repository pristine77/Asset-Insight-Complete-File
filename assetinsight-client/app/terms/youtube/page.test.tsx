import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import YoutubeTermsPage from "./page";

describe("YouTube feature terms", () => {
  it("provides public terms, privacy, revocation, and contact without authentication", () => {
    render(<YoutubeTermsPage />);
    expect(screen.getByRole("heading", { level: 1, name: "YouTube feature terms" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "YouTube Terms of Service" })).toHaveAttribute("href", "https://www.youtube.com/t/terms");
    expect(screen.getByRole("link", { name: "Asset Insight privacy notice" })).toHaveAttribute("href", "/privacy#youtube-privacy");
    expect(screen.getByText(/you agree to be bound by/)).toBeInTheDocument();
    expect(screen.getByText(/These controls do not delete uploaded YouTube videos/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "manom8193@gmail.com" })).toHaveAttribute("href", "mailto:manom8193@gmail.com");
  });

  it("states explicit report submission authorizes automatic public publication with existing report release gates", () => {
    render(<YoutubeTermsPage />);
    expect(screen.getByRole("heading", { name: "Authority and automatic public publication" })).toBeInTheDocument();
    const authority = screen.getByText(/With a channel connected, explicitly submitting or resubmitting/);
    expect(authority).toHaveTextContent("No separate per-video administrator review or visibility choice");
    expect(authority).toHaveTextContent("Original video bytes include their audio and embedded metadata without privacy redaction");
    const visibility = screen.getByText(/Public is the automatic publication target/);
    expect(visibility).toHaveTextContent("existing approval and release requirements");
    expect(visibility).toHaveTextContent("only after YouTube confirms it");
    expect(visibility).toHaveTextContent("formerly waiting for manual review");
    expect(visibility).toHaveTextContent("does not scan unrelated, unsubmitted historical reports");
    expect(screen.queryByText(/Choose Private, Unlisted, or Public/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
