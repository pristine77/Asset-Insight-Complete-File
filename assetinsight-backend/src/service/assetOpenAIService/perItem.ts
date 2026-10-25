/**
 * Analyzes caller-defined image groups sequentially while preserving group identity and
 * result order. Transport/provider failures propagate; only malformed response parsing
 * is converted into the local fallback result.
 */
import openai from "../../utils/openaiClient.js";
import { getAssetSystemPrompt } from "../../utils/assetPrompts.js";
import { assetAnalysisResponseSchema } from "./schemas.js";
import { imageUrlToBase64WithMime } from "./imageUtils.js";

export async function analyzePerItem(
  imageUrls: string[],
  language: "en" | "fr" | "es",
  currency: string,
  includeDamageAnalysis: boolean = true
): Promise<{ lots: any[]; language?: "en" | "fr" | "es"; currency?: string }> {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    return { lots: [], language, currency };
  }
  const systemPrompt = getAssetSystemPrompt(
    "per_item" as any,
    language,
    currency,
    includeDamageAnalysis
  );
  const combinedLots: any[] = [];

  for (let i = 0; i < imageUrls.length; i++) {
    const url = imageUrls[i];
    const { base64, mime } = await imageUrlToBase64WithMime(url);

    const response = await openai.responses.create({
      model: process.env.OPENAI_PRIMARY_MODEL || "gpt-5.6-terra",
      reasoning: { effort: "low" },
      instructions: systemPrompt,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: `Grouping mode: per_item. Analyze THIS SINGLE IMAGE and return ALL distinct items visible as separate lots. For each returned lot, include: the exact original URL below in 'image_url', and the original image index ${i} in 'image_indexes' only. Include 'serial_no_or_label' if visible else null, and concise 'details' attributes.\n\nOriginal image URL: ${url}`,
            },
            {
              type: "input_image",
              image_url: `data:${mime};base64,${base64}`,
              detail: "high",
            },
          ],
        },
      ] as any,
      text: {
        format: {
          type: "json_schema",
          name: "asset_analysis_per_item",
          strict: true,
          schema: assetAnalysisResponseSchema,
        },
      },
    } as any);

    const content = response?.output_text?.trim();
    if (!content) continue;
    try {
      const parsed = JSON.parse(content) as { lots?: any[] };
      const lots = Array.isArray(parsed?.lots) ? parsed.lots : [];
      if (process.env.DEBUG_PER_ITEM === "1") {
        console.log("[PerItemDebug][perItem:image]", {
          index: i,
          url,
          lotsCount: lots.length,
        });
      }
      for (const lot of lots) {
        const preIdxs = Array.isArray(lot?.image_indexes)
          ? [...lot.image_indexes]
          : undefined;
        const preUrl =
          typeof lot?.image_url === "string" ? lot.image_url : undefined;
        lot.image_indexes = [i];
        lot.image_url = url;
        if (process.env.DEBUG_PER_ITEM === "1") {
          console.log("[PerItemDebug][perItem:lot]", {
            index: i,
            url,
            lot_id: lot?.lot_id,
            title: typeof lot?.title === "string" ? lot.title : undefined,
            preIdxs,
            preUrl,
            newIdxs: lot.image_indexes,
            newUrl: lot.image_url,
          });
        }
        combinedLots.push(lot);
      }
    } catch {}
  }

  if (process.env.DEBUG_PER_ITEM === "1") {
    console.log("[PerItemDebug][perItem:done]", {
      totalLots: combinedLots.length,
    });
  }
  return { lots: combinedLots, language, currency };
}
