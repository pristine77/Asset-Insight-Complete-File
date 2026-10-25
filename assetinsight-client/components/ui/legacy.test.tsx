import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Menu, MenuItem } from "./legacy";

type Bounds = {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
};

let anchorBounds: Bounds;

function MenuHarness({ explicitAbove = false }: { explicitAbove?: boolean }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  return (
    <>
      <button
        type="button"
        data-menu-anchor
        aria-label="More report actions"
        onClick={(event) => setAnchor(event.currentTarget)}
      >
        More actions
      </button>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        anchorOrigin={
          explicitAbove
            ? { vertical: "top", horizontal: "left" }
            : undefined
        }
        transformOrigin={
          explicitAbove
            ? { vertical: "bottom", horizontal: "left" }
            : undefined
        }
      >
        <MenuItem>Clear form</MenuItem>
        <MenuItem sx={{ display: "none" }}>Hidden action</MenuItem>
        <MenuItem>Discard draft</MenuItem>
      </Menu>
    </>
  );
}

describe("legacy Menu positioning", () => {
  beforeEach(() => {
    anchorBounds = {
      top: 540,
      right: 790,
      bottom: 580,
      left: 750,
      width: 40,
      height: 40,
    };
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 600,
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        if (this.hasAttribute("data-menu-anchor")) {
          return anchorBounds as DOMRect;
        }
        if (this.getAttribute("role") === "menu") {
          return {
            top: 0,
            right: 220,
            bottom: 140,
            left: 0,
            width: 220,
            height: 140,
          } as DOMRect;
        }
        return {
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
          width: 0,
          height: 0,
        } as DOMRect;
      }
    );
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.getAttribute("role") === "menu" ? 220 : 0;
      }
    );
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.getAttribute("role") === "menu" ? 140 : 0;
      }
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("flips a bottom-anchored menu above and clamps it inside the viewport", async () => {
    render(<MenuHarness />);
    fireEvent.click(
      screen.getByRole("button", { name: "More report actions" })
    );

    const menu = await screen.findByRole("menu", {
      name: "More report actions",
    });
    await waitFor(() => expect(menu.style.top).toBe("394px"));
    expect(menu.style.left).toBe("570px");
    expect(Number.parseFloat(menu.style.top) + 140).toBeLessThanOrEqual(592);
    expect(Number.parseFloat(menu.style.left) + 220).toBeLessThanOrEqual(792);
  });

  it("honours an explicit above origin and repositions after scrolling", async () => {
    render(<MenuHarness explicitAbove />);
    fireEvent.click(
      screen.getByRole("button", { name: "More report actions" })
    );

    const menu = await screen.findByRole("menu", {
      name: "More report actions",
    });
    await waitFor(() => expect(menu.style.top).toBe("394px"));
    expect(menu.style.left).toBe("572px");

    anchorBounds = {
      top: 300,
      right: 440,
      bottom: 340,
      left: 400,
      width: 40,
      height: 40,
    };
    fireEvent.scroll(window);

    await waitFor(() => expect(menu.style.top).toBe("154px"));
    expect(menu.style.left).toBe("400px");

    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 500,
    });
    fireEvent(window, new Event("resize"));

    await waitFor(() => expect(menu.style.left).toBe("272px"));
  });

  it("skips visually hidden actions during keyboard navigation", async () => {
    render(<MenuHarness />);
    const anchor = screen.getByRole("button", {
      name: "More report actions",
    });
    fireEvent.click(anchor);

    const visibleItems = await screen.findAllByRole("menuitem");
    await waitFor(() => expect(document.activeElement).toBe(visibleItems[0]));
    fireEvent.keyDown(visibleItems[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(visibleItems[1]);

    fireEvent.keyDown(visibleItems[1], { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("menu", { name: "More report actions" })
      ).not.toBeInTheDocument()
    );
    expect(document.activeElement).toBe(anchor);
  });
});
