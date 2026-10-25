import {
  AlignmentType,
  HeadingLevel,
  ImageRun,
  Paragraph,
  TextRun,
} from "docx";
import { goldDivider, formatMonthYear } from "./utils.js";
import {
  fetchCanadaAndNorthAmericaIndicators,
  generateTrendChartImage,
  generateBarChartImage,
} from "../../marketIntelService.js";
import { getLang, t } from "./i18n.js";
import sharp from "sharp";

/**
 * Adds optional market intelligence as a non-critical report phase. External
 * data/chart failures are swallowed so core appraisal generation remains available:
 * early failures yield no block, while later failures may retain content already
 * built. Successful output keeps narrative, charts, then deduplicated sources.
 */
export async function buildMarketOverview(
  reportData: any,
  options?: {
    pageBreakBefore?: boolean;
    monochrome?: boolean;
    compact?: boolean;
  }
): Promise<Paragraph[]> {
  const children: Paragraph[] = [];
  const lang = getLang(reportData);
  const tr = t(lang);
  const ccy = String((reportData as any)?.currency || 'CAD');
  const pageBreakBefore = options?.pageBreakBefore !== false;
  const compact = options?.compact === true;
  // Grayscale conversion occurs after chart rendering so data and labels remain
  // identical between branded and monochrome report variants.
  const prepareChart = async (data: Buffer): Promise<Buffer> =>
    options?.monochrome
      ? sharp(data).grayscale().png().toBuffer()
      : data;
  try {
    const { industry, primaryRegion, primaryRegionIndicators, northAmerica } =
      await fetchCanadaAndNorthAmericaIndicators(reportData);

    children.push(
      new Paragraph({
        text: tr.marketOverview,
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore,
        alignment: AlignmentType.CENTER,
        spacing: { before: 260, after: compact ? 80 : 160 },
      })
    );

    if (Array.isArray(primaryRegionIndicators?.bullets) && primaryRegionIndicators.bullets.length) {
      children.push(
        new Paragraph({
          text: `${primaryRegion} Highlights`,
          heading: HeadingLevel.HEADING_2,
          spacing: { after: 100 },
        })
      );
      for (const b of primaryRegionIndicators.bullets) {
        children.push(
          new Paragraph({
            text: String(b),
            style: "BodyLarge",
            bullet: { level: 0 },
            spacing: { after: compact ? 20 : 40 },
          })
        );
      }
    }

    const caChart = await prepareChart(await generateTrendChartImage(
      primaryRegionIndicators.series.years,
      primaryRegionIndicators.series.values,
      `${industry} – ${primaryRegion} (5-Year Trend)`,
      1000,
      600,
      lang,
      ccy
    ));
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: compact ? 80 : 160 },
        children: [
          new ImageRun({
            data: caChart as any,
            transformation: { width: 640, height: 384 },
          } as any),
        ],
      })
    );

    // North America Highlights
    if (Array.isArray(northAmerica?.bullets) && northAmerica.bullets.length) {
      children.push(
        new Paragraph({
          text: tr.northAmericaHighlights,
          heading: HeadingLevel.HEADING_2,
          spacing: { after: 100 },
        })
      );
      for (const b of northAmerica.bullets) {
        children.push(
          new Paragraph({
            text: String(b),
            style: "BodyLarge",
            bullet: { level: 0 },
            spacing: { after: compact ? 20 : 40 },
          })
        );
      }
    }

    const naChart = await prepareChart(await generateBarChartImage(
      northAmerica.series.years,
      northAmerica.series.values,
      `${industry} – North America (5-Year Trend)`,
      1000,
      600,
      lang,
      ccy
    ));
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: compact ? 80 : 160 },
        children: [
          new ImageRun({
            data: naChart as any,
            transformation: { width: 640, height: 384 },
          } as any),
        ],
      })
    );

    const combined = [
      ...(Array.isArray(primaryRegionIndicators?.sources) ? primaryRegionIndicators.sources : []),
      ...(Array.isArray(northAmerica?.sources) ? northAmerica.sources : []),
    ];
    const seen = new Set<string>();
    // URL is the citation identity. Preserve first occurrence so the regional
    // source remains ahead of an equivalent North American reference.
    const uniqueRefs = combined.filter((s) => {
      const key = (s?.url || "").trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (uniqueRefs.length) {
      children.push(
        new Paragraph({
          text: tr.references,
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 80, after: 120 },
        })
      );
      children.push(
        goldDivider(options?.monochrome ? "111111" : "DC2626", compact)
      );
      for (const s of uniqueRefs) {
        children.push(
          new Paragraph({
            text: `${s.title} — ${s.url}`,
            style: "BodyLarge",
            bullet: { level: 0 },
            spacing: { after: compact ? 20 : 40 },
          })
        );
      }
    }
  } catch {
    // Market context is enrichment, not part of the core valuation contract.
  }

  return children;
}
