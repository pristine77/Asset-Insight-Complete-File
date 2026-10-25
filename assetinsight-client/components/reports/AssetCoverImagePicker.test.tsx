import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AssetCoverImagePicker from "./AssetCoverImagePicker";

const candidates = [
  "https://images.test/one.jpg",
  "https://images.test/two.jpg",
  "https://images.test/three.jpg",
  "https://images.test/four.jpg",
  "https://images.test/five.jpg",
];

describe("AssetCoverImagePicker", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.style.overflow = "";
  });

  it("opens an accessible picker with every candidate and lazy thumbnails", () => {
    render(
      <AssetCoverImagePicker
        candidateUrls={candidates}
        value={[]}
        onChange={vi.fn()}
      />
    );

    expect(screen.queryByRole("dialog", { name: "Select cover images" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Select cover images" }));

    const dialog = screen.getByRole("dialog", { name: "Select cover images" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(within(dialog).getAllByRole("img", { name: /Report image/ })).toHaveLength(5);
    for (const image of within(dialog).getAllByRole("img", { name: /Report image/ })) {
      expect(image).toHaveAttribute("loading", "lazy");
      expect(image).toHaveAttribute("decoding", "async");
      expect(image).toHaveAttribute("fetchpriority", "low");
    }
  });

  it("preserves selection order, caps the cover at four, and applies once", () => {
    const onChange = vi.fn();
    render(
      <AssetCoverImagePicker
        candidateUrls={candidates}
        value={[]}
        onChange={onChange}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Select cover images" }));

    for (const imageNumber of [3, 1, 4, 2]) {
      fireEvent.click(
        screen.getByRole("button", { name: `Select cover image ${imageNumber}` })
      );
    }
    expect(screen.getByText("4 of 4 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select cover image 5" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Apply cover images" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([
      candidates[2],
      candidates[0],
      candidates[3],
      candidates[1],
    ]);
  });

  it("keeps reset as a draft until Apply and restores the trigger after Escape", () => {
    const onChange = vi.fn();
    render(
      <AssetCoverImagePicker
        candidateUrls={candidates}
        value={[candidates[0], candidates[1]]}
        onChange={onChange}
      />
    );

    const trigger = screen.getByRole("button", { name: "Edit cover images" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Reset to automatic" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Select cover images" })).toBeNull();
    expect(trigger).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Reset to automatic" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply cover images" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("normalizes stale selections and explains when no images are available", () => {
    const { rerender } = render(
      <AssetCoverImagePicker
        candidateUrls={candidates.slice(0, 2)}
        value={["missing.jpg", candidates[1], candidates[1]]}
        onChange={vi.fn()}
      />
    );

    expect(screen.getByText("1 of 4 cover images selected.")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Selected cover image 1" })).toHaveAttribute(
      "src",
      candidates[1]
    );

    rerender(
      <AssetCoverImagePicker candidateUrls={[]} value={[]} onChange={vi.fn()} />
    );
    expect(screen.getByRole("button", { name: "Select cover images" })).toBeDisabled();
    expect(
      screen.getByText("No active report images are available for the cover.")
    ).toBeInTheDocument();
  });
});

