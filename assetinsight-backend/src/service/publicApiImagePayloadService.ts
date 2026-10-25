/**
 * Resolves public-API image references into a bounded, provider-ready payload. URLs are
 * validated and deduplicated, private objects are read through the storage adapter, and
 * content hashes let consumers verify/deduplicate bytes. The source URL is also returned.
 */
import crypto from "crypto";
import { loadAuctioneerPhoto } from "./auctioneer2PhotoService.js";
import { createLotPhotoResolver, deletedLotPhotoUrls, firstReportImageManifest } from "../utils/lotPhotoOrder.js";

// Base64 adds roughly 33% to the binary size. Keep pages deliberately small so
// concurrent Auctioneer imports cannot create excessive Node.js heap pressure.
const DEFAULT_IMAGE_PAGE_SIZE = 2;
const MAX_IMAGE_PAGE_SIZE = 5;
const IMAGE_LOAD_CONCURRENCY = 2;

export type PublicApiImageSource = {
  url: string;
  order: number;
  lotIndex: number | null;
  photoIndex: number;
};

export type PublicApiImagePayload = {
  url: string;
  base64: string;
  content_type: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  encoding: "base64";
  order: number;
  lot_index: number | null;
  photo_index: number;
};

export type PublicApiImagePagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
};

export class PublicApiImageEncodingError extends Error {
  readonly source: PublicApiImageSource;

  constructor(source: PublicApiImageSource, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Unable to encode image ${source.order + 1}: ${detail}`);
    this.name = "PublicApiImageEncodingError";
    this.source = source;
  }
}

function cleanUrl(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function integerIndexes(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "number" || (typeof item === "string" && item.trim() !== ""))
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 0);
}

function stringUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(cleanUrl).filter(Boolean);
}

function deletedIndexesForReport(report: any): Set<number> {
  return new Set([
    ...integerIndexes(report?.deleted_image_indexes),
    ...integerIndexes(report?.preview_data?.deleted_image_indexes),
  ]);
}

function globalImageUrls(report: any): string[] {
  return firstReportImageManifest(report?.preview_data?.imageUrls, report?.preview_data?.image_urls, report?.imageUrls, report?.image_urls);
}

/**
 * Resolve the same saved order as ZIP and Auctioneer push delivery. Direct
 * URLs retain identity when a legacy paired index no longer matches.
 */
function orderedLotUrls(
  lot: any,
  globals: string[],
  reportDeletedIndexes: Set<number>,
  reportDeletedUrls: string[],
): string[] {
  return createLotPhotoResolver(globals, [...reportDeletedIndexes], reportDeletedUrls)(lot).map((photo) => photo.url);
}

export function collectPublicApiLotImageSources(
  report: any,
  lot: any,
  lotIndex: number
): PublicApiImageSource[] {
  const globals = globalImageUrls(report);
  const deleted = deletedIndexesForReport(report);
  return orderedLotUrls(lot, globals, deleted, [
    ...stringUrls(report?.deleted_image_urls), ...stringUrls(report?.preview_data?.deleted_image_urls),
  ]).map((url, photoIndex) => ({
    url,
    order: photoIndex,
    lotIndex,
    photoIndex,
  }));
}

export function collectPublicApiReportImageSources(
  report: any,
  lots: any[]
): PublicApiImageSource[] {
  const globals = globalImageUrls(report);
  const deleted = deletedIndexesForReport(report);
  const deletedUrls = [
    ...stringUrls(report?.deleted_image_urls), ...stringUrls(report?.preview_data?.deleted_image_urls),
  ];
  const assignedUrls = new Set<string>();
  const lotDeletedUrls = new Set(lots.flatMap((lot) => deletedLotPhotoUrls(lot, globals)));
  const sources: PublicApiImageSource[] = [];

  lots.forEach((lot, lotIndex) => {
    orderedLotUrls(lot, globals, deleted, deletedUrls).forEach((url, photoIndex) => {
      // Preserve a shared photo once for each lot that references it. The lot
      // association is required when Auctioneer stores photos in its own S3.
      assignedUrls.add(url);
      sources.push({
        url,
        order: sources.length,
        lotIndex,
        photoIndex,
      });
    });
  });

  // Preserve unassigned legacy report images instead of silently omitting them.
  globals.forEach((url, globalIndex) => {
    if (!url || deleted.has(globalIndex) || deletedUrls.includes(url) || lotDeletedUrls.has(url) || assignedUrls.has(url)) return;
    sources.push({
      url,
      order: sources.length,
      lotIndex: null,
      photoIndex: globalIndex,
    });
  });

  return sources;
}

export function getPublicApiImagePagination(
  query: Record<string, unknown>,
  options: { prefix?: string } = {}
): { page: number; limit: number } {
  const prefix = options.prefix || "";
  const pageKey = prefix ? `${prefix}Page` : "page";
  const limitKey = prefix ? `${prefix}Limit` : "limit";
  const page = Math.max(Number.parseInt(String(query[pageKey] || "1"), 10) || 1, 1);
  const parsedLimit =
    Number.parseInt(String(query[limitKey] || DEFAULT_IMAGE_PAGE_SIZE), 10) ||
    DEFAULT_IMAGE_PAGE_SIZE;
  const limit = Math.min(Math.max(parsedLimit, 1), MAX_IMAGE_PAGE_SIZE);
  return { page, limit };
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(Math.max(concurrency, 1), values.length) },
    async () => {
      while (nextIndex < values.length) {
        const currentIndex = nextIndex++;
        output[currentIndex] = await mapper(values[currentIndex]);
      }
    }
  );
  await Promise.all(workers);
  return output;
}

type PhotoLoader = typeof loadAuctioneerPhoto;

export async function encodePublicApiImagePage(
  sources: PublicApiImageSource[],
  page: number,
  limit: number,
  loader: PhotoLoader = loadAuctioneerPhoto
): Promise<{
  data: PublicApiImagePayload[];
  pagination: PublicApiImagePagination;
}> {
  const total = sources.length;
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  const offset = (page - 1) * limit;
  const selected = sources.slice(offset, offset + limit);

  const data = await mapWithConcurrency(
    selected,
    IMAGE_LOAD_CONCURRENCY,
    async (source) => {
      try {
        const photo = await loader(
          source.url,
          source.lotIndex ?? 0,
          source.photoIndex
        );
        const extensionIndex = photo.filename.lastIndexOf(".");
        const extension = extensionIndex >= 0 ? photo.filename.slice(extensionIndex) : "";
        const filename =
          source.lotIndex === null
            ? `unassigned-photo-${String(source.order + 1).padStart(3, "0")}${extension}`
            : photo.filename;
        return {
          url: source.url,
          base64: photo.buffer.toString("base64"),
          content_type: photo.contentType,
          filename,
          size_bytes: photo.buffer.length,
          sha256: crypto.createHash("sha256").update(photo.buffer).digest("hex"),
          encoding: "base64" as const,
          order: source.order,
          lot_index: source.lotIndex,
          photo_index: source.photoIndex,
        };
      } catch (error) {
        throw new PublicApiImageEncodingError(source, error);
      }
    }
  );

  return {
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNextPage: page < totalPages,
    },
  };
}

export function shouldIncludePublicApiImageBase64(value: unknown): boolean {
  return ["1", "true", "yes"].includes(String(value || "").trim().toLowerCase());
}
