import axios from "axios";
import sharp from "sharp";
import { getPositiveIntEnv, mapWithConcurrency } from "./concurrency.js";

const DEFAULT_FETCH_CONCURRENCY = 4;
const HARD_MAX_FETCH_CONCURRENCY = 6;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_EDGE_PX = 1_200;
const HARD_MAX_EDGE_PX = 1_400;
const DEFAULT_TOTAL_PIXEL_BUDGET = 80_000_000;
const HARD_TOTAL_PIXEL_BUDGET = 120_000_000;
const DEFAULT_TOTAL_ENCODED_BYTES = 96 * 1024 * 1024;
const HARD_TOTAL_ENCODED_BYTES = 128 * 1024 * 1024;
const DEFAULT_JPEG_QUALITY = 80;
const HARD_MAX_JPEG_QUALITY = 84;
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
const MAX_INPUT_PIXELS = 80_000_000;

type PdfImagePreparationOptions = {
  maxEdge: number;
  quality: number;
  timeout: number;
};

type PreparedPdfImage = {
  dataUrl: string;
  encodedBytes: number;
};

export class PdfImagePayloadBudgetError extends Error {
  constructor(
    public readonly preparedBytes: number,
    public readonly maxEncodedBytes: number
  ) {
    super(
      `Prepared CR PDF images require ${(preparedBytes / 1024 / 1024).toFixed(1)} MiB, ` +
        `above the ${(maxEncodedBytes / 1024 / 1024).toFixed(1)} MiB chunk limit`
    );
    this.name = "PdfImagePayloadBudgetError";
  }
}

function isRemoteImageUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function decodeImageDataUrl(value: string): Buffer | null {
  const commaIndex = value.indexOf(",");
  if (
    commaIndex < 0 ||
    !value.slice(0, commaIndex).toLowerCase().startsWith("data:image/")
  ) {
    return null;
  }
  const metadata = value.slice(0, commaIndex);
  const payload = value.slice(commaIndex + 1);
  const base64Encoded = /;base64(?:;|$)/i.test(metadata);
  if (
    base64Encoded &&
    payload.length > Math.ceil((MAX_SOURCE_BYTES * 4) / 3) + 4
  ) {
    return null;
  }
  const decoded = base64Encoded
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload));
  return decoded.length <= MAX_SOURCE_BYTES ? decoded : null;
}

async function preparePdfImageDataUrl(
  input: Buffer,
  options: PdfImagePreparationOptions
): Promise<PreparedPdfImage> {
  const prepared = await sharp(input, {
    failOn: "none",
    limitInputPixels: MAX_INPUT_PIXELS,
  })
    .rotate()
    .flatten({ background: "#ffffff" })
    .resize({
      width: options.maxEdge,
      height: options.maxEdge,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: options.quality, progressive: true })
    .toBuffer();

  const dataUrl = `data:image/jpeg;base64,${prepared.toString("base64")}`;
  return { dataUrl, encodedBytes: Buffer.byteLength(dataUrl) };
}

async function fetchPdfImageDataUrl(
  url: string,
  options: PdfImagePreparationOptions
): Promise<PreparedPdfImage | null> {
  const isDataImage = url.toLowerCase().startsWith("data:image/");
  if (!isDataImage && !isRemoteImageUrl(url)) return null;

  try {
    if (isDataImage) {
      const decoded = decodeImageDataUrl(url);
      return decoded ? await preparePdfImageDataUrl(decoded, options) : null;
    }

    const response = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      timeout: options.timeout,
      headers: { Accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
      maxContentLength: MAX_SOURCE_BYTES,
      maxBodyLength: MAX_SOURCE_BYTES,
    });
    const responseBuffer = Buffer.isBuffer(response.data)
      ? response.data
      : Buffer.from(response.data);
    return await preparePdfImageDataUrl(responseBuffer, options);
  } catch {
    return null;
  }
}

/**
 * Fetches report images before Puppeteer receives the page. Embedded image data
 * prevents one unavailable object URL from holding an entire report worker until
 * the global browser navigation timeout expires.
 */
export async function buildPdfImageDataUrlMap(
  imageUrls: string[],
  options: {
    renderedImageCount?: number;
    renderedOccurrencesByUrl?: ReadonlyMap<string, number>;
    maxEdgePx?: number;
    jpegQuality?: number;
    maxEncodedBytes?: number;
  } = {}
): Promise<Map<string, string>> {
  const uniqueUrls = Array.from(
    new Set(imageUrls.map((value) => String(value || "").trim()).filter(Boolean))
  );
  const concurrency = Math.min(
    HARD_MAX_FETCH_CONCURRENCY,
    getPositiveIntEnv(
      "REPORT_PDF_IMAGE_FETCH_CONCURRENCY",
      DEFAULT_FETCH_CONCURRENCY
    )
  );
  const configuredMaxEdge = Math.min(
    HARD_MAX_EDGE_PX,
    Math.max(
      1,
      Math.floor(
        options.maxEdgePx ||
          getPositiveIntEnv("REPORT_PDF_IMAGE_MAX_EDGE_PX", DEFAULT_MAX_EDGE_PX)
      )
    )
  );
  const totalPixelBudget = Math.min(
    HARD_TOTAL_PIXEL_BUDGET,
    getPositiveIntEnv(
      "REPORT_PDF_IMAGE_TOTAL_PIXEL_BUDGET",
      DEFAULT_TOTAL_PIXEL_BUDGET
    )
  );
  const budgetImageCount = Math.max(
    uniqueUrls.length,
    Math.floor(Number(options.renderedImageCount || 0))
  );
  const budgetMaxEdge = Math.max(
    1,
    Math.floor(Math.sqrt(totalPixelBudget / Math.max(1, budgetImageCount)))
  );
  // Chromium decodes JPEGs to raw pixels. Scale large reports by their total
  // image count rather than allowing every photo to consume the per-image cap.
  const maxEdge = Math.min(configuredMaxEdge, budgetMaxEdge);
  const quality = Math.min(
    HARD_MAX_JPEG_QUALITY,
    Math.max(
      1,
      Math.floor(
        options.jpegQuality ||
          getPositiveIntEnv("REPORT_PDF_IMAGE_JPEG_QUALITY", DEFAULT_JPEG_QUALITY)
      )
    )
  );
  const timeout = getPositiveIntEnv(
    "REPORT_PDF_IMAGE_FETCH_TIMEOUT_MS",
    DEFAULT_FETCH_TIMEOUT_MS
  );
  const maxEncodedBytes = Math.min(
    HARD_TOTAL_ENCODED_BYTES,
    Math.max(
      1,
      Math.floor(
        options.maxEncodedBytes ||
          getPositiveIntEnv(
            "REPORT_PDF_IMAGE_TOTAL_ENCODED_BYTES",
            DEFAULT_TOTAL_ENCODED_BYTES
          )
      )
    )
  );
  const startedAt = Date.now();
  const values = await mapWithConcurrency(uniqueUrls, concurrency, (url) =>
    fetchPdfImageDataUrl(url, { maxEdge, quality, timeout })
  );
  const mapped = new Map<string, string>();
  // Charge repeated DOM occurrences because the same data URL can appear in a
  // summary gallery and again on a bank-photo page.
  let preparedBytes = 0;

  uniqueUrls.forEach((url, index) => {
    const value = values[index];
    if (!value) return;
    const renderedOccurrences = Math.max(
      1,
      Number(options.renderedOccurrencesByUrl?.get(url) || 1)
    );
    const chargedBytes = value.encodedBytes * renderedOccurrences;
    preparedBytes += chargedBytes;
    mapped.set(url, value.dataUrl);
  });

  if (preparedBytes > maxEncodedBytes) {
    throw new PdfImagePayloadBudgetError(preparedBytes, maxEncodedBytes);
  }

  if (uniqueUrls.length > 0) {
    console.info(
      `[CR PDF] Prepared ${mapped.size}/${uniqueUrls.length} images in ${Date.now() - startedAt}ms ` +
        `(max edge ${maxEdge}px, quality ${quality}, ` +
        `${(preparedBytes / 1024 / 1024).toFixed(1)} MiB rendered image payload, ` +
        `budget images ${budgetImageCount}, ` +
        `concurrency ${Math.min(concurrency, uniqueUrls.length)})`
    );
  }

  return mapped;
}
