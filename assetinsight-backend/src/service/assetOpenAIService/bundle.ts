/**
 * Analyzes an entire image bundle when photo-to-lot boundaries are unknown. The model is
 * required to return explicit image indexes so downstream normalization can reconstruct
 * stable lots without relying on narrative ordering.
 */
import openai from "../../utils/openaiClient.js";
import { getAssetSystemPrompt } from "../../utils/assetPrompts.js";
import { assetAnalysisResponseSchema } from "./schemas.js";
import { imageUrlToBase64WithMime } from "./imageUtils.js";
import { getPositiveIntEnv, mapWithConcurrency } from "../../utils/concurrency.js";

// The provider permits 512 MB / 1,500 images, but local preparation must also
// bound memory (100 OCR-readable JPEGs normally fit within 128 MiB encoded).
// https://developers.openai.com/api/docs/guides/images-vision#image-input-requirements
const MAX_BUNDLE_ENCODED_PAYLOAD_BYTES = 128 * 1024 * 1024;

export async function analyzeBundle(
  imageUrls: string[],
  mode: "single_lot" | "catalogue",
  language: "en" | "fr" | "es",
  currency: string,
  includeDamageAnalysis: boolean = true
): Promise<{
  lots: any[];
  summary?: string;
  language?: "en" | "fr" | "es";
  currency?: string;
}> {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    return { lots: [], language, currency };
  }
  const systemPrompt = getAssetSystemPrompt(
    mode as any,
    language,
    currency,
    includeDamageAnalysis
  );
  const contentArray: any[] = [
    {
      type: "input_text",
      text: `Grouping mode: ${mode}. Analyze these images and return valid JSON as instructed.\n\nOriginal image URLs (index -> URL):\n${imageUrls.map((u, idx) => `#${idx}: ${u}`).join("\n")}\n\nAnnotation Priority (if red boxes/ROIs are present): If one or more red-outline annotation boxes are present or described for any image, ONLY identify and return the item(s) within each box for that image (treat each box as a region-of-interest). Ignore objects outside of boxes. If no boxes are present or described, analyze each image normally.`,
    },
  ];

  if (mode === "single_lot") {
    contentArray.push({
      type: "input_text",
      text: [
        "Bundle photo order is intentional: the first supplied image is the original first main photo and the lot-number reference.",
        "The final supplied image is the original last main photo and the serial-number/VIN reference. Always inspect both, even when intermediate photos were sampled out.",
        "Read the lot identifier only from a clearly readable lot card or sticker in the first photo; never substitute a serial number, VIN, price, year, or other equipment-label number.",
        "Populate serial number or VIN fields only from readable evidence. Do not invent or infer unreadable characters; leave unavailable fields empty as required by the schema.",
        "Return image indexes relative to the supplied image list above (zero-based), not the unsupplied original capture sequence.",
      ].join(" "),
    });
  }

  // Include prompt/schema bytes and conservative per-image JSON overhead before
  // image conversion. Fail the request rather than silently dropping a photo.
  let encodedPayloadBytes = Buffer.byteLength(
    JSON.stringify({ instructions: systemPrompt, contentArray, schema: assetAnalysisResponseSchema }),
  ) + imageUrls.length * 1024 + 64 * 1024;
  const payloadError = new Error(
    "Bundle image analysis exceeds the safe encoded request size. Reduce oversized photo dimensions and retry; no photos were removed from the report.",
  );
  const imgs = await mapWithConcurrency(
    imageUrls,
    Math.min(4, getPositiveIntEnv("ASSET_AI_IMAGE_CONCURRENCY", 4)),
    async (url) => {
      if (mode === "single_lot" && encodedPayloadBytes > MAX_BUNDLE_ENCODED_PAYLOAD_BYTES) throw payloadError;
      const image = await imageUrlToBase64WithMime(url);
      encodedPayloadBytes += Buffer.byteLength(image.base64) + Buffer.byteLength(image.mime);
      if (mode === "single_lot" && encodedPayloadBytes > MAX_BUNDLE_ENCODED_PAYLOAD_BYTES) throw payloadError;
      return image;
    },
  );

  for (const { base64, mime } of imgs) {
    contentArray.push({
      type: "input_image",
      image_url: `data:${mime};base64,${base64}`,
      detail: "high",
    });
  }

  const response = await openai.responses.create({
    model: process.env.OPENAI_PRIMARY_MODEL || "gpt-5.6-terra",
    reasoning: { effort: "low" },
    instructions: systemPrompt,
    input: [
      {
        role: "user",
        content: contentArray,
      },
    ] as any,
    text: {
      format: {
        type: "json_schema",
        name: "asset_analysis_bundle",
        strict: true,
        schema: assetAnalysisResponseSchema,
      },
    },
  } as any);

  const content = response?.output_text?.trim();
  if (!content) return { lots: [], language, currency };
  const parsed = JSON.parse(content) as {
    lots?: any[];
    language?: any;
    currency?: any;
    summary?: string;
  };
  const lots = Array.isArray(parsed?.lots) ? parsed.lots : [];
  return {
    lots,
    summary: parsed?.summary,
    language: (parsed?.language as any) || language,
    currency: (parsed?.currency as any) || currency,
  };
}
