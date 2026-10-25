import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ImageManager from "./ImageManager";
import MapUploadSection from "./MapUploadSection";

vi.mock("./CollapsibleSection", () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <section>{children}</section>
  ),
}));

const createObjectURL = vi.fn(
  (file: Blob) => `blob:preview-${file.size}-${createObjectURL.mock.calls.length}`
);
const revokeObjectURL = vi.fn();
const originalCreateImageBitmap = globalThis.createImageBitmap;

beforeEach(() => {
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: createObjectURL,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: revokeObjectURL,
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: originalCreateImageBitmap,
  });
});

describe("real-estate media object URLs", () => {
  it("revokes the map preview when the file changes and on unmount", async () => {
    const first = new File(["first"], "first.jpg", { type: "image/jpeg" });
    const second = new File(["second"], "second.jpg", {
      type: "image/jpeg",
    });
    const { rerender, unmount } = render(
      <MapUploadSection
        mapImage={first}
        onMapImageChange={vi.fn()}
        onRemoveMapImage={vi.fn()}
      />
    );

    await screen.findByAltText("Map");
    const firstUrl = createObjectURL.mock.results[0].value;
    rerender(
      <MapUploadSection
        mapImage={second}
        onMapImageChange={vi.fn()}
        onRemoveMapImage={vi.fn()}
      />
    );
    await waitFor(() =>
      expect(revokeObjectURL).toHaveBeenCalledWith(firstUrl)
    );

    const secondUrl = createObjectURL.mock.results[1].value;
    await waitFor(() =>
      expect(screen.getByAltText("Map")).toHaveAttribute("src", secondUrl)
    );
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith(secondUrl);
  });

  it("creates one preview per image and revokes each on unmount", async () => {
    const main = new File(["main"], "main.jpg", { type: "image/jpeg" });
    const extra = new File(["extra"], "extra.jpg", { type: "image/jpeg" });
    const { unmount } = render(
      <ImageManager
        mainImages={[main]}
        extraImages={[extra]}
        onAddMainImages={vi.fn()}
        onAddExtraImages={vi.fn()}
        onAddVideo={vi.fn()}
        onRemoveMainImage={vi.fn()}
        onRemoveExtraImage={vi.fn()}
        onRemoveVideo={vi.fn()}
        onOpenCamera={vi.fn()}
      />
    );

    await Promise.all([
      screen.findByAltText("Main 1"),
      screen.findByAltText("Extra 1"),
    ]);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    const urls = createObjectURL.mock.results.map((result) => result.value);
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
    expect(revokeObjectURL.mock.calls.flat()).toEqual(
      expect.arrayContaining(urls)
    );
  });

  it("downscales a large photo before creating its preview URL", async () => {
    const close = vi.fn();
    const drawImage = vi.fn();
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: vi.fn().mockResolvedValue({
        width: 2000,
        height: 1000,
        close,
      }),
    });
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(
      (callback) => callback(new Blob(["thumbnail"], { type: "image/webp" }))
    );
    const original = new File(["large-image"], "map.jpg", {
      type: "image/jpeg",
    });

    render(
      <MapUploadSection
        mapImage={original}
        onMapImageChange={vi.fn()}
        onRemoveMapImage={vi.fn()}
      />
    );

    await screen.findByAltText("Map");
    const canvas = getContext.mock.instances[0] as HTMLCanvasElement;
    expect(canvas.width).toBe(224);
    expect(canvas.height).toBe(112);
    expect(drawImage).toHaveBeenCalledOnce();
    expect(createObjectURL.mock.calls[0][0]).not.toBe(original);
    expect(close).toHaveBeenCalledOnce();
  });
});
