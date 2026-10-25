import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import FloatingPhotoViewer from "@/components/reports/FloatingPhotoViewer";

const photos = ["a.jpg", "b.jpg", "c.jpg"].map((name) => ({ url: `https://assetinsight.test/${name}`, key: name }));

function Harness({ onClose = vi.fn() }: { onClose?: () => void }) {
  const [index, setIndex] = useState(0);
  return (
    <>
      <textarea aria-label="Description" defaultValue="Semi truck" />
      <FloatingPhotoViewer
        title="Lot #10051"
        entries={photos}
        index={index}
        onIndexChange={setIndex}
        onClose={onClose}
      />
    </>
  );
}

const viewer = () => screen.getByRole("dialog", { name: "Lot #10051 photos" });
const shownPhoto = () => viewer().querySelector("img")?.getAttribute("src");

describe("FloatingPhotoViewer", () => {
  it("opens as a non-modal window on the photo and steps with the arrow keys", () => {
    render(<Harness />);
    expect(viewer()).toHaveAttribute("aria-modal", "false");
    expect(screen.getByText("Photo 1 of 3")).toBeInTheDocument();
    expect(shownPhoto()).toBe(photos[0].url);

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText("Photo 2 of 3")).toBeInTheDocument();
    expect(shownPhoto()).toBe(photos[1].url);
    fireEvent.keyDown(window, { key: "End" });
    expect(screen.getByText("Photo 3 of 3")).toBeInTheDocument();
    // No wrap past the last photo.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText("Photo 3 of 3")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByText("Photo 2 of 3")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Home" });
    expect(screen.getByText("Photo 1 of 3")).toBeInTheDocument();
  });

  it("leaves arrow keys alone while typing in a text field and for browser back/forward", () => {
    render(<Harness />);
    const description = screen.getByRole("textbox", { name: "Description" });
    fireEvent.keyDown(description, { key: "ArrowRight" });
    expect(screen.getByText("Photo 1 of 3")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "ArrowRight", altKey: true });
    expect(screen.getByText("Photo 1 of 3")).toBeInTheDocument();
  });

  it("steps with the arrow buttons and thumbnails", () => {
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Previous photo (Left arrow)" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next photo (Right arrow)" }));
    expect(screen.getByText("Photo 2 of 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show photo 3" }));
    expect(screen.getByText("Photo 3 of 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show photo 3" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "Next photo (Right arrow)" })).toBeDisabled();
  });

  it("minimizes to a docked bar, restores, maximizes and restores the size", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Minimize photo viewer" }));
    expect(screen.queryByRole("button", { name: "Next photo (Right arrow)" })).not.toBeInTheDocument();
    expect(screen.getByText("Photo 1 of 3")).toBeInTheDocument();
    // Arrow keys do nothing while minimized.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByText("Photo 1 of 3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Restore photo viewer" }));
    expect(screen.getByRole("button", { name: "Next photo (Right arrow)" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Maximize photo viewer" }));
    expect(viewer().style.width).toBe("calc(100vw - 16px)");
    fireEvent.click(screen.getByRole("button", { name: "Restore photo viewer size" }));
    expect(viewer().style.width).toMatch(/px$/);
  });

  it("closes from the Close button and from Escape inside the viewer", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.keyDown(viewer(), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close photo viewer" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("links to the full-size photo without an editing action", () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByRole("link", { name: "Open full-size photo in a new tab" })).toHaveAttribute("href", photos[1].url);
    expect(screen.queryByRole("button", { name: /Remove|Delete/i })).not.toBeInTheDocument();
  });

  it("never exposes Remove or Delete in either window state", () => {
    render(<Harness />);
    expect(screen.queryByRole("button", { name: /Remove|Delete/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Minimize photo viewer" }));
    expect(screen.queryByRole("button", { name: /Remove|Delete/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore photo viewer" }));
    expect(screen.queryByRole("button", { name: /Remove|Delete/i })).not.toBeInTheDocument();
  });

  it("moves when the title bar is dragged and stays reachable on screen", () => {
    render(<Harness />);
    const frame = viewer();
    const titleBar = frame.firstElementChild as HTMLElement;
    const before = { left: parseFloat(frame.style.left), top: parseFloat(frame.style.top) };
    // jsdom has no pointer capture; the viewer only needs it to keep the drag.
    titleBar.setPointerCapture = vi.fn();
    titleBar.hasPointerCapture = vi.fn(() => true);
    titleBar.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(titleBar, { button: 0, clientX: 200, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(titleBar, { clientX: 260, clientY: 140, pointerId: 1 });
    fireEvent.pointerUp(titleBar, { clientX: 260, clientY: 140, pointerId: 1 });
    expect(parseFloat(frame.style.left)).toBe(before.left + 60);
    expect(parseFloat(frame.style.top)).toBe(before.top + 40);

    fireEvent.pointerDown(titleBar, { button: 0, clientX: 260, clientY: 140, pointerId: 2 });
    fireEvent.pointerMove(titleBar, { clientX: -5000, clientY: -5000, pointerId: 2 });
    fireEvent.pointerUp(titleBar, { pointerId: 2 });
    // Clamped: the top edge never leaves the screen and part of the title bar stays visible.
    expect(parseFloat(frame.style.top)).toBe(0);
    expect(parseFloat(frame.style.left) + parseFloat(frame.style.width)).toBeGreaterThanOrEqual(120);
  });
});
