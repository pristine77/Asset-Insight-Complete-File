/**
 * Collects market evidence from external search and listing sources, then normalizes it
 * into comparable records for valuation workflows. Provider-specific failures are
 * isolated so one unavailable source does not erase usable evidence returned by others.
 */
import axios from "axios";
import openai from "../utils/openaiClient.js";

export type MarketIndicators = {
  bullets: string[];
  sources: { title: string; url: string }[];
  series: { years: number[]; values: number[] };
};

function extractKeywordsFromLots(reportData: any): string[] {
  try {
    const lots: any[] = Array.isArray(reportData?.lots) ? reportData.lots : [];
    const texts: string[] = [];
    for (const lot of lots) {
      if (typeof lot?.title === "string") texts.push(lot.title);
      if (typeof lot?.description === "string") texts.push(lot.description);
      if (Array.isArray(lot?.tags)) {
        for (const t of lot.tags) if (typeof t === "string") texts.push(t);
      }
      if (Array.isArray(lot?.items)) {
        for (const it of lot.items) {
          if (typeof it?.title === "string") texts.push(it.title);
          if (typeof it?.description === "string") texts.push(it.description);
          if (typeof it?.details === "string") texts.push(it.details);
        }
      }
    }
    const blob = texts.join(" ").toLowerCase();
    const tokens = blob
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w && w.length >= 3);
    const counts = new Map<string, number>();
    for (const tk of tokens) counts.set(tk, (counts.get(tk) || 0) + 1);
    const top = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([w]) => w);
    return top;
  } catch {
    return [];
  }
}

function deriveIndustryFromReport(reportData: any): { industry: string; keywords: string[] } {
  const explicit = (reportData?.industry && String(reportData.industry)) || "";
  const kws = extractKeywordsFromLots(reportData);
  const has = (list: string[]) => list.some((w) => kws.includes(w));

  // Category heuristics
  if (has(["salvage", "wrecked", "writeoff", "damage"])) {
    return { industry: "Salvage Vehicles", keywords: kws };
  }
  if (has(["car", "cars", "truck", "trucks", "vehicle", "vehicles", "suv", "sedan", "motorcycle", "van"])) {
    return { industry: "Vehicles", keywords: kws };
  }
  if (has(["acre", "realtor", "property", "building", "sq", "residential", "commercial", "land"])) {
    return { industry: "Real Estate", keywords: kws };
  }
  if (has(["excavator", "loader", "bulldozer", "dozer", "tractor", "backhoe", "skidsteer", "grader", "forklift"])) {
    return { industry: "Heavy Equipment", keywords: kws };
  }
  if (explicit) {
    return { industry: explicit, keywords: kws };
  }
  return { industry: "General Assets", keywords: kws };
}

function collectReportStrings(value: unknown, depth = 0): string[] {
  if (depth > 4 || value == null) return [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectReportStrings(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((item) =>
      collectReportStrings(item, depth + 1)
    );
  }
  return [];
}

function detectPrimaryRegion(reportData: any): string {
  const explicitCountry = String(
    reportData?.country ||
      reportData?.property_details?.country ||
      reportData?.preview_data?.country ||
      reportData?.preview_data?.property_details?.country ||
      ""
  )
    .trim();

  if (explicitCountry) return explicitCountry;

  const corpus = collectReportStrings(reportData).join(" ").toLowerCase();
  const regionMatchers: Array<{ region: string; pattern: RegExp }> = [
    {
      region: "Canada",
      pattern:
        /\b(canada|ontario|alberta|british columbia|saskatchewan|manitoba|quebec|nova scotia|new brunswick|newfoundland|labrador|prince edward island|pei|nunavut|yukon|northwest territories)\b/i,
    },
    {
      region: "United States",
      pattern:
        /\b(united states|u\.s\.a\.?|usa|texas|california|florida|new york|illinois|washington|arizona|nevada|georgia|ohio|north carolina|south carolina|pennsylvania)\b/i,
    },
    {
      region: "Mexico",
      pattern: /\b(mexico|ciudad de mexico|guadalajara|monterrey|jalisco|nuevo leon)\b/i,
    },
    {
      region: "United Kingdom",
      pattern: /\b(united kingdom|uk|england|scotland|wales|northern ireland|london|manchester)\b/i,
    },
  ];

  for (const matcher of regionMatchers) {
    if (matcher.pattern.test(corpus)) {
      return matcher.region;
    }
  }

  const currency = String(reportData?.currency || "").trim().toUpperCase();
  if (currency === "CAD") return "Canada";
  if (currency === "USD") return "United States";
  if (currency === "MXN") return "Mexico";
  if (currency === "GBP") return "United Kingdom";

  return "Canada";
}

/**
 * Fetch market indicators using OpenAI Responses API with web_search_preview.
 * Falls back to safe, sample values when unavailable or on any errors.
 */
export async function fetchMarketIndicators(
  industry: string,
  region?: string,
  contextKeywords: string[] = [],
  language?: 'en' | 'fr' | 'es'
): Promise<MarketIndicators> {
  const lang: 'en' | 'fr' | 'es' = ((): any => {
    const l = String(language || '').toLowerCase();
    return (l === 'fr' || l === 'es') ? l : 'en';
  })();
  const i18n = {
    en: {
      sample1: (ind: string, reg?: string) => `Sample insight: ${ind} demand has shown steady growth over 5 years in ${reg || 'target region'}.`,
      sample2: `Auction activity and secondary market pricing remain supportive of appraised values.`,
      sample3: `Capital expenditure cycles and infrastructure investments underpin medium‑term stability.`,
      notFound: 'not found',
    },
    fr: {
      sample1: (ind: string, reg?: string) => `Aperçu : la demande pour ${ind} a affiché une croissance régulière sur 5 ans ${reg ? `au(x) ${reg}` : 'dans la région cible'}.`,
      sample2: `L’activité des enchères et les prix du marché secondaire soutiennent les valeurs estimées.`,
      sample3: `Les cycles de dépenses en capital et les investissements dans les infrastructures soutiennent la stabilité à moyen terme.`,
      notFound: 'introuvable',
    },
    es: {
      sample1: (ind: string, reg?: string) => `Dato de muestra: la demanda de ${ind} ha mostrado un crecimiento constante en 5 años en ${reg || 'la región objetivo'}.`,
      sample2: `La actividad de subastas y los precios del mercado secundario respaldan los valores tasados.`,
      sample3: `Los ciclos de gasto de capital y las inversiones en infraestructura respaldan la estabilidad a medio plazo.`,
      notFound: 'no encontrado',
    },
  } as const;
  const fallback: MarketIndicators = {
    bullets: [
      i18n[lang].sample1(industry, region),
      i18n[lang].sample2,
      i18n[lang].sample3,
    ],
    sources: [
      { title: "Industry overview (sample)", url: "https://www.ritchiebros.com/market-trends" },
      { title: "Equipment market trends (sample)", url: "https://www.statcan.gc.ca/" },
      { title: "Machinery outlook (sample)", url: "https://fred.stlouisfed.org/" },
    ],
    series: { years: [2021, 2022, 2023, 2024, 2025], values: [3.6, 4.0, 4.2, 4.1, 4.3] },
  };

  // Use OpenAI web_search_preview to retrieve sources and insights
  try {
    const yearNow = new Date().getFullYear();
    const prompt = `You are a market analyst. Using web search, produce:
{
  "bullets": ["3-5 concise insights about the ${industry} market${region ? ` in ${region}` : ""}"],
  "sources": [{"title": "string", "url": "https://..."}],
  "series": {"years": [${yearNow - 4}, ${yearNow - 3}, ${yearNow - 2}, ${yearNow - 1}, ${yearNow}], "values": [n1, n2, n3, n4, n5]}
}
Rules:
- Output JSON ONLY with the exact keys and structure above — no prose before or after.
- "values" represent an approximate market size or appraised value proxy in CAD billions with one decimal place.
- Sources must be reputable pages relevant to the query.
- IMPORTANT: Bullet strings must be written in the following language: ${lang}. Keep JSON keys in English.
Query focus: ${industry} market ${region ? `in ${region}` : "(global or relevant region)"}.
Context terms from the appraisal results (use to refine the search and make insights specific): ${contextKeywords
      .slice(0, 20)
      .join(", ")}.`;

    const response = await openai.responses.create({
      model: "gpt-4.1",
      tools: [
        {
          type: "web_search_preview",
          search_context_size: "high",
        },
      ],
      input: prompt,
    });

    const content = (response as any)?.output_text as string | undefined;
    let parsed: any | null = null;
    if (content) {
      // Try direct JSON parse first
      try {
        parsed = JSON.parse(content);
      } catch {
        // Fallback: capture JSON object substring
        const m = content.match(/\{[\s\S]*\}/);
        if (m && m[0]) {
          try {
            parsed = JSON.parse(m[0]);
          } catch {
            parsed = null;
          }
        }
      }
    }

    if (!parsed) return fallback;

    const bullets = Array.isArray(parsed.bullets)
      ? parsed.bullets.filter((b: any) => typeof b === "string").slice(0, 5)
      : [];
    const sources = Array.isArray(parsed.sources)
      ? parsed.sources
          .map((s: any) => ({ title: String(s?.title || "Untitled"), url: String(s?.url || "") }))
          .filter((s: any) => s.url)
          .slice(0, 6)
      : [];
    const years = Array.isArray(parsed?.series?.years)
      ? parsed.series.years.map((n: any) => Number(n)).filter((n: any) => Number.isFinite(n))
      : [];
    const values = Array.isArray(parsed?.series?.values)
      ? parsed.series.values.map((n: any) => Number(n)).filter((n: any) => Number.isFinite(n))
      : [];

    const seriesOk = years.length === values.length && years.length >= 3;
    return {
      bullets: bullets.length ? bullets : fallback.bullets,
      sources: sources.length ? sources : fallback.sources,
      series: seriesOk ? { years, values } : fallback.series,
    };
  } catch {
    return fallback;
  }
}

/**
 * Generate a line chart image Buffer using QuickChart.
 * No API key required. Returns PNG bytes.
 */
export async function generateTrendChartImage(
  years: number[],
  values: number[],
  title: string,
  width = 1000,
  height = 600,
  lang?: 'en' | 'fr' | 'es',
  currency?: string
): Promise<Buffer> {
  const l = ((): 'en' | 'fr' | 'es' => {
    const s = String(lang || '').toLowerCase();
    return (s === 'fr' || s === 'es') ? (s as any) : 'en';
  })();
  const ccy = ((): string => {
    const c = String(currency || '').toUpperCase();
    return /^[A-Z]{3}$/.test(c) ? c : 'CAD';
  })();
  const labels = {
    en: (cc: string) => ({ y: `Value (${cc} Billions)`, x: 'Year' }),
    fr: (cc: string) => ({ y: `Valeur (milliards ${cc})`, x: 'Année' }),
    es: (cc: string) => ({ y: `Valor (miles de millones ${cc})`, x: 'Año' }),
  } as const;
  const lab = labels[l](ccy);
  const config = {
    type: "line",
    data: {
      labels: years,
      datasets: [
        {
          label: lab.y,
          data: values,
          fill: false,
          borderColor: "#E11D48",
          borderWidth: 3,
          pointBackgroundColor: "#E11D48",
          pointRadius: 3,
        },
      ],
    },
    options: {
      plugins: {
        legend: { display: false },
        title: { display: true, text: title },
      },
      scales: {
        y: { title: { display: true, text: lab.y } },
        x: { title: { display: true, text: lab.x } },
      },
    },
  };

  const url = `https://quickchart.io/chart?width=${width}&height=${height}&backgroundColor=white&devicePixelRatio=2&c=${encodeURIComponent(
    JSON.stringify(config)
  )}`;

  const maxAttempts = 3;
  let lastErr: any = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await axios.get<ArrayBuffer>(url, { responseType: "arraybuffer", timeout: 15000, headers: { Accept: "image/png,image/*" } });
      return Buffer.from(resp.data);
    } catch (e) {
      lastErr = e;
      const delayMs = attempt === 1 ? 250 : attempt === 2 ? 750 : 0;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  console.warn("generateTrendChartImage: failed after retries", lastErr);
  throw lastErr || new Error("QuickChart trend image fetch failed");
}

/**
 * Generate a bar chart image Buffer using QuickChart.
 * Used for North America highlights.
 */
export async function generateBarChartImage(
  years: number[],
  values: number[],
  title: string,
  width = 1000,
  height = 600,
  lang?: 'en' | 'fr' | 'es',
  currency?: string
): Promise<Buffer> {
  const l = ((): 'en' | 'fr' | 'es' => {
    const s = String(lang || '').toLowerCase();
    return (s === 'fr' || s === 'es') ? (s as any) : 'en';
  })();
  const ccy = ((): string => {
    const c = String(currency || '').toUpperCase();
    return /^[A-Z]{3}$/.test(c) ? c : 'CAD';
  })();
  const labels = {
    en: (cc: string) => ({ y: `Value (${cc} Billions)`, x: 'Year' }),
    fr: (cc: string) => ({ y: `Valeur (milliards ${cc})`, x: 'Année' }),
    es: (cc: string) => ({ y: `Valor (miles de millones ${cc})`, x: 'Año' }),
  } as const;
  const lab = labels[l](ccy);
  const config = {
    type: "bar",
    data: {
      labels: years,
      datasets: [
        {
          label: lab.y,
          data: values,
          backgroundColor: "#065F46",
          borderColor: "#064E3B",
          borderWidth: 1,
        },
      ],
    },
    options: {
      plugins: {
        legend: { display: false },
        title: { display: true, text: title },
      },
      scales: {
        y: { title: { display: true, text: lab.y }, beginAtZero: true },
        x: { title: { display: true, text: lab.x } },
      },
    },
  };

  const url = `https://quickchart.io/chart?width=${width}&height=${height}&backgroundColor=white&devicePixelRatio=2&c=${encodeURIComponent(
    JSON.stringify(config)
  )}`;

  const maxAttempts = 3;
  let lastErr: any = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await axios.get<ArrayBuffer>(url, { responseType: "arraybuffer", timeout: 15000, headers: { Accept: "image/png,image/*" } });
      return Buffer.from(resp.data);
    } catch (e) {
      lastErr = e;
      const delayMs = attempt === 1 ? 250 : attempt === 2 ? 750 : 0;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  console.warn("generateBarChartImage: failed after retries", lastErr);
  throw lastErr || new Error("QuickChart bar image fetch failed");
}

export async function fetchCanadaAndNorthAmericaIndicators(
  reportData: any
): Promise<{ industry: string; primaryRegion: string; primaryRegionIndicators: MarketIndicators; northAmerica: MarketIndicators }> {
  const { industry, keywords } = deriveIndustryFromReport(reportData);
  const primaryRegion = detectPrimaryRegion(reportData);
  const lang: 'en' | 'fr' | 'es' = ((): any => {
    const l = String(reportData?.language || '').toLowerCase();
    return (l === 'fr' || l === 'es') ? l : 'en';
  })();
  const [primaryRegionIndicators, northAmerica] = await Promise.all([
    fetchMarketIndicators(industry, primaryRegion, keywords, lang),
    fetchMarketIndicators(industry, "North America", keywords, lang),
  ]);
  return { industry, primaryRegion, primaryRegionIndicators, northAmerica };
}
