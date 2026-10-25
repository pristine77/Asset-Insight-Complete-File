/**
 * Dispatches asset-image analysis to the selected grouping strategy and normalizes all
 * results to the long-lived lot contract. Mode tags and legacy field normalization are
 * compatibility guarantees: downstream report generation should not need to know which
 * AI prompt or grouping mode produced a lot.
 */
import { analyzePerItem } from "./assetOpenAIService/perItem.js";
import { analyzePerPhoto } from "./assetOpenAIService/perPhoto.js";
import { analyzeBundle } from "./assetOpenAIService/bundle.js";
import { deduplicateAssetLotsAI } from "./assetOpenAIService/duplicate.js";
import { imageUrlToBase64WithMime } from "./assetOpenAIService/imageUtils.js";
import {
  applyDamageAnalysisToLots,
  buildReportDamageAnalysis,
} from "../utils/assetDamageAnalysis.js";
import { truncateAuctionDescription } from "../utils/previewLotNormalization.js";

export type AssetGroupingMode =
  | "single_lot"
  | "per_item"
  | "per_photo"
  | "catalogue";

export interface AssetLotAI {
  lot_id: string;
  title: string;
  description: string;
  condition_report_specs?:
    | Record<string, string>
    | Array<{ field?: string | null; value?: string | null }>;
  condition: string;
  estimated_value: string;
  damage_analysis?: string | null;
  tags?: string[];
  // Excel-related fields
  lot_number?: string | number | null; // maps to "Lot #"
  quantity?: number | null; // default 1
  must_take?: boolean | null; // true/false
  contract_number?: string | null; // maps to "Contract #"
  categories?: string | null; // one of predefined list provided in system prompt
  show_on_website?: boolean | null; // true/false
  close_date?: string | null; // ISO date YYYY-MM-DD
  bid_increment?: number | null; // numeric amount (no currency symbol)
  location?: string | null; // free text location
  opening_bid?: number | null; // numeric amount (no currency symbol)
  latitude?: number | null;
  longitude?: number | null;
  item_condition?: string | null; // may mirror 'condition'
  serial_number?: string | null;
  // Optional fields used primarily for per_item mode
  serial_no_or_label?: string | null;
  details?: string;
  image_url?: string | null;
  image_indexes: number[]; // 0-based indexes
  // Optional nested items for catalogue mode
  items?: Array<{
    title: string;
    sn_vin: string;
    description: string;
    condition_report_specs?:
      | Record<string, string>
      | Array<{ field?: string | null; value?: string | null }>;
    details: string;
    estimated_value: string;
    // Preferred per-item image reference relative to the provided images for this catalogue segment
    image_local_index?: number | null;
    // Optional direct URL if known by the model (rare when using base64)
    image_url?: string | null;
    // Excel-related fields for item rows as well
    lot_number?: string | number | null;
    quantity?: number | null;
    must_take?: boolean | null;
    contract_number?: string | null;
    categories?: string | null;
    show_on_website?: boolean | null;
    close_date?: string | null;
    bid_increment?: number | null;
    location?: string | null;
    opening_bid?: number | null;
    latitude?: number | null;
    longitude?: number | null;
    item_condition?: string | null;
  }>;
}

function extractSerial(lot: any): string | null {
  const sv =
    (
      lot?.serial_no_or_label ||
      lot?.sn_vin ||
      lot?.serial_number ||
      ""
    ).trim?.() || "";
  if (!sv) return null;
  return sv;
}

export interface AssetAnalysisResult {
  lots: AssetLotAI[];
  summary?: string;
  language?: "en" | "fr" | "es";
  currency?: string;
  damage_analysis?: string;
  total_value?: string;
  market_overview?: string;
  comparable_sales?: string;
  valuation_explanation?: string;
  condition_notes?: string;
  recommendations?: string;
}

export interface ExcelRow {
  lot_number?: string | number | null;
  description?: string | null;
  damage_analysis?: string | null;
  quantity?: number | null;
  must_take?: boolean | null;
  contract_number?: string | null;
  categories?: string | null;
  serial_number?: string | null; // 'VIN: <VIN>' or other SN; if unknown, omit
  show_on_website?: boolean | null;
  close_date?: string | null; // YYYY-MM-DD
  bid_increment?: number | null;
  location?: string | null;
  opening_bid?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  item_condition?: string | null;
}

// imageUrlToBase64WithMime is now imported from ./assetOpenAIService/imageUtils.js
// with built-in compression for lower AI token usage

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function normalizeAssetConditionReportSpecs(
  value: unknown
): Record<string, string> | undefined {
  const normalized: Record<string, string> = {};

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isPlainObject(entry)) continue;
      const field = String(entry.field ?? "").trim();
      const specValue = String(entry.value ?? "").trim();
      if (!field || !specValue) continue;
      normalized[field] = specValue;
    }
  } else if (isPlainObject(value)) {
    for (const [field, specValue] of Object.entries(value)) {
      const cleanField = String(field ?? "").trim();
      const cleanValue = String(specValue ?? "").trim();
      if (!cleanField || !cleanValue) continue;
      normalized[cleanField] = cleanValue;
    }
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeAssetAiLot(lot: any): any {
  if (!isPlainObject(lot)) return lot;

  const conditionReportSpecs = normalizeAssetConditionReportSpecs(
    lot.condition_report_specs
  );

  return {
    ...lot,
    ...(lot.description !== undefined && lot.description !== null
      ? { description: truncateAuctionDescription(lot.description) }
      : {}),
    ...(conditionReportSpecs
      ? { condition_report_specs: conditionReportSpecs }
      : {}),
    ...(Array.isArray(lot.items)
      ? { items: lot.items.map((item: any) => normalizeAssetAiLot(item)) }
      : {}),
  };
}

function normalizeAssetAiLots(lots: any[]): any[] {
  return (Array.isArray(lots) ? lots : []).map((lot) =>
    normalizeAssetAiLot(lot)
  );
}

function addModeTag(lots: AssetLotAI[], mode: AssetGroupingMode): AssetLotAI[] {
  return (lots || []).map((lot) => {
    const tags = Array.isArray(lot.tags) ? [...lot.tags] : [];
    if (!tags.some((t) => typeof t === "string" && t.startsWith("mode:"))) {
      tags.push(`mode:${mode}`);
    }
    lot.tags = tags;
    return lot;
  });
}

function normalizePerItemLotsImageMapping(
  lots: AssetLotAI[],
  imageUrls: string[]
): AssetLotAI[] {
  if (!Array.isArray(lots)) return [] as any;
  const total = Array.isArray(imageUrls) ? imageUrls.length : 0;
  return lots.map((lot: any) => {
    const urlIdx =
      typeof lot?.image_url === "string" && lot.image_url
        ? imageUrls.indexOf(lot.image_url)
        : -1;
    let idxFromIndexes: number | undefined = undefined;
    if (Array.isArray(lot?.image_indexes) && lot.image_indexes.length > 0) {
      const n = parseInt(String(lot.image_indexes[0]), 10);
      if (Number.isFinite(n) && n >= 0 && n < total) idxFromIndexes = n;
    }
    const resolvedIdx = urlIdx >= 0 ? urlIdx : idxFromIndexes;
    if (resolvedIdx !== undefined) {
      lot.image_indexes = [resolvedIdx];
      lot.image_url = imageUrls[resolvedIdx] || lot.image_url;
    }
    // Ensure image_urls aligns to the primary URL for per_item display paths
    if (typeof lot?.image_url === "string" && lot.image_url) {
      lot.image_urls = [lot.image_url];
    } else if (Array.isArray(lot?.image_urls) && lot.image_urls.length > 0) {
      lot.image_urls = [lot.image_urls[0]];
    }
    return lot;
  });
}

export async function analyzeAssetImages(
  imageUrls: string[],
  groupingMode: AssetGroupingMode,
  language?: "en" | "fr" | "es",
  currency?: string,
  includeDamageAnalysis: boolean = true
): Promise<AssetAnalysisResult> {
  if (!Array.isArray(imageUrls) || imageUrls.length === 0) {
    throw new Error("No image URLs provided for analysis.");
  }

  const lang: "en" | "fr" | "es" = ((): any => {
    const l = String(language || "").toLowerCase();
    return l === "fr" || l === "es" ? l : "en";
  })();
  const ccy = ((): string => {
    const c = String(currency || "").toUpperCase();
    return /^[A-Z]{3}$/.test(c) ? c : process.env.DEFAULT_CURRENCY || "CAD";
  })();
  // Modular handling by mode
  if (groupingMode === "per_item") {
    const { lots: rawLots } = await analyzePerItem(
      imageUrls,
      lang,
      ccy,
      includeDamageAnalysis
    );

    if (!rawLots || rawLots.length === 0) {
      // Fallback to per_photo
      const fallback = await analyzePerPhoto(
        imageUrls,
        lang,
        ccy,
        includeDamageAnalysis
      );
      const fallbackLots = normalizeAssetAiLots(
        addModeTag(
          applyDamageAnalysisToLots(
            Array.isArray(fallback.lots) ? fallback.lots : [],
            includeDamageAnalysis
          ),
          "per_photo"
        )
      );
      return {
        lots: fallbackLots,
        summary: `${fallbackLots.length} items identified via fallback per_photo analysis of ${imageUrls.length} images.`,
        language: fallback.language || lang,
        currency: fallback.currency || ccy,
        damage_analysis: buildReportDamageAnalysis(
          fallbackLots,
          includeDamageAnalysis
        ),
      };
    }

    if (process.env.DEBUG_PER_ITEM === "1") {
      try {
        const dbgList = (rawLots as any[]).map((l: any) => ({
          lot_id: l?.lot_id,
          title: typeof l?.title === "string" ? l.title : undefined,
          image_url: typeof l?.image_url === "string" ? l.image_url : undefined,
          image_indexes: Array.isArray(l?.image_indexes) ? l.image_indexes : [],
        }));
        console.log("[PerItemDebug][per_item:raw]", { count: dbgList.length, list: dbgList });
      } catch {}
    }

    // Deduplicate across images to remove the same physical item
    const dedupedLots = await deduplicateAssetLotsAI(imageUrls, rawLots as any);
    const finalLotsRaw =
      dedupedLots && dedupedLots.length > 0 ? dedupedLots : (rawLots as any);
    const normalized = normalizePerItemLotsImageMapping(finalLotsRaw as any, imageUrls);
    if (process.env.DEBUG_PER_ITEM === "1") {
      try {
        const dbgList = (normalized as any[]).map((l: any) => ({
          lot_id: l?.lot_id,
          title: typeof l?.title === "string" ? l.title : undefined,
          image_url: typeof l?.image_url === "string" ? l.image_url : undefined,
          image_indexes: Array.isArray(l?.image_indexes) ? l.image_indexes : [],
        }));
        console.log("[PerItemDebug][normalize:after]", { count: dbgList.length, list: dbgList });
      } catch {}
    }
    const finalLots = normalizeAssetAiLots(
      addModeTag(
        applyDamageAnalysisToLots(
          normalized as any,
          includeDamageAnalysis
        ) as any,
        "per_item"
      )
    );
    return {
      lots: finalLots,
      summary: `${finalLots.length} unique items identified from ${imageUrls.length} images (per_item, deduped).`,
      language: lang,
      currency: ccy,
      damage_analysis: buildReportDamageAnalysis(
        finalLots,
        includeDamageAnalysis
      ),
    };
  }

  if (groupingMode === "per_photo") {
    const res = await analyzePerPhoto(
      imageUrls,
      lang,
      ccy,
      includeDamageAnalysis
    );
    const lotsTagged = normalizeAssetAiLots(
      addModeTag(
        applyDamageAnalysisToLots(
          Array.isArray(res.lots) ? res.lots : [],
          includeDamageAnalysis
        ),
        "per_photo"
      )
    );
    return {
      lots: lotsTagged,
      summary: res.summary,
      language: res.language || lang,
      currency: res.currency || ccy,
      damage_analysis: buildReportDamageAnalysis(
        lotsTagged,
        includeDamageAnalysis
      ),
    };
  }

  // Default handling for single_lot and catalogue
  const mode: any = groupingMode === "catalogue" ? "catalogue" : "single_lot";
  const bundleRes = await analyzeBundle(
    imageUrls,
    mode,
    lang,
    ccy,
    includeDamageAnalysis
  );
  const lotsTagged = normalizeAssetAiLots(
    addModeTag(
      applyDamageAnalysisToLots(
        Array.isArray(bundleRes.lots) ? bundleRes.lots : [],
        includeDamageAnalysis
      ),
      mode
    )
  );
  return {
    lots: lotsTagged,
    summary: bundleRes.summary,
    language: bundleRes.language || lang,
    currency: bundleRes.currency || ccy,
    damage_analysis: buildReportDamageAnalysis(lotsTagged, includeDamageAnalysis),
  };
}
