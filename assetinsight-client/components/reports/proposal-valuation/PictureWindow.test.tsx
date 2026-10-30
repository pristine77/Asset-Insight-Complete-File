import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef, Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PictureWindow from "./PictureWindow";

type Dimensions = { width: number; height: number };
let dimensions: Dimensions;
let observers: TestResizeObserver[];
let widthReads = vi.fn(() => 0);

class TestResizeObserver {
  observe = vi.fn();
  disconnect = vi.fn();
  constructor(private callback: ResizeObserverCallback) { observers.push(this); }
  notify() { this.callback([], this as unknown as ResizeObserver); }
}

function position(panel: HTMLElement) {
  return { x: Number.parseFloat(panel.style.left), y: Number.parseFloat(panel.style.top) };
}

function expectInsideViewport(panel: HTMLElement) {
  const { x, y } = position(panel);
  expect(x).toBeGreaterThanOrEqual(8);
  expect(y).toBeGreaterThanOrEqual(8);
  expect(x + dimensions.width).toBeLessThanOrEqual(window.innerWidth - 8);
  expect(y + dimensions.height).toBeLessThanOrEqual(window.innerHeight - 8);
}

function showPictureWindow() {
  const panelRef = createRef<HTMLElement>();
  const callbacks = { onMove: vi.fn(), onSelect: vi.fn(), onClose: vi.fn() };
  const onRender = vi.fn();
  const props = { label: "Fixture lot", urls: ["/fixture-1.jpg", "/fixture-2.jpg"], index: 0, panelRef, ...callbacks };
  const content = (index = 0) => <Profiler id="picture-window" onRender={onRender}><PictureWindow {...props} index={index} /></Profiler>;
  const view = render(content());
  const panel = screen.getByRole("complementary", { name: "Pictures for Fixture lot" });
  return { ...view, panel, panelRef, callbacks, onRender, rerenderPicture: (index: number) => view.rerender(content(index)) };
}

beforeEach(() => {
  dimensions = { width: 440, height: 620 };
  observers = [];
  widthReads = vi.fn(() => dimensions.width);
  window.localStorage.clear();
  vi.stubGlobal("innerWidth", 1366);
  vi.stubGlobal("innerHeight", 900);
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.tagName === "ASIDE" ? widthReads() : 0;
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.tagName === "ASIDE" ? dimensions.height : 0;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const { x, y } = position(this);
    return { x, y, left: x, top: y, right: x + dimensions.width, bottom: y + dimensions.height,
      width: dimensions.width, height: dimensions.height, toJSON: () => ({}) };
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("PictureWindow keeps native resizing within the viewport", () => {
  it("corrects a panel size change without requiring a browser resize event", () => {
    const { panel, callbacks } = showPictureWindow();
    expect(position(panel)).toEqual({ x: 910, y: 140 });
    expect(observers[0].observe).toHaveBeenCalledWith(panel);
    // jsdom has no CSS layout. Supply the size a native resize notification
    // reports, including the overflow that left Close off-screen before the fix.
    dimensions = { width: 623, height: 803 };
    act(() => observers[0].notify());
    expectInsideViewport(panel);
    fireEvent.click(screen.getByRole("button", { name: "Close picture gallery" }));
    expect(callbacks.onClose).toHaveBeenCalledOnce();
  });

  it("uses the latest dragged position and a fresh drag origin after resizing", () => {
    window.localStorage.setItem("pv-picture-window-position", JSON.stringify({ x: 100, y: 80 }));
    const { panel } = showPictureWindow();
    const header = screen.getByTitle("Drag to move");
    fireEvent.pointerDown(header, { button: 0, pointerId: 1, clientX: 120, clientY: 100 });
    fireEvent.pointerMove(header, { pointerId: 1, clientX: 720, clientY: 270 });
    fireEvent.pointerUp(header, { pointerId: 1 });
    expect(position(panel)).toEqual({ x: 700, y: 250 });

    dimensions = { width: 700, height: 680 };
    act(() => observers[0].notify());
    expect(position(panel)).toEqual({ x: 658, y: 212 });
    expectInsideViewport(panel);

    fireEvent.pointerDown(header, { button: 0, pointerId: 2, clientX: 678, clientY: 232 });
    fireEvent.pointerMove(header, { pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(header, { pointerId: 2 });
    expect(position(panel)).toEqual({ x: 80, y: 80 });
    expect(JSON.parse(window.localStorage.getItem("pv-picture-window-position")!)).toEqual({ x: 80, y: 80 });
  });

  it("does not rerender repeatedly for identical ResizeObserver notifications", () => {
    const { onRender } = showPictureWindow();
    const commits = onRender.mock.calls.length;
    act(() => {
      for (let index = 0; index < 10; index += 1) observers[0].notify();
    });
    expect(onRender).toHaveBeenCalledTimes(commits);
  });

  it("restores a saved position safely and keeps a later smaller browser in bounds", () => {
    window.localStorage.setItem("pv-picture-window-position", JSON.stringify({ x: 9000, y: 9000 }));
    const { panel } = showPictureWindow();
    expectInsideViewport(panel);
    vi.stubGlobal("innerWidth", 1024);
    vi.stubGlobal("innerHeight", 700);
    dimensions = { width: 440, height: 520 };
    fireEvent(window, new Event("resize"));
    expectInsideViewport(panel);
    // Caps remain viewport-relative even when another resize leaves left/top
    // unchanged, so they cannot retain the old browser's available dimensions.
    expect(panel.style.maxWidth).toBe(`calc(100vw - ${position(panel).x + 8}px)`);
    expect(panel.style.maxHeight).toBe(`calc(100dvh - ${position(panel).y + 8}px)`);
  });

  it("leaves native width/height and picture navigation intact across React rerenders", () => {
    const { panel, callbacks, rerenderPicture } = showPictureWindow();
    panel.style.width = "440px";
    panel.style.height = "700px";
    dimensions.height = 700;
    act(() => observers[0].notify());
    rerenderPicture(1);
    expect(panel.style.width).toBe("440px");
    expect(panel.style.height).toBe("700px");
    expect(screen.getByRole("img", { name: "Fixture lot picture 2" })).toBeInTheDocument();
    fireEvent.keyDown(panel, { key: "ArrowLeft" });
    expect(callbacks.onMove).toHaveBeenCalledWith(-1);
    fireEvent.click(screen.getByRole("button", { name: "Show picture 1" }));
    expect(callbacks.onSelect).toHaveBeenCalledWith(0);
    expectInsideViewport(panel);
  });

  it("disconnects the observer and ignores queued callbacks after unmount", () => {
    const removeListener = vi.spyOn(window, "removeEventListener");
    const { unmount } = showPictureWindow();
    const observer = observers[0];
    unmount();
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledWith("resize", expect.any(Function));
    const reads = widthReads.mock.calls.length;
    act(() => observer.notify());
    fireEvent(window, new Event("resize"));
    expect(widthReads).toHaveBeenCalledTimes(reads);
  });

  it("retains the browser-resize fallback when ResizeObserver is unavailable", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const { panel } = showPictureWindow();
    vi.stubGlobal("innerWidth", 1024);
    dimensions.height = 600;
    fireEvent(window, new Event("resize"));
    expectInsideViewport(panel);
  });
});
