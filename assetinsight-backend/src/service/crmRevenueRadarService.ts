/**
 * Aggregates leads, discovery runs, and agent coverage into the Revenue Radar read model.
 * Category/geography normalization is shared across sources so counts and recommendations
 * use consistent dimensions; independent reads run together because the snapshot is
 * observational and does not require a cross-collection transaction.
 */
import CrmAutoFindLead from "../models/crmAutoFindLead.model.js";
import CrmAutoFindRun from "../models/crmAutoFindRun.model.js";
import CrmLead from "../models/crmLead.model.js";
import User from "../models/user.model.js";
import { CANADA_PROVINCES, CRM_AUTO_FIND_MAX_RESULTS, US_STATES } from "./crmAutoFindService.js";
import { isReviewAccount, normalCrmUserFilter } from "./reviewAccountPolicy.js";

export const REVENUE_RADAR_CATEGORY_OPTIONS = [
  {
    id: "auction_liquidation",
    label: "Auction & liquidation",
    keywords: ["auction", "liquidation", "receiver", "asset sale", "estate sale", "business closure"],
  },
  {
    id: "equipment_fleet",
    label: "Equipment & fleet",
    keywords: ["equipment", "fleet", "machinery", "truck", "trailer", "forklift", "loader"],
  },
  {
    id: "salvage_insurance",
    label: "Salvage & insurance",
    keywords: ["salvage", "insurance", "claim", "damage", "towing", "repairable", "write off"],
  },
  {
    id: "farm_ag",
    label: "Farm & agriculture",
    keywords: ["farm", "agriculture", "tractor", "combine", "grain", "rural", "ag dealer"],
  },
  {
    id: "construction_industrial",
    label: "Construction & industrial",
    keywords: ["construction", "industrial", "demolition", "contractor", "mining", "oilfield"],
  },
  {
    id: "municipal_surplus",
    label: "Municipal & surplus",
    keywords: ["municipal", "surplus", "government", "public works", "county", "city fleet"],
  },
  {
    id: "repossession_storage",
    label: "Repossession & storage",
    keywords: ["repossession", "storage", "lien", "seized", "impound", "recovery"],
  },
  {
    id: "appraisal_valuation",
    label: "Appraisal & valuation",
    keywords: ["appraisal", "valuation", "asset value", "estate", "bankruptcy", "financing"],
  },
] as const;

export type RevenueRadarCountry = "Canada" | "United States";

export type RevenueRadarFilters = {
  country?: RevenueRadarCountry | "";
  regions?: string[];
  categories?: string[];
  timeframeDays?: number;
};

type RadarCategoryId = (typeof REVENUE_RADAR_CATEGORY_OPTIONS)[number]["id"];

const SOURCE_CARDS = [
  {
    title: "U.S. Business Formation Statistics",
    url: "https://www.census.gov/econ/bfs/index.html",
    region: "United States",
    note: "Monthly and weekly business application/formation context for prospecting demand.",
  },
  {
    title: "Statistics Canada Web Data Service",
    url: "https://www.statcan.gc.ca/en/developers/wds",
    region: "Canada",
    note: "Official Statistics Canada data access for released business and economic series.",
  },
  {
    title: "Monthly Business Openings and Closures",
    url: "https://www23.statcan.gc.ca/imdb/p2SV.pl?Function=getSurvey&Id=1583365",
    region: "Canada",
    note: "Business opening, closure, survival, and regional activity context.",
  },
];

const COMPLIANCE_CARDS = [
  {
    region: "Canada",
    title: "CASL outreach guardrails",
    url: "https://crtc.gc.ca/eng/com500/guide.htm",
    bullets: [
      "Confirm consent or a valid implied-consent basis before commercial electronic messages.",
      "Identify the sender and include contact information.",
      "Include an unsubscribe mechanism in every commercial electronic message.",
    ],
  },
  {
    region: "United States",
    title: "CAN-SPAM outreach guardrails",
    url: "https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business",
    bullets: [
      "Use truthful header and subject information.",
      "Include a valid physical postal address.",
      "Provide a clear opt-out and honor opt-outs promptly.",
    ],
  },
];

function cleanText(value: unknown): string {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeToken(value: unknown): string {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(cleanText).filter(Boolean);
  const text = cleanText(value);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(cleanText).filter(Boolean);
  } catch {
    // comma-separated query values are expected too
  }
  return text.split(",").map(cleanText).filter(Boolean);
}

function normalizeCountry(value: unknown): RevenueRadarCountry | "" {
  const text = normalizeToken(value);
  if (text === "canada" || text === "ca") return "Canada";
  if (["united states", "usa", "us", "u s"].includes(text)) return "United States";
  return "";
}

function normalizeAllowed(values: unknown, allowed: readonly string[]): string[] {
  const allowedMap = new Map(allowed.map((entry) => [normalizeToken(entry), entry]));
  return Array.from(
    new Set(parseList(values).map((entry) => allowedMap.get(normalizeToken(entry))).filter((entry): entry is string => Boolean(entry)))
  );
}

function normalizeCategories(values: unknown): string[] {
  const allowedMap = new Map<string, (typeof REVENUE_RADAR_CATEGORY_OPTIONS)[number]>(
    REVENUE_RADAR_CATEGORY_OPTIONS.map((entry) => [entry.id, entry])
  );
  const labelMap = new Map<string, (typeof REVENUE_RADAR_CATEGORY_OPTIONS)[number]>(
    REVENUE_RADAR_CATEGORY_OPTIONS.map((entry) => [normalizeToken(entry.label), entry])
  );
  return Array.from(
    new Set(
      parseList(values)
        .map((entry) => allowedMap.get(entry) || labelMap.get(normalizeToken(entry)))
        .filter((entry): entry is (typeof REVENUE_RADAR_CATEGORY_OPTIONS)[number] => Boolean(entry))
        .map((entry) => entry.id)
    )
  );
}

function normalizeTimeframeDays(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 90;
  return Math.min(365, Math.max(7, Math.round(parsed)));
}

function countryRegions(country?: RevenueRadarCountry | "") {
  if (country === "United States") return US_STATES;
  if (country === "Canada") return CANADA_PROVINCES;
  return [...CANADA_PROVINCES, ...US_STATES];
}

function detectCountry(text: string): RevenueRadarCountry | "" {
  const normalized = normalizeToken(text);
  if (!normalized) return "";
  if (normalized.includes("canada")) return "Canada";
  if (normalized.includes("united states") || /\busa\b/.test(normalized)) return "United States";
  if (CANADA_PROVINCES.some((region) => normalized.includes(normalizeToken(region)))) return "Canada";
  if (US_STATES.some((region) => normalized.includes(normalizeToken(region)))) return "United States";
  return "";
}

function detectRegion(text: string, country?: RevenueRadarCountry | ""): string {
  const normalized = normalizeToken(text);
  if (!normalized) return "Unassigned";
  for (const region of countryRegions(country)) {
    if (normalized.includes(normalizeToken(region))) return region;
  }
  return "Unassigned";
}

function leadSearchText(lead: any): string {
  return [
    lead?.clientName,
    lead?.companyName,
    lead?.companyLocation,
    lead?.contactLocation,
    lead?.assignmentMatchedRegion,
    lead?.quadrant,
    lead?.industry,
    lead?.specialization,
    lead?.notes,
    lead?.latestComment,
    ...(Array.isArray(lead?.listItems) ? lead.listItems : []),
  ]
    .map(cleanText)
    .filter(Boolean)
    .join(" ");
}

function autoFindSearchText(item: any): string {
  const lead = item?.lead || {};
  return [
    item?.country,
    ...(Array.isArray(item?.regions) ? item.regions : []),
    ...(Array.isArray(item?.categories) ? item.categories : []),
    item?.keywords,
    lead.companyName,
    lead.clientName,
    lead.companyLocation,
    lead.contactLocation,
    lead.industry,
    lead.evidence,
    ...(Array.isArray(lead.categories) ? lead.categories : []),
  ]
    .map(cleanText)
    .filter(Boolean)
    .join(" ");
}

function detectCategoryId(text: string): RadarCategoryId {
  const normalized = normalizeToken(text);
  for (const category of REVENUE_RADAR_CATEGORY_OPTIONS) {
    if (category.keywords.some((keyword) => normalized.includes(normalizeToken(keyword)))) {
      return category.id;
    }
  }
  return "appraisal_valuation";
}

function categoryLabel(categoryId: string): string {
  return REVENUE_RADAR_CATEGORY_OPTIONS.find((category) => category.id === categoryId)?.label || "Other";
}

function statusOf(lead: any): string {
  return cleanText(lead?.status || "new_lead") || "new_lead";
}

function isClosed(status: string): boolean {
  return status === "won" || status === "lost";
}

function isProposalStage(status: string): boolean {
  return status === "proposal_submitted" || status === "decision_pending";
}

function dateValue(value: unknown): Date | null {
  if (!value) return null;
  const date = new Date(value as string | number | Date);
  return Number.isFinite(date.getTime()) ? date : null;
}

function isOverdue(lead: any, now: Date): boolean {
  const status = statusOf(lead);
  const due = dateValue(lead?.dueDate);
  return Boolean(due && due.getTime() < now.getTime() && !isClosed(status));
}

function isStale(lead: any, now: Date): boolean {
  const status = statusOf(lead);
  if (isClosed(status)) return false;
  const latest = dateValue(lead?.updatedAt) || dateValue(lead?.statusChangedAt) || dateValue(lead?.createdAt);
  if (!latest) return false;
  return now.getTime() - latest.getTime() > 21 * 24 * 60 * 60 * 1000;
}

function roundPercent(value: number): number {
  return Math.round(value * 10) / 10;
}

function makeRegionRow(country: RevenueRadarCountry | "", region: string) {
  return {
    country: country || "",
    region,
    totalLeads: 0,
    activePipeline: 0,
    won: 0,
    proposalStage: 0,
    overdue: 0,
    stale: 0,
    autoFound: 0,
    importedProspects: 0,
    score: 0,
    topCategories: [] as Array<{ id: string; label: string; count: number }>,
    _categoryCounts: new Map<string, number>(),
  };
}

function sourceName(lead: any): string {
  const file = cleanText(lead?.sourceFileName);
  const batch = cleanText(lead?.sourceBatchId);
  if (/auto find/i.test(file) || /^crm-auto-find/i.test(batch)) return "Public web auto-find";
  if (file) return "Spreadsheet import";
  return "Manual CRM";
}

function userLabel(user: any): string {
  if (!user) return "";
  return cleanText(user?.username) || cleanText(user?.email) || cleanText(user?.companyName);
}

function chooseSuggestedAgent(agents: any[], locationText: string): { id: string; label: string } | null {
  const productionAgents = agents.filter((agent) => !isReviewAccount(agent));
  if (!productionAgents.length) return null;
  const normalizedLocation = normalizeToken(locationText);
  const matched = productionAgents.find((agent) => {
    const address = normalizeToken(agent?.crmAddress || agent?.companyName || "");
    return address && normalizedLocation && (normalizedLocation.includes(address) || address.includes(normalizedLocation));
  });
  const agent = matched || productionAgents[0];
  return { id: String(agent?._id || ""), label: userLabel(agent) || "CRM agent" };
}

export function buildRevenueRadarSearchKeywords(input: {
  categories?: string[];
  keywords?: string;
}): string {
  const selected = normalizeCategories(input.categories);
  const categoryPool = selected.length
    ? REVENUE_RADAR_CATEGORY_OPTIONS.filter((entry) => selected.includes(entry.id))
    : REVENUE_RADAR_CATEGORY_OPTIONS;
  const keywordParts = [
    cleanText(input.keywords),
    ...categoryPool.flatMap((category) => category.keywords.slice(0, 4)),
    "auction appraisal liquidation asset recovery fleet disposal equipment valuation insurance salvage municipal surplus",
  ].filter(Boolean);
  return Array.from(new Set(keywordParts.join(", ").split(",").map(cleanText).filter(Boolean))).join(", ").slice(0, 300);
}

export async function getRevenueRadarSnapshot(filters: RevenueRadarFilters = {}) {
  const country = normalizeCountry(filters.country);
  const regions = normalizeAllowed(filters.regions, countryRegions(country));
  const categories = normalizeCategories(filters.categories);
  const timeframeDays = normalizeTimeframeDays(filters.timeframeDays);
  const now = new Date();
  const fromDate = new Date(now.getTime() - timeframeDays * 24 * 60 * 60 * 1000);

  const [leadDocs, autoFindDocs, runDocs, agents] = await Promise.all([
    CrmLead.find({ createdAt: { $gte: fromDate }, isReviewData: { $ne: true } })
      .select(
        "clientName companyName companyLocation contactLocation assignmentMatchedRegion quadrant industry specialization notes latestComment listItems status dueDate updatedAt statusChangedAt createdAt sourceFileName sourceBatchId assignedTo isReviewData"
      )
      .populate("assignedTo", "email username companyName crmAddress isReviewAccount")
      .sort({ createdAt: -1 })
      .limit(10000)
      .lean(),
    CrmAutoFindLead.find({ createdAt: { $gte: fromDate } })
      .sort({ createdAt: -1 })
      .limit(5000)
      .lean(),
    CrmAutoFindRun.find({ createdAt: { $gte: fromDate } })
      .select("status duplicateCount searched criteria createdAt updatedAt")
      .sort({ createdAt: -1 })
      .limit(1000)
      .lean(),
    User.find({ role: "user", isCrmAgent: true, isBlocked: { $ne: true }, ...normalCrmUserFilter() })
      .select("email username companyName crmAddress crmSpecializations isReviewAccount")
      .sort({ username: 1, email: 1 })
      .lean(),
  ]);

  const regionFilter = new Set(regions.map(normalizeToken));
  const categoryFilter = new Set(categories);

  const filteredLeads = leadDocs.filter((lead: any) => {
    // Synthetic reviewer work is not production pipeline or follow-up demand.
    if (lead.isReviewData === true || isReviewAccount(lead.assignedTo)) return false;
    const text = leadSearchText(lead);
    const detectedCountry = detectCountry(text);
    const detectedRegion = detectRegion(text, country || detectedCountry);
    const detectedCategory = detectCategoryId(text);
    if (country && detectedCountry && detectedCountry !== country) return false;
    if (regionFilter.size && !regionFilter.has(normalizeToken(detectedRegion))) return false;
    if (categoryFilter.size && !categoryFilter.has(detectedCategory)) return false;
    return true;
  });

  const filteredAutoFind = autoFindDocs.filter((item: any) => {
    const text = autoFindSearchText(item);
    const detectedCountry = normalizeCountry(item?.country) || detectCountry(text);
    const regionValues = Array.isArray(item?.regions) ? item.regions.map(cleanText).filter(Boolean) : [];
    const detectedRegion = regionValues[0] || detectRegion(text, country || detectedCountry);
    const detectedCategory = detectCategoryId(text);
    if (country && detectedCountry && detectedCountry !== country) return false;
    if (regionFilter.size && !regionFilter.has(normalizeToken(detectedRegion))) return false;
    if (categoryFilter.size && !categoryFilter.has(detectedCategory)) return false;
    return true;
  });

  const kpis = {
    totalLeads: filteredLeads.length,
    activePipeline: 0,
    won: 0,
    lost: 0,
    proposalStage: 0,
    overdue: 0,
    stale: 0,
    publicProspects: filteredAutoFind.length,
    duplicateProspects: runDocs.reduce((sum: number, run: any) => sum + Number(run?.duplicateCount || 0), 0),
    conversionRate: 0,
  };

  const regionMap = new Map<string, ReturnType<typeof makeRegionRow>>();
  const categoryMap = new Map<string, { id: string; label: string; leads: number; won: number; activePipeline: number; autoFound: number; score: number }>();
  const sourceMap = new Map<string, number>();

  for (const lead of filteredLeads as any[]) {
    const text = leadSearchText(lead);
    const detectedCountry = country || detectCountry(text);
    const region = detectRegion(text, detectedCountry);
    const categoryId = detectCategoryId(text);
    const status = statusOf(lead);
    const overdue = isOverdue(lead, now);
    const stale = isStale(lead, now);
    const regionKey = `${detectedCountry || "Unknown"}|${region}`;
    const regionRow = regionMap.get(regionKey) || makeRegionRow(detectedCountry, region);
    regionMap.set(regionKey, regionRow);

    regionRow.totalLeads += 1;
    regionRow._categoryCounts.set(categoryId, (regionRow._categoryCounts.get(categoryId) || 0) + 1);
    if (!isClosed(status)) regionRow.activePipeline += 1;
    if (status === "won") regionRow.won += 1;
    if (isProposalStage(status)) regionRow.proposalStage += 1;
    if (overdue) regionRow.overdue += 1;
    if (stale) regionRow.stale += 1;

    if (!isClosed(status)) kpis.activePipeline += 1;
    if (status === "won") kpis.won += 1;
    if (status === "lost") kpis.lost += 1;
    if (isProposalStage(status)) kpis.proposalStage += 1;
    if (overdue) kpis.overdue += 1;
    if (stale) kpis.stale += 1;

    const categoryRow = categoryMap.get(categoryId) || {
      id: categoryId,
      label: categoryLabel(categoryId),
      leads: 0,
      won: 0,
      activePipeline: 0,
      autoFound: 0,
      score: 0,
    };
    categoryRow.leads += 1;
    if (status === "won") categoryRow.won += 1;
    if (!isClosed(status)) categoryRow.activePipeline += 1;
    categoryMap.set(categoryId, categoryRow);

    const source = sourceName(lead);
    sourceMap.set(source, (sourceMap.get(source) || 0) + 1);
  }

  for (const item of filteredAutoFind as any[]) {
    const text = autoFindSearchText(item);
    const detectedCountry = normalizeCountry(item?.country) || country || detectCountry(text);
    const region = (Array.isArray(item?.regions) && cleanText(item.regions[0])) || detectRegion(text, detectedCountry);
    const categoryId = detectCategoryId(text);
    const regionKey = `${detectedCountry || "Unknown"}|${region}`;
    const regionRow = regionMap.get(regionKey) || makeRegionRow(detectedCountry, region);
    regionMap.set(regionKey, regionRow);
    regionRow.autoFound += 1;
    if (cleanText(item?.status) === "imported") regionRow.importedProspects += 1;
    regionRow._categoryCounts.set(categoryId, (regionRow._categoryCounts.get(categoryId) || 0) + 1);

    const categoryRow = categoryMap.get(categoryId) || {
      id: categoryId,
      label: categoryLabel(categoryId),
      leads: 0,
      won: 0,
      activePipeline: 0,
      autoFound: 0,
      score: 0,
    };
    categoryRow.autoFound += 1;
    categoryMap.set(categoryId, categoryRow);
  }

  kpis.conversionRate = roundPercent((kpis.won / Math.max(1, kpis.won + kpis.lost)) * 100);

  const regionBreakdown = Array.from(regionMap.values())
    .map((row) => {
      row.topCategories = Array.from(row._categoryCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([id, count]) => ({ id, label: categoryLabel(id), count }));
      row.score = Math.min(
        100,
        Math.round(
          row.totalLeads * 3 +
            row.activePipeline * 2 +
            row.proposalStage * 8 +
            row.won * 10 +
            row.autoFound * 2 +
            row.importedProspects * 5 +
            row.overdue * 3 +
            row.stale * 2
        )
      );
      const { _categoryCounts, ...publicRow } = row;
      return publicRow;
    })
    .sort((a, b) => b.score - a.score || b.totalLeads - a.totalLeads)
    .slice(0, 12);

  const categoryBreakdown = Array.from(categoryMap.values())
    .map((row) => ({
      ...row,
      score: Math.min(100, Math.round(row.leads * 3 + row.activePipeline * 2 + row.won * 10 + row.autoFound * 2)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);

  const sourceBreakdown = Array.from(sourceMap.entries())
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count);

  const staleLeads = (filteredLeads as any[])
    .filter((lead) => isStale(lead, now) || isOverdue(lead, now))
    .slice(0, 12)
    .map((lead) => ({
      id: String(lead?._id || ""),
      clientName: cleanText(lead?.clientName),
      companyName: cleanText(lead?.companyName),
      status: statusOf(lead),
      dueDate: lead?.dueDate || null,
      updatedAt: lead?.updatedAt || null,
      assignedTo: userLabel(lead?.assignedTo),
      location: cleanText(lead?.companyLocation || lead?.contactLocation || lead?.assignmentMatchedRegion),
      overdue: isOverdue(lead, now),
      stale: isStale(lead, now),
    }));

  const recentProspects = (filteredAutoFind as any[]).slice(0, 25).map((item) => {
    const lead = item?.lead || {};
    const location = cleanText(lead.companyLocation || lead.contactLocation || (Array.isArray(item?.regions) ? item.regions.join(", ") : ""));
    const categoryId = detectCategoryId(autoFindSearchText(item));
    return {
      id: String(item?._id || ""),
      status: cleanText(item?.status || "previewed"),
      country: cleanText(item?.country),
      regions: Array.isArray(item?.regions) ? item.regions.map(cleanText).filter(Boolean) : [],
      category: { id: categoryId, label: categoryLabel(categoryId) },
      companyName: cleanText(lead.companyName),
      clientName: cleanText(lead.clientName),
      email: cleanText(lead.email),
      phoneRaw: cleanText(lead.phoneRaw),
      website: cleanText(lead.website),
      location,
      confidence: Math.round(Number(item?.confidence || lead.confidence || 0) * 100),
      sourceUrl: cleanText(item?.sourceUrl || lead.sourceUrl),
      sourceTitle: cleanText(item?.sourceTitle || lead.sourceTitle),
      evidence: cleanText(lead.evidence),
      suggestedAgent: chooseSuggestedAgent(agents, location),
      createdAt: item?.createdAt || null,
    };
  });

  const topRegion = regionBreakdown[0];
  const topCategories = categoryBreakdown.slice(0, 3).map((category) => category.id);
  const recommendedCountry = country || (topRegion?.country as RevenueRadarCountry | "") || "Canada";
  const recommendedRegions = regions.length ? regions : topRegion?.region && topRegion.region !== "Unassigned" ? [topRegion.region] : [];
  const recommendedCategories = categories.length ? categories : topCategories.length ? topCategories : ["auction_liquidation", "equipment_fleet", "salvage_insurance"];

  return {
    asOf: now.toISOString(),
    filters: { country, regions, categories, timeframeDays },
    options: {
      countries: ["Canada", "United States"],
      canadaProvinces: CANADA_PROVINCES,
      usStates: US_STATES,
      categories: REVENUE_RADAR_CATEGORY_OPTIONS.map(({ id, label }) => ({ id, label })),
      timeframeDays: [30, 60, 90, 180, 365],
      maxResults: Math.min(CRM_AUTO_FIND_MAX_RESULTS, 100),
    },
    kpis,
    regionBreakdown,
    categoryBreakdown,
    sourceBreakdown,
    staleLeads,
    recentProspects,
    recommendations: {
      country: recommendedCountry,
      regions: recommendedRegions,
      categories: recommendedCategories,
      keywords: buildRevenueRadarSearchKeywords({ categories: recommendedCategories }),
      maxResults: 30,
      rationale: topRegion
        ? `${topRegion.region} has the highest current opportunity score from CRM pipeline, proposals, public prospects, and follow-up risk.`
        : "Start with broad public prospecting in core auction, equipment, salvage, and valuation categories.",
    },
    marketSources: SOURCE_CARDS,
    compliance: COMPLIANCE_CARDS,
  };
}
