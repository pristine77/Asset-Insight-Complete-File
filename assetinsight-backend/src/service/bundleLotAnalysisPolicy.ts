import { imageUrlToBase64WithMime } from "./assetOpenAIService/imageUtils.js";
import { getPositiveIntEnv, mapWithConcurrency } from "../utils/concurrency.js";
import { parseLotNumberNumericPortion } from "../utils/lotDamagePolicy.js";
import openai from "../utils/openaiClient.js";

export const BUNDLE_LOT_DETECTOR_VERSION = "first-main-photo-v3";
export const HIGH_LOT_NUMBER_THRESHOLD = 1000n;
export const HIGH_LOT_IMAGE_LIMIT = 10;
export const STANDARD_BUNDLE_IMAGE_LIMIT = 100;

export type BundleGroupLike = {
  count: number;
  extraCount?: number;
  mode: string;
};

export type BundleLotNumberPhotoInput = {
  groupIndex: number;
  sourceImageIndex: number;
  imageUrl: string;
};

export type BundleLotAnalysisDiagnostic = {
  groupIndex: number;
  numberSource:
    // Persisted v2 diagnostics remain readable during regeneration.
    | "last_main_photo"
    | "first_main_photo"
    | "reviewed_upload"
    | "sequential_fallback";
  detectedValue: string | null;
  resolvedLotNumber: string | number;
  sourceImageIndex?: number | null;
  // Legacy v1 field. New diagnostics use sourceImageIndex.
  firstImageIndex?: number | null;
  selectedImageLimit: number;
  analyzedImageCount: number;
  detectorVersion: string;
};

const LOT_NUMBER_PREFIX = /^(?:lot\s*(?:number|no\.?|#)?\s*[:#-]?\s*)/i;
const REJECTED_CONTEXT =
  /(?:\$|\b(?:vin|serial|s\/?n|year|date|price|quantity|qty|horsepower|hp|phone|tel|km|miles?|hours?)\b|\/)/i;
const BARE_VIN_SHAPE = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9]{17}$/;

/**
 * Converts detector output into a conservative lot identifier. Ambiguous values
 * are discarded so ordinary numbers on equipment labels cannot become lot IDs.
 */
export function normalizeDetectedBundleLotNumber(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw || REJECTED_CONTEXT.test(raw)) return null;

  const withoutPrefix = raw.replace(LOT_NUMBER_PREFIX, "").trim();
  if (!withoutPrefix || withoutPrefix.length > 32) return null;
  if (!/^\d[\d,]*(?:[A-Za-z][A-Za-z0-9-]*)?$/.test(withoutPrefix)) return null;

  const normalized = withoutPrefix.replace(/,/g, "");
  // Models sometimes omit the "VIN" label and return only the plate value.
  // A mixed 17-character identifier is far more likely to be a VIN/serial than
  // an explicit auction lot number, so fail safely to sequential numbering.
  if (BARE_VIN_SHAPE.test(normalized)) return null;
  return parseLotNumberNumericPortion(normalized) === null ? null : normalized;
}

export function getBundleLotAnalysisLimit(
  lotNumber: unknown,
  standardLimit = STANDARD_BUNDLE_IMAGE_LIMIT,
): number {
  const numeric = parseLotNumberNumericPortion(lotNumber);
  return numeric !== null && numeric >= HIGH_LOT_NUMBER_THRESHOLD
    ? HIGH_LOT_IMAGE_LIMIT
    : standardLimit;
}

/**
 * Selects at most `limit` inputs, retaining the first and final photo whenever
 * two slots are available. The returned array never aliases the media manifest.
 * Selection is positional: equal-looking photos still have distinct source IDs.
 */
export function selectImagesPreservingEndpoints<T>(
  images: readonly T[],
  limit: number,
): T[] {
  const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (count === 0 || images.length === 0) return [];
  if (images.length <= count) return images.slice();
  if (count === 1) return images.slice(0, 1);
  return [...images.slice(0, count - 1), images[images.length - 1]!];
}

/**
 * Selects the model input without mutating the complete media manifest.
 */
export function selectBundleAnalysisImageIndexes(
  mainImageIndexes: readonly number[],
  diagnostic: Pick<BundleLotAnalysisDiagnostic, "selectedImageLimit">,
): number[] {
  return selectImagesPreservingEndpoints(mainImageIndexes, diagnostic.selectedImageLimit);
}

/** The dedicated lot-number-photo result wins over a conflicting full-analysis value. */
export function applyAuthoritativeBundleLotNumber<T extends Record<string, any>>(
  lot: T,
  diagnostic: Pick<BundleLotAnalysisDiagnostic, "resolvedLotNumber">,
): T {
  return { ...lot, lot_number: diagnostic.resolvedLotNumber };
}

/**
 * Builds detector inputs from the original manifest. Cover changes do not affect
 * this selection: the first main photo is always the group's original start,
 * not its cover or any extra/report-only photo.
 */
export function buildBundleLotNumberPhotoInputs(
  groups: BundleGroupLike[],
  imageUrls: string[],
): BundleLotNumberPhotoInput[] {
  const inputs: BundleLotNumberPhotoInput[] = [];
  let cursor = 0;

  groups.forEach((group, groupIndex) => {
    const mainCount = Math.max(0, Number(group.count) || 0);
    const extraCount = Math.max(0, Number(group.extraCount) || 0);
    const sourceImageIndex = cursor;
    if (
      group.mode === "single_lot" &&
      mainCount > 0 &&
      imageUrls[sourceImageIndex]
    ) {
      inputs.push({
        groupIndex,
        sourceImageIndex,
        imageUrl: imageUrls[sourceImageIndex],
      });
    }
    cursor += mainCount + extraCount;
  });

  return inputs;
}

export function resolveBundleLotAnalysisPolicy(input: {
  groupIndex: number;
  sourceImageIndex?: number | null;
  detectedLotNumber?: unknown;
  reviewedLotNumber?: unknown;
  mainImageCount: number;
  standardLimit?: number;
}): BundleLotAnalysisDiagnostic {
  const reviewedValue = normalizeDetectedBundleLotNumber(input.reviewedLotNumber);
  const detectedValue = normalizeDetectedBundleLotNumber(input.detectedLotNumber);
  const resolvedLotNumber = reviewedValue || detectedValue || input.groupIndex + 1;
  const selectedImageLimit = getBundleLotAnalysisLimit(
    resolvedLotNumber,
    input.standardLimit ?? STANDARD_BUNDLE_IMAGE_LIMIT,
  );

  return {
    groupIndex: input.groupIndex,
    numberSource: reviewedValue ? "reviewed_upload" : detectedValue ? "first_main_photo" : "sequential_fallback",
    detectedValue,
    resolvedLotNumber,
    sourceImageIndex: Number.isInteger(input.sourceImageIndex)
      ? Number(input.sourceImageIndex)
      : null,
    selectedImageLimit,
    analyzedImageCount: Math.min(
      Math.max(0, input.mainImageCount),
      selectedImageLimit,
    ),
    detectorVersion: BUNDLE_LOT_DETECTOR_VERSION,
  };
}

function chunkInputs<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function detectBatch(
  inputs: BundleLotNumberPhotoInput[],
): Promise<Map<number, string | null>> {
  const converted = await mapWithConcurrency(
    inputs,
    getPositiveIntEnv("BUNDLE_LOT_DETECTOR_IMAGE_CONCURRENCY", 4),
    async (input) => ({ input, image: await imageUrlToBase64WithMime(input.imageUrl) }),
  );
  const content: any[] = [
    {
      type: "input_text",
      text: [
        "Each supplied image is the original first main photo for one Bundle lot and may be a dedicated lot-number card or sticker.",
        "Read a lot number only when it is explicitly shown as the lot identifier on each image.",
        "Return null when uncertain or when the visible number is a year, price, date, phone number, quantity, horsepower, VIN, serial number, mileage, or hours.",
        "Do not infer a number from image order. Preserve an alphanumeric suffix such as 1000A.",
      ].join(" "),
    },
  ];

  converted.forEach(({ input, image }) => {
    content.push({
      type: "input_text",
      text: `groupIndex=${input.groupIndex}`,
    });
    content.push({
      type: "input_image",
      image_url: `data:${image.mime};base64,${image.base64}`,
      detail: "high",
    });
  });

  const response = await openai.responses.create({
    model: process.env.OPENAI_PRIMARY_MODEL || "gpt-5.6-terra",
    reasoning: { effort: "low" },
    input: [{ role: "user", content }] as any,
    text: {
      format: {
        type: "json_schema",
        name: "bundle_lot_number_photos",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            results: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  groupIndex: { type: "integer" },
                  lotNumber: { type: ["string", "null"] },
                },
                required: ["groupIndex", "lotNumber"],
              },
            },
          },
          required: ["results"],
        },
      },
    },
  } as any);

  const expected = new Set(inputs.map((input) => input.groupIndex));
  const parsed = JSON.parse(response.output_text || "{}") as {
    results?: Array<{ groupIndex?: unknown; lotNumber?: unknown }>;
  };
  const result = new Map<number, string | null>();
  inputs.forEach((input) => result.set(input.groupIndex, null));
  for (const item of Array.isArray(parsed.results) ? parsed.results : []) {
    const groupIndex = Number(item?.groupIndex);
    if (!Number.isInteger(groupIndex) || !expected.has(groupIndex)) continue;
    result.set(groupIndex, normalizeDetectedBundleLotNumber(item?.lotNumber));
  }
  return result;
}

/**
 * Detects lot numbers from first-main-photo inputs in batches of ten. A failed
 * batch deliberately returns null values so processing uses sequential numbers.
 */
export async function detectBundleLotNumbersFromPhotos(
  inputs: BundleLotNumberPhotoInput[],
): Promise<Map<number, string | null>> {
  const result = new Map<number, string | null>();
  inputs.forEach((input) => result.set(input.groupIndex, null));
  if (inputs.length === 0) return result;

  const batches = chunkInputs(inputs, 10);
  const batchResults = await mapWithConcurrency(
    batches,
    getPositiveIntEnv("BUNDLE_LOT_DETECTOR_CONCURRENCY", 2),
    async (batch) => {
      try {
        return await detectBatch(batch);
      } catch (error) {
        const errorCode = String(
          (error as any)?.code || (error as any)?.status || "provider_error",
        ).replace(/[^a-zA-Z0-9_-]/g, "");
        console.warn(
          `[BundleLotDetector] Lot-number-photo detection failed for ${batch.length} lot(s) (${errorCode}); using sequential fallback.`,
        );
        return new Map(batch.map((input) => [input.groupIndex, null]));
      }
    },
  );

  batchResults.forEach((batch) => {
    batch.forEach((value, key) => result.set(key, value));
  });
  return result;
}

export function reapplyBundleLotNumberDiagnostics<T extends Record<string, any>>(
  lots: T[],
  options: { preserveExistingLotNumber?: boolean } = {},
): T[] {
  return (Array.isArray(lots) ? lots : []).map((lot) => {
    if (lot?.sub_mode !== "single_lot") return lot;
    if (
      options.preserveExistingLotNumber &&
      String(lot?.lot_number ?? "").trim()
    ) {
      return lot;
    }
    const diagnostic = lot?.analysis_metadata
      ?.bundle_lot_number_detection as BundleLotAnalysisDiagnostic | undefined;
    return diagnostic?.resolvedLotNumber !== undefined
      ? applyAuthoritativeBundleLotNumber(lot, diagnostic)
      : lot;
  });
}
