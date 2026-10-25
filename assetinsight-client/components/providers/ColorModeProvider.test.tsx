import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ColorModeProvider,
  THEME_COOKIE_KEY,
  THEME_STORAGE_KEY,
  useColorMode,
} from "./ColorModeProvider";
import { ThemeScript } from "./ThemeScript";

type MatchMediaController = {
  setDark: (dark: boolean) => void;
};

function installMatchMedia(initiallyDark: boolean): MatchMediaController {
  let dark = initiallyDark;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      media: query,
      get matches() {
        return dark;
      },
      onchange: null,
      addEventListener: (
        event: string,
        listener: (event: MediaQueryListEvent) => void
      ) => {
        if (event === "change") listeners.add(listener);
      },
      removeEventListener: (
        event: string,
        listener: (event: MediaQueryListEvent) => void
      ) => {
        if (event === "change") listeners.delete(listener);
      },
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }))
  );

  return {
    setDark(nextDark) {
      dark = nextDark;
      const event = { matches: dark } as MediaQueryListEvent;
      listeners.forEach((listener) => listener(event));
    },
  };
}

function ThemeProbe() {
  const { mode, toggleMode } = useColorMode();
  return (
    <>
      <output aria-label="Current theme">{mode}</output>
      <button onClick={toggleMode}>Toggle theme</button>
    </>
  );
}

describe("ColorModeProvider", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "";
    document.cookie = `${THEME_COOKIE_KEY}=; Path=/; Max-Age=0`;
    installMatchMedia(false);
  });

  it("hydrates from the prepaint theme even when storage and OS disagree", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    installMatchMedia(false);
    document.documentElement.dataset.theme = "dark";

    render(
      <ColorModeProvider>
        <ThemeProbe />
      </ColorModeProvider>
    );

    expect(screen.getByLabelText("Current theme")).toHaveTextContent("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("uses a stored preference before the operating-system preference", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    installMatchMedia(true);

    render(
      <ColorModeProvider>
        <ThemeProbe />
      </ColorModeProvider>
    );

    expect(screen.getByLabelText("Current theme")).toHaveTextContent("light");
  });

  it("defaults to the operating-system preference on a first visit", () => {
    installMatchMedia(true);

    render(
      <ColorModeProvider>
        <ThemeProbe />
      </ColorModeProvider>
    );

    expect(screen.getByLabelText("Current theme")).toHaveTextContent("dark");
  });

  it("persists a toggle to the DOM, local storage, and cookie", () => {
    render(
      <ColorModeProvider>
        <ThemeProbe />
      </ColorModeProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Toggle theme" }));

    expect(screen.getByLabelText("Current theme")).toHaveTextContent("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.cookie).toContain(`${THEME_COOKIE_KEY}=dark`);
  });

  it("tracks OS changes only until the user stores a preference", () => {
    const media = installMatchMedia(false);
    const { unmount } = render(
      <ColorModeProvider>
        <ThemeProbe />
      </ColorModeProvider>
    );

    act(() => media.setDark(true));
    expect(screen.getByLabelText("Current theme")).toHaveTextContent("dark");
    unmount();

    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    document.documentElement.dataset.theme = "light";
    const storedMedia = installMatchMedia(false);
    render(
      <ColorModeProvider>
        <ThemeProbe />
      </ColorModeProvider>
    );
    act(() => storedMedia.setDark(true));
    expect(screen.getByLabelText("Current theme")).toHaveTextContent("light");
  });
});

describe("ThemeScript prepaint contract", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "";
    document.cookie = `${THEME_COOKIE_KEY}=; Path=/; Max-Age=0`;
    installMatchMedia(false);
  });

  it("emits an inline script before client hydration", () => {
    const { container } = render(<ThemeScript />);
    const script = container.querySelector("script");

    expect(script).not.toBeNull();
    expect(script?.textContent).toContain(THEME_STORAGE_KEY);
    expect(script?.textContent).toContain("prefers-color-scheme: dark");
    expect(script?.textContent).toContain(
      "document.documentElement.dataset.theme"
    );
  });
});
