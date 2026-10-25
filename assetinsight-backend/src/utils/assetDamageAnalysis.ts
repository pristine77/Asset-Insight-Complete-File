import {
  enforceLotDamageAnalysisPolicy,
  isLotRecordDamageAnalysisEligible,
} from "./lotDamagePolicy.js";

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function normalizeDamageText(value: unknown): string {
  return typeof value === "string"
    ? value
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t\f\v]+/g, " ")
        .replace(/[ \t]*\n[ \t]*/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
    : "";
}

const OPERATIONAL_DAMAGE_FALLBACK_PATTERNS = [
  /\bsoftware analysis failed\b/i,
  /\bsoftware did not return details\b/i,
  /\bai analysis failed\b/i,
  /\bopenai.+failed\b/i,
  /\breview and edit before approval\b/i,
];

export function isOperationalDamageAnalysisFallback(value: unknown): boolean {
  const text = normalizeText(value);
  return Boolean(text && OPERATIONAL_DAMAGE_FALLBACK_PATTERNS.some((pattern) => pattern.test(text)));
}

export function sanitizeDamageAnalysisText(value: unknown): string {
  const text = normalizeDamageText(value);
  if (!text || isOperationalDamageAnalysisFallback(text)) return "";
  return text;
}

export const DAMAGE_ANALYSIS_LABEL = "Damages";

const DAMAGE_LABEL_PATTERNS = [
  /Paint\s+Scratches\s+(?:&|and)\s+Chips/i,
  /Rust\s*\/\s*Corrosion/i,
  /Body\s+Dents/i,
  /Bed\s+Wear/i,
  /Interior\s+Soiling/i,
  /Cracks\s*\/\s*Breakage/i,
  /Water\s*\/\s*Stain\s+Damage/i,
  /Missing\s+Parts/i,
  /Tire\s*\/\s*Track\s+Wear/i,
  /Glass\s*\/\s*Light\s+Damage/i,
  /Front\s+End\s+Damage/i,
  /Rear\s+End\s+Damage/i,
  /Side\s+Damage/i,
  /Frame\s+Damage/i,
  /Undercarriage\s+Damage/i,
  /Mechanical\s+Damage/i,
  /Electrical\s+Damage/i,
  /Leaks?\s*\/\s*Fluid\s+Stains?/i,
  /General\s+Visible\s+Damage/i,
  /General\s+Visible\s+Wear/i,
  /No\s+Major\s+Visible\s+Damage/i,
  /No\s+Damage\s+Notes\s+Available/i,
];

function escapeRegExpPatternSource(source: string): string {
  return source.replace(/^\//, "").replace(/\/[a-z]*$/i, "");
}

function decodeBasicHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function titleCaseDamageLine(value: string): string {
  const preservedTokens = new Map<string, string>();
  let preservedIndex = 0;
  const withPlaceholders = value.replace(/\b[A-Z][A-Z0-9/-]{1,7}\b/g, (token) => {
    const placeholder = `zzpreserved${preservedIndex++}zz`;
    preservedTokens.set(placeholder, token);
    return placeholder;
  });
  const lower = withPlaceholders
    .replace(/\s*&\s*/g, " And ")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const titled = lower
    .replace(/\b([a-z])/g, (match) => match.toUpperCase())
    .replace(/\bVin\b/g, "VIN")
    .replace(/\bSn\b/g, "SN")
    .replace(/\bId\b/g, "ID")
    .replace(/\bSuv\b/g, "SUV")
    .replace(/\bAtv\b/g, "ATV")
    .replace(/\bUtv\b/g, "UTV")
    .replace(/\bAc\b/g, "AC")
    .replace(/\bLed\b/g, "LED")
    .replace(/\bOem\b/g, "OEM")
    .replace(/\bRpm\b/g, "RPM")
    .replace(/\bPsi\b/g, "PSI")
    .replace(/\bHp\b/g, "HP")
    .replace(/\bKw\b/g, "kW")
    .replace(/\bKg\b/g, "kg")
    .replace(/\bKm\b/g, "km")
    .replace(/\bMi\b/g, "mi")
    .replace(/\bLbs?\b/g, (unit) => unit.toLowerCase())
    .replace(/\b4x4\b/gi, "4x4");
  return Array.from(preservedTokens.entries()).reduce(
    (text, [placeholder, token]) => text.split(titleCasePlaceholder(placeholder)).join(token),
    titled
  );
}

function titleCasePlaceholder(value: string): string {
  return value.replace(/\b([a-z])/g, (match) => match.toUpperCase());
}

function stripDamageSectionHeading(value: string): string {
  const text = value.trim();
  if (/^(?:damage\s+analysis|damages?)\s*$/i.test(text)) return "";
  return text.replace(/^(?:damage\s+analysis|damages?)\s*:\s*/i, "");
}

export function formatDamageAnalysisLines(value: unknown): string[] {
  let text = sanitizeDamageAnalysisText(value);
  if (!text) return [];

  text = decodeBasicHtmlEntities(text)
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/p\s*>\s*<\s*p[^>]*>/gi, "\n")
    .replace(/<\s*\/?p[^>]*>/gi, "\n")
    .replace(/<\s*hr\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .trim();

  for (const pattern of DAMAGE_LABEL_PATTERNS) {
    const source = escapeRegExpPatternSource(String(pattern));
    text = text.replace(new RegExp(`(\\s+)(${source}\\s*-)`, "gi"), "\n$2");
  }

  text = text.replace(/[\u2022\u25cf]/g, "\n");

  return Array.from(
    new Set(
      text
        .split(/\n+/g)
        .map((line) =>
          stripDamageSectionHeading(line.replace(/^\s*[-*]+\s*/, ""))
        )
        .filter(Boolean)
        .map(titleCaseDamageLine)
    )
  );
}

export function formatDamageAnalysisDisplayText(value: unknown): string {
  return formatDamageAnalysisLines(value).join("\n");
}

const DAMAGE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  {
    label: "Paint Scratches & Chips - visible cosmetic paint loss, scuffing, or edge wear",
    pattern: /\b(scratches?|scuffs?|chips?|paint loss|faded|cosmetic wear|wear)\b/i,
  },
  {
    label: "Body Dents - visible denting, bending, deformation, or warped panels",
    pattern: /\b(dents?|bent|deformed?|warped)\b/i,
  },
  {
    label: "Rust / Corrosion - visible surface rust, corrosion, or oxidation on exposed metal",
    pattern: /\b(rust|corrosion|oxidation)\b/i,
  },
  {
    label: "Cracks / Breakage - visible cracking, splitting, tearing, or broken material",
    pattern: /\b(crack(?:ed|s)?|fracture|broken|breakage|split|tear(?:s|ing)?)\b/i,
  },
  {
    label: "Water / Stain Damage - visible staining, moisture marks, or mildew-like discoloration",
    pattern: /\b(stain(?:ed|ing)?|water damage|moisture|mildew)\b/i,
  },
  {
    label: "Missing Parts - visibly incomplete or removed components",
    pattern: /\b(missing|incomplete|absent|removed parts?)\b/i,
  },
  {
    label: "Tire / Track Wear - visible tread, sidewall, or track wear",
    pattern: /\b(tire wear|worn tires?|track wear|worn tracks?)\b/i,
  },
  {
    label: "Glass / Light Damage - visible cracked glass, broken lens, or damaged light assembly",
    pattern: /\b(broken glass|cracked glass|damaged lens|broken light|light damage)\b/i,
  },
];

function uniqueLabelsFromText(input: string): string[] {
  const labels: string[] = [];
  for (const entry of DAMAGE_PATTERNS) {
    if (entry.pattern.test(input)) labels.push(entry.label);
  }
  return Array.from(new Set(labels));
}

function formatDamageBlock(labels: string[]): string {
  const cleaned = Array.from(
    new Set(labels.map((label) => normalizeText(label)).filter(Boolean))
  );
  if (cleaned.length === 0) return "";
  return formatDamageAnalysisDisplayText(cleaned.join("\n"));
}

export function deriveLotDamageAnalysis(
  lot: Record<string, any> | null | undefined,
  includeDamageAnalysis: boolean = true
): string | null {
  if (!includeDamageAnalysis || !isLotRecordDamageAnalysisEligible(lot)) return null;

  const explicit = formatDamageAnalysisDisplayText(lot?.damage_analysis);
  if (explicit) return explicit;

  const condition = normalizeText(lot?.condition);
  const details = normalizeText(lot?.details);
  const description = normalizeText(lot?.description);
  const combined = [condition, details, description].filter(Boolean).join(" ");
  const labels = uniqueLabelsFromText(combined);

  if (labels.length > 0) {
    return formatDamageBlock(labels.slice(0, 4));
  }

  if (/\b(damaged?|salvage|non[- ]running|inoperable)\b/i.test(combined)) {
    return formatDamageBlock(["General Visible Damage - item appears visibly damaged, but exact damage type is not clear from the image"]);
  }

  if (/\b(new|unused|like new)\b/i.test(combined)) {
    return formatDamageBlock(["No Major Visible Damage - no notable exterior damage is apparent from provided images"]);
  }

  return formatDamageBlock(["General Visible Wear - typical use-related exterior wear visible or condition not fully verifiable from images"]);
}

export function applyDamageAnalysisToLots<T extends Record<string, any>>(
  lots: T[] | null | undefined,
  includeDamageAnalysis: boolean = true
): T[] {
  if (!Array.isArray(lots)) return [];
  return lots.map((lot, index) =>
    enforceLotDamageAnalysisPolicy(
      {
        ...lot,
        damage_analysis: deriveLotDamageAnalysis(lot, includeDamageAnalysis),
      },
      { includeDamageAnalysis, fallbackLotNumber: index + 1 }
    )
  );
}

export function buildReportDamageAnalysis(
  lots: Array<Record<string, any>> | null | undefined,
  includeDamageAnalysis: boolean = true
): string | undefined {
  if (!includeDamageAnalysis) return undefined;
  const eligibleLots = Array.isArray(lots)
    ? lots.filter((lot, index) => isLotRecordDamageAnalysisEligible(lot, index + 1))
    : [];
  if (eligibleLots.length === 0) return undefined;

  const aggregatedLabels = Array.from(
    new Set(
      eligibleLots.flatMap((lot) =>
        uniqueLabelsFromText(
          [
            sanitizeDamageAnalysisText(lot?.damage_analysis),
            normalizeText(lot?.details),
            normalizeText(lot?.description),
            normalizeText(lot?.condition),
          ]
            .filter(Boolean)
            .join(" ")
        )
      )
    )
  );

  if (aggregatedLabels.length === 0) {
    return formatDamageBlock(["General Visible Wear - typical use-related exterior wear visible or condition not fully verifiable from images"]);
  }

  return formatDamageBlock(aggregatedLabels.slice(0, 5));
}

/**
 * Keeps a report-level summary only when every lot is eligible. Once a report
 * contains an ineligible lot, the summary is rebuilt from eligible lots so a
 * previously cached aggregate cannot leak that lot's observations.
 */
export function buildPolicySafeReportDamageAnalysis(
  lots: Array<Record<string, any>> | null | undefined,
  reportLevelDamageAnalysis: unknown,
  includeDamageAnalysis: boolean = true
): string | undefined {
  if (!includeDamageAnalysis || !Array.isArray(lots) || lots.length === 0) {
    return undefined;
  }
  const eligibleLotCount = lots.filter((lot, index) =>
    isLotRecordDamageAnalysisEligible(lot, index + 1)
  ).length;
  if (eligibleLotCount === 0) return undefined;
  if (eligibleLotCount === lots.length) {
    const explicit = formatDamageAnalysisDisplayText(reportLevelDamageAnalysis);
    if (explicit) return explicit;
  }
  return buildReportDamageAnalysis(lots, true);
}
