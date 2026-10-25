/**
 * Analyzes all photographs together in one per-photo-mode provider request. Image
 * indexes remain attached to results so later deduplication can combine views of the
 * same asset without losing traceability to the uploaded media.
 */
import openai from "../../utils/openaiClient.js";
import { getAssetSystemPrompt } from "../../utils/assetPrompts.js";
import { assetAnalysisResponseSchema } from "./schemas.js";
import { imageUrlToBase64WithMime } from "./imageUtils.js";

export async function analyzePerPhoto(
  imageUrls: string[],
  language: "en" | "fr" | "es",
  currency: string,
  includeDamageAnalysis: boolean = true
): Promise<{
  lots: any[];
  language?: "en" | "fr" | "es";
  currency?: string;
  summary?: string;
}> {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    return { lots: [], language, currency };
  }
  const systemPrompt = getAssetSystemPrompt(
    "per_photo" as any,
    language,
    currency,
    includeDamageAnalysis
  );
  const imgs = await Promise.all(imageUrls.map(imageUrlToBase64WithMime));

  const contentArray: any[] = [
    {
      type: "input_text",
      text: `Grouping mode: per_photo. Analyze these images and return valid JSON as instructed.\n\nOriginal image URLs (index -> URL):\n${imageUrls.map((u, idx) => `#${idx}: ${u}`).join("\n")}\n\nAnnotation Priority (if red boxes/ROIs are present): If red-outline boxes are present, only identify and return the item within boxes for that image.`,
    },
  ];

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
        name: "asset_analysis_per_photo",
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
