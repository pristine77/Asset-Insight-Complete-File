import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const browser = vi.hoisted(() => ({
  close: vi.fn(), content: vi.fn(), viewport: vi.fn(), evaluate: vi.fn(), select: vi.fn(), screenshot: vi.fn(),
  scripts: vi.fn(), intercept: vi.fn(), on: vi.fn(), media: vi.fn(), timeout: vi.fn(),
  pdf: vi.fn(),
}));
vi.mock("puppeteer", () => ({ default: { launch: vi.fn(async () => ({ close: browser.close,
  newPage: async () => ({
    setContent: browser.content, setViewport: browser.viewport, evaluate: browser.evaluate, $: browser.select,
    setJavaScriptEnabled: browser.scripts, setRequestInterception: browser.intercept,
    on: browser.on, emulateMediaType: browser.media,
    setDefaultTimeout: browser.timeout, setDefaultNavigationTimeout: browser.timeout,
  }),
})) } }));
vi.mock("../src/service/salvageImagePreparation.js", () => ({ prepareSalvagePhotos: vi.fn() }));
vi.mock("../src/service/salvagePdfLayout.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/service/salvagePdfLayout.js")>(),
  renderSalvagePdfWithContents: browser.pdf,
}));
import { generateSalvagePdfFromReport, renderSalvageDocxCover } from "../src/service/salvagePdfService.js";
import { prepareSalvagePhotos } from "../src/service/salvageImagePreparation.js";

beforeEach(() => {
  vi.clearAllMocks();
  browser.content.mockResolvedValue(undefined);
  browser.close.mockResolvedValue(undefined);
  browser.screenshot.mockResolvedValue(Buffer.from("cover-png"));
  browser.select.mockResolvedValue({ screenshot: browser.screenshot });
  browser.evaluate.mockReset();
  browser.pdf.mockResolvedValue(Buffer.from("verified-pdf"));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("Salvage Word cover shares the PDF design", () => {
  it.each([0, 1, 2, 3, 30])("uses prepared %i-photo bytes without refetching or generating a PDF", async count => {
    const photos = Array.from({ length: count }, (_, index) => ({ buffer: Buffer.from("photo-" + index), width: 800, height: 600 }));
    const report = { file_number: "LOCAL-ONLY", imageUrls: photos.map((_, index) => "https://example.test/" + index), cover_image_urls: ["https://example.test/2"] };
    expect(await renderSalvageDocxCover(report, photos)).toEqual(Buffer.from("cover-png"));
    expect(prepareSalvagePhotos).not.toHaveBeenCalled();
    expect(browser.select).toHaveBeenCalledWith(".cover");
    expect(browser.viewport).toHaveBeenCalledWith({ width: 794, height: 1123, deviceScaleFactor: 2.5 });
    expect(browser.media).toHaveBeenCalledWith("print");
    expect(browser.scripts).toHaveBeenCalledWith(false);
    expect(browser.content.mock.calls[0][0].includes('class="cover-brand"')).toBe(true);
    expect(browser.content.mock.calls[0][0].includes('class="cover-art"')).toBe(true);
    expect(browser.content.mock.calls[0][0].includes('src="https://')).toBe(false);
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it("blocks external render resources, but allows embedded images", async () => {
    await renderSalvageDocxCover({ imageUrls: [] }, []);
    const handler = browser.on.mock.calls.find(([event]) => event === "request")![1];
    const proceed = vi.fn().mockResolvedValue(undefined); const abort = vi.fn().mockResolvedValue(undefined);
    handler({ url: () => "https://untrusted.example/file", continue: proceed, abort });
    handler({ url: () => "data:image/png;base64,AA", continue: proceed, abort });
    expect(abort).toHaveBeenCalledOnce(); expect(proceed).toHaveBeenCalledOnce();
  });

  it("closes Chromium and rejects incomplete covers without publishing a blank plate", async () => {
    browser.select.mockResolvedValue(null);
    await expect(renderSalvageDocxCover({ imageUrls: [] }, [])).rejects.toThrow("Failed to generate Salvage DOCX cover");
    expect(browser.close).toHaveBeenCalledOnce();
  });
});

describe("Salvage PDF cover compatibility", () => {
  function documentFixture() {
    const decode = vi.fn().mockResolvedValue(undefined);
    const cover = { getAttribute: () => "Rapport de récupération", replaceChildren: vi.fn(), classList: { add: vi.fn() } };
    const plate = { className: "", alt: "", src: "", decode, naturalWidth: 1985 };
    const document = {
      fonts: { ready: Promise.resolve() },
      images: [{ decode, naturalWidth: 800 }],
      getElementById: vi.fn(() => cover),
      createElement: vi.fn(() => plate),
    };
    vi.stubGlobal("document", document);
    browser.evaluate.mockImplementation(async (callback, ...args) => callback(...args));
    return { document, cover, plate, decode };
  }

  it.each([0, 1, 2, 3, 30])("prints an opaque cover plate with %i photos without replacing body media or anchors", async count => {
    const photos = Array.from({ length: count }, () => ({ buffer: Buffer.from("photo"), width: 800, height: 600 }));
    vi.mocked(prepareSalvagePhotos).mockResolvedValue(photos);
    const { document, cover, plate, decode } = documentFixture();
    const report = { imageUrls: photos.map((_, index) => `https://example.test/${index}`) };
    expect(await generateSalvagePdfFromReport(report)).toEqual(Buffer.from("verified-pdf"));
    expect(prepareSalvagePhotos).toHaveBeenCalledExactlyOnceWith(report.imageUrls);
    expect(browser.screenshot).toHaveBeenCalledExactlyOnceWith({ type: "png", omitBackground: false });
    expect(plate.src).toBe(`data:image/png;base64,${Buffer.from("cover-png").toString("base64")}`);
    expect(plate.alt).toBe("Rapport de récupération");
    expect(decode).toHaveBeenCalledTimes(2);
    expect(document.getElementById).toHaveBeenCalledExactlyOnceWith("cover-page");
    expect(cover.replaceChildren).toHaveBeenCalledExactlyOnceWith(plate);
    expect(cover.classList.add).toHaveBeenCalledExactlyOnceWith("cover-flattened");
    expect(cover.replaceChildren.mock.invocationCallOrder[0]).toBeLessThan(browser.pdf.mock.invocationCallOrder[0]);
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it.each(["photo", "plate", "screenshot"])("does not publish a PDF after a %s rendering failure", async failure => {
    vi.mocked(prepareSalvagePhotos).mockResolvedValue([]);
    const { document, plate } = documentFixture();
    if (failure === "photo") document.images[0]!.naturalWidth = 0;
    if (failure === "plate") plate.naturalWidth = 0;
    if (failure === "screenshot") browser.screenshot.mockRejectedValueOnce(new Error("Screenshot failed"));
    await expect(generateSalvagePdfFromReport({ imageUrls: [] })).rejects.toThrow("Failed to generate PDF report");
    expect(browser.pdf).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledOnce();
  });
});
