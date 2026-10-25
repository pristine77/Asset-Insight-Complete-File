/**
 * Discovers and normalizes CRM prospects through a search-capable AI provider. The
 * service constrains geography and output shape, deduplicates weak provider results,
 * and bounds parallel searches so a broad campaign cannot exhaust upstream quotas.
 * Returning per-region diagnostics allows useful leads to survive partial failures.
 */
import openai from "../utils/openaiClient.js";
import { getPositiveIntEnv, mapWithConcurrency } from "../utils/concurrency.js";

export const CANADA_PROVINCES = [
  "Alberta",
  "British Columbia",
  "Manitoba",
  "New Brunswick",
  "Newfoundland and Labrador",
  "Nova Scotia",
  "Ontario",
  "Prince Edward Island",
  "Quebec",
  "Saskatchewan",
  "Northwest Territories",
  "Nunavut",
  "Yukon",
] as const;

export const US_STATES = [
  "Alabama",
  "Alaska",
  "Arizona",
  "Arkansas",
  "California",
  "Colorado",
  "Connecticut",
  "Delaware",
  "Florida",
  "Georgia",
  "Hawaii",
  "Idaho",
  "Illinois",
  "Indiana",
  "Iowa",
  "Kansas",
  "Kentucky",
  "Louisiana",
  "Maine",
  "Maryland",
  "Massachusetts",
  "Michigan",
  "Minnesota",
  "Mississippi",
  "Missouri",
  "Montana",
  "Nebraska",
  "Nevada",
  "New Hampshire",
  "New Jersey",
  "New Mexico",
  "New York",
  "North Carolina",
  "North Dakota",
  "Ohio",
  "Oklahoma",
  "Oregon",
  "Pennsylvania",
  "Rhode Island",
  "South Carolina",
  "South Dakota",
  "Tennessee",
  "Texas",
  "Utah",
  "Vermont",
  "Virginia",
  "Washington",
  "West Virginia",
  "Wisconsin",
  "Wyoming",
] as const;

export type CrmAutoFindCountry = "Canada" | "United States";

export type CrmAutoFindLeadResult = {
  clientName: string;
  companyName: string;
  email: string;
  phoneRaw: string;
  website: string;
  companyLocation: string;
  contactLocation: string;
  contactSocials: string;
  contactLinkedinUrl: string;
  companyLinkedinUrl: string;
  industry: string;
  suggestedSpecialization: "industrial_construction" | "farm_equipment_sales" | "others";
  categories: string[];
  sourceUrl: string;
  sourceTitle: string;
  sourcePlatform: string;
  confidence: number;
  evidence: string;
  queryUsed: string;
};

export type CrmAutoFindRequest = {
  country: CrmAutoFindCountry;
  regions: string[];
  categories: string[];
  keywords?: string;
  maxResults?: number;
  excludeFingerprints?: string[];
  searchFocus?: string;
  batchIndex?: number;
  batchTotal?: number;
};

export type CrmAutoFindSearchPlan = {
  batchIndex: number;
  regions: string[];
  categories: string[];
  searchFocus: string;
};

export const CRM_AUTO_FIND_MAX_RESULTS = 100;
export const CRM_AUTO_FIND_BATCH_COUNT = 10;
export const CRM_AUTO_FIND_BATCH_SIZE = 10;

const crmAutoFindSchema = {
  type: "object",
  properties: {
    leads: {
      type: "array",
      items: {
        type: "object",
        properties: {
          clientName: { type: "string" },
          companyName: { type: "string" },
          email: { type: "string" },
          phoneRaw: { type: "string" },
          website: { type: "string" },
          companyLocation: { type: "string" },
          contactLocation: { type: "string" },
          contactSocials: { type: "string" },
          contactLinkedinUrl: { type: "string" },
          companyLinkedinUrl: { type: "string" },
          industry: { type: "string" },
          suggestedSpecialization: {
            type: "string",
            enum: ["industrial_construction", "farm_equipment_sales", "others"],
          },
          categories: { type: "array", items: { type: "string" } },
          sourceUrl: { type: "string" },
          sourceTitle: { type: "string" },
          sourcePlatform: { type: "string" },
          confidence: { type: "number" },
          evidence: { type: "string" },
          queryUsed: { type: "string" },
        },
        required: [
          "clientName",
          "companyName",
          "email",
          "phoneRaw",
          "website",
          "companyLocation",
          "contactLocation",
          "contactSocials",
          "contactLinkedinUrl",
          "companyLinkedinUrl",
          "industry",
          "suggestedSpecialization",
          "categories",
          "sourceUrl",
          "sourceTitle",
          "sourcePlatform",
          "confidence",
          "evidence",
          "queryUsed",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["leads"],
  additionalProperties: false,
};

function cleanText(value: unknown): string {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeUrl(value: unknown): string {
  const raw = cleanText(value);
  if (!raw) return "";
  try {
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const url = new URL(withProtocol);
    url.hash = "";
    return url.toString();
  } catch {
    return raw;
  }
}

export function normalizeDomain(value: unknown): string {
  const raw = cleanText(value);
  if (!raw) return "";
  try {
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withProtocol).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return raw
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .split(/[/?#]/)[0]
      .toLowerCase();
  }
}

export function buildAutoFindFingerprint(input: {
  companyName?: string;
  website?: string;
  sourceUrl?: string;
  companyLocation?: string;
}): string {
  const domain = normalizeDomain(input.website) || normalizeDomain(input.sourceUrl);
  if (domain) return `domain:${domain}`;

  const company = cleanText(input.companyName).toLowerCase();
  const location = cleanText(input.companyLocation).toLowerCase();
  return `company:${company || "unknown"}|location:${location || "unknown"}`;
}

export function buildAutoFindDedupKeys(lead: CrmAutoFindLeadResult): string[] {
  const keys = new Set<string>();
  const websiteDomain = normalizeDomain(lead.website);
  const sourceDomain = normalizeDomain(lead.sourceUrl);
  const sourceUrl = normalizeUrl(lead.sourceUrl).toLowerCase();
  const fingerprint = buildAutoFindFingerprint({
    companyName: lead.companyName,
    website: lead.website,
    sourceUrl: lead.sourceUrl,
    companyLocation: lead.companyLocation,
  });
  const company = cleanText(lead.companyName).toLowerCase();
  const location = cleanText(lead.companyLocation).toLowerCase();

  if (websiteDomain) keys.add(`website:${websiteDomain}`);
  if (sourceUrl) keys.add(`source:${sourceUrl}`);
  if (sourceDomain && !websiteDomain) keys.add(`source-domain:${sourceDomain}`);
  if (fingerprint) keys.add(`fingerprint:${fingerprint}`);
  if (company) keys.add(`company:${company}|${location || "unknown"}`);
  return Array.from(keys);
}

export function generateCrmAutoFindSearchPlans(input: {
  country: CrmAutoFindCountry;
  regions: string[];
  categories: string[];
  keywords?: string;
}): CrmAutoFindSearchPlan[] {
  const regionPool = input.regions.length ? input.regions : [input.country];
  const categoryPool = input.categories.length ? input.categories : ["salvage", "asset recovery", "heavy equipment"];
  const sourceFocuses = [
    "official company websites and contact pages",
    "business directories and chamber listings",
    "auction, liquidation, and equipment marketplace profiles",
    "insurance salvage, towing, fleet, and repair business pages",
    "construction, industrial, demolition, and contractor directories",
    "farm equipment dealers, ag service companies, and rural auction sources",
    "municipal surplus, repossession, asset recovery, and storage businesses",
    "LinkedIn company pages and public professional profiles visible in search",
    "Facebook public business pages, Kijiji business posts, and local listings",
    "regional niche searches using alternate keywords and nearby cities",
  ];

  return Array.from({ length: CRM_AUTO_FIND_BATCH_COUNT }, (_, index) => {
    const region = regionPool[index % regionPool.length];
    const nextRegion = regionPool[(index + 3) % regionPool.length];
    const category = categoryPool[index % categoryPool.length];
    const nextCategory = categoryPool[(index + 2) % categoryPool.length];
    return {
      batchIndex: index + 1,
      regions: Array.from(new Set([region, nextRegion].filter(Boolean))),
      categories: Array.from(new Set([category, nextCategory].filter(Boolean))),
      searchFocus: sourceFocuses[index],
    };
  });
}

function normalizeLead(item: any): CrmAutoFindLeadResult {
  const sourceUrl = normalizeUrl(item?.sourceUrl);
  const website = normalizeUrl(item?.website);
  const categories = Array.isArray(item?.categories)
    ? item.categories.map((value: unknown) => cleanText(value)).filter(Boolean).slice(0, 8)
    : [];
  const specialization = cleanText(item?.suggestedSpecialization) as CrmAutoFindLeadResult["suggestedSpecialization"];

  return {
    clientName: cleanText(item?.clientName) || cleanText(item?.companyName) || "Unknown contact",
    companyName: cleanText(item?.companyName),
    email: cleanText(item?.email).toLowerCase(),
    phoneRaw: cleanText(item?.phoneRaw),
    website,
    companyLocation: cleanText(item?.companyLocation),
    contactLocation: cleanText(item?.contactLocation),
    contactSocials: cleanText(item?.contactSocials),
    contactLinkedinUrl: normalizeUrl(item?.contactLinkedinUrl),
    companyLinkedinUrl: normalizeUrl(item?.companyLinkedinUrl),
    industry: cleanText(item?.industry),
    suggestedSpecialization: ["industrial_construction", "farm_equipment_sales", "others"].includes(specialization)
      ? specialization
      : "others",
    categories,
    sourceUrl,
    sourceTitle: cleanText(item?.sourceTitle),
    sourcePlatform: cleanText(item?.sourcePlatform) || (sourceUrl ? normalizeDomain(sourceUrl) : "Web"),
    confidence: Math.max(0, Math.min(1, Number(item?.confidence) || 0)),
    evidence: cleanText(item?.evidence),
    queryUsed: cleanText(item?.queryUsed),
  };
}

export async function findCrmClientsWithOpenAI(input: CrmAutoFindRequest): Promise<CrmAutoFindLeadResult[]> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured");
  }

  const maxResults = Math.min(Math.max(Number(input.maxResults || CRM_AUTO_FIND_BATCH_SIZE), 1), CRM_AUTO_FIND_BATCH_SIZE);
  const regionText = input.regions.length ? input.regions.join(", ") : input.country;
  const categoryText = input.categories.length ? input.categories.join(", ") : "salvage, seized vehicles, heavy equipment, farm equipment, construction assets";
  const exclusions = (input.excludeFingerprints || []).slice(0, 120).join("\n");

  const prompt = `Find up to ${maxResults} PUBLICLY INDEXED business leads in ${regionText}, ${input.country}.
This is batch ${input.batchIndex || 1} of ${input.batchTotal || 1}. Search focus: ${cleanText(input.searchFocus) || "broad public web prospecting"}.

Goal: find companies or organizations likely to need salvage, appraisal, auction, liquidation, asset recovery, fleet disposal, insurance salvage, equipment valuation, or seized asset services.

Category focus: ${categoryText}.
Optional admin keywords: ${cleanText(input.keywords) || "None"}.

Sources:
- Use public web results and public pages.
- Public LinkedIn, Kijiji, Facebook, and X pages may be used only when visible in search results.
- Prefer official company websites, public directories, industry pages, marketplace business profiles, and public social pages with source URLs.

Avoid returning leads matching these prior fingerprints:
${exclusions || "(none)"}

Return only leads that have at least a company name and one public source URL. Contact email/phone can be an empty string when not publicly found.
Set confidence from 0 to 1 based on fit and source quality.
Use these CRM specializations only: industrial_construction, farm_equipment_sales, others.`;

  const response = await openai.responses.create({
    model: process.env.OPENAI_PRIMARY_MODEL || "gpt-5.6-terra",
    tools: [
      {
        type: "web_search",
        external_web_access: true,
        search_context_size: "high",
      },
    ],
    tool_choice: "required",
    input: prompt,
    text: {
      format: {
        type: "json_schema",
        name: "crm_auto_find_clients",
        strict: true,
        schema: crmAutoFindSchema,
      },
    },
  } as any);

  const text = String((response as any)?.output_text || "").trim();
  if (!text) return [];

  const parsed = JSON.parse(text) as { leads?: unknown[] };
  const leads = Array.isArray(parsed?.leads) ? parsed.leads : [];
  return leads
    .map((item) => normalizeLead(item))
    .filter((lead) => lead.companyName && lead.sourceUrl)
    .slice(0, maxResults);
}

export async function runCrmAutoFindSearchPlans(input: {
  country: CrmAutoFindCountry;
  regions: string[];
  categories: string[];
  keywords?: string;
  maxResults: number;
  excludeFingerprints: string[];
  onBatchComplete?: (result: {
    batchIndex: number;
    leads: CrmAutoFindLeadResult[];
    error?: string;
  }) => Promise<void>;
  shouldStop?: () => Promise<boolean> | boolean;
}): Promise<{ leads: CrmAutoFindLeadResult[]; failedBatches: number }> {
  const plans = generateCrmAutoFindSearchPlans(input);
  const dedupeKeys = new Set<string>();
  const merged: CrmAutoFindLeadResult[] = [];
  let failedBatches = 0;
  const concurrency = getPositiveIntEnv("CRM_AUTO_FIND_SEARCH_CONCURRENCY", 2);

  await mapWithConcurrency(plans, concurrency, async (plan) => {
    try {
      if (await input.shouldStop?.()) {
        return;
      }
      const leads = await findCrmClientsWithOpenAI({
        country: input.country,
        regions: plan.regions,
        categories: plan.categories,
        keywords: input.keywords,
        maxResults: CRM_AUTO_FIND_BATCH_SIZE,
        excludeFingerprints: input.excludeFingerprints,
        searchFocus: plan.searchFocus,
        batchIndex: plan.batchIndex,
        batchTotal: CRM_AUTO_FIND_BATCH_COUNT,
      });

      const stopAfterInflight = await input.shouldStop?.();
      if (stopAfterInflight) {
        await input.onBatchComplete?.({ batchIndex: plan.batchIndex, leads: [] });
        return;
      }

      const accepted: CrmAutoFindLeadResult[] = [];
      for (const lead of leads) {
        if (merged.length >= input.maxResults) break;
        const keys = buildAutoFindDedupKeys(lead);
        if (keys.some((key) => dedupeKeys.has(key))) continue;
        keys.forEach((key) => dedupeKeys.add(key));
        merged.push(lead);
        accepted.push(lead);
      }

      await input.onBatchComplete?.({ batchIndex: plan.batchIndex, leads: accepted });
    } catch (error: any) {
      failedBatches += 1;
      await input.onBatchComplete?.({
        batchIndex: plan.batchIndex,
        leads: [],
        error: error?.message || String(error),
      });
    }
  });

  return { leads: merged.slice(0, input.maxResults), failedBatches };
}
