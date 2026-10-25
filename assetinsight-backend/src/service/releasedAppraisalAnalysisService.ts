import openai from "../utils/openaiClient.js";
import type { IReportJob } from "../models/reportJob.model.js";
import ReleasedAppraisalAnalysis from "../models/releasedAppraisalAnalysis.model.js";
import { getReportLots } from "../utils/reportArtifactNames.js";
import {
  buildReleasedAppraisalFingerprint,
  buildReleasedArtifactManifest,
  buildReleasedInsights,
  buildReleasedQuality,
  getReleasedAssetReport,
  loadLegacyArtifactMap,
} from "./releasedAppraisalService.js";

const ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["observations", "comparableRanges", "confidence", "cautions", "sources"],
  properties: {
    observations: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "detail", "impact"],
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
          impact: { type: "string", enum: ["positive", "neutral", "caution"] },
        },
      },
    },
    comparableRanges: {
      type: "array",
      maxItems: 10,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["asset", "low", "high", "currency", "basis", "confidence"],
        properties: {
          asset: { type: "string" },
          low: { type: "number" },
          high: { type: "number" },
          currency: { type: "string" },
          basis: { type: "string" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
    },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    cautions: { type: "array", maxItems: 10, items: { type: "string" } },
    sources: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "url"],
        properties: {
          title: { type: "string" },
          url: { type: "string" },
        },
      },
    },
  },
} as const;

function parseOutput(response: any): Record<string, unknown> {
  const text = String(response?.output_text || "").trim();
  if (!text) throw new Error("Market analysis returned an empty response.");
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("Market analysis returned invalid structured data.");
  }
}

async function requestAnalysis(input: string, model: string) {
  const request: any = {
    model,
    reasoning: { effort: "low" },
    input,
    text: {
      format: {
        type: "json_schema",
        name: "released_appraisal_market_analysis",
        strict: true,
        schema: ANALYSIS_SCHEMA,
      },
    },
  };

  try {
    return await openai.responses.create({
      ...request,
      tools: [
        {
          type: "web_search",
          external_web_access: true,
          search_context_size: "high",
        },
      ],
      tool_choice: "required",
    } as any);
  } catch (error: any) {
    const message = String(error?.message || "");
    if (!/web_search|external_web_access|unsupported|unknown parameter/i.test(message)) {
      throw error;
    }
    return openai.responses.create({
      ...request,
      tools: [{ type: "web_search_preview", search_context_size: "high" }],
      tool_choice: "required",
    } as any);
  }
}

/**
 * Runs advisory market research without mutating the released report. The
 * durable cache row owns analysis state; ReportJob only owns retry/lease state.
 */
export async function runReleasedAppraisalAnalysisJob(job: IReportJob) {
  const reportId = String(job.payload?.reportId || job.reportId || "");
  const fingerprint = String(job.payload?.fingerprint || "");
  if (!reportId || !fingerprint) {
    throw new Error("Released appraisal analysis job is missing report identity.");
  }

  const cache = await ReleasedAppraisalAnalysis.findOne({ reportId, fingerprint });
  if (!cache) throw new Error("Released appraisal analysis cache row was not found.");

  cache.status = "processing";
  cache.startedAt = cache.startedAt || new Date();
  cache.error = null;
  await cache.save();

  try {
    const report = await getReleasedAssetReport(reportId);
    if (!report) throw new Error("Released Asset appraisal was not found.");
    const legacyMap = await loadLegacyArtifactMap([reportId]);
    const artifacts = buildReleasedArtifactManifest(report, legacyMap.get(reportId) || []);
    const quality = buildReleasedQuality(report, artifacts);
    const currentFingerprint = buildReleasedAppraisalFingerprint(report, quality);
    if (currentFingerprint !== fingerprint) {
      throw new Error("The report changed before analysis started. Refresh the analysis.");
    }
    const insights = buildReleasedInsights(report, quality);
    // Released reports span current and legacy storage shapes. Use the shared
    // resolver so advisory analysis is grounded in the same lots as downloads
    // and deterministic QA, including reports backed by preview_data.lots.
    const lots = getReportLots(report);
    const conciseLots = lots.slice(0, 120).map((lot: any, index: number) => ({
      lot: lot?.lot_number ?? lot?.lot_id ?? index + 1,
      title: lot?.title,
      description: lot?.description,
      category: lot?.categories || lot?.category,
      estimatedValue: lot?.estimated_value,
      serial: lot?.serial_number || lot?.serial_no_or_label,
    }));
    const model =
      process.env.RELEASED_APPRAISAL_ANALYSIS_MODEL ||
      process.env.OPENAI_MODEL_TEXT ||
      "gpt-5.6-terra";
    cache.modelName = model;
    await cache.save();

    const prompt = [
      "You are an advisory equipment-appraisal research assistant.",
      "Research current public equipment comparables and market signals using web search.",
      "Do not change any valuation, approval, or report content. State uncertainty clearly.",
      "Return only the required strict JSON. Source URLs must be public pages actually used.",
      `Report summary: ${JSON.stringify(insights)}`,
      `Deterministic quality findings: ${JSON.stringify(quality.findings.slice(0, 60))}`,
      `Released lots (${lots.length} total; first ${conciseLots.length} supplied): ${JSON.stringify(conciseLots)}`,
    ].join("\n\n");

    const response = await requestAnalysis(prompt, model);
    cache.result = parseOutput(response);
    cache.status = "completed";
    cache.completedAt = new Date();
    cache.error = null;
    await cache.save();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    cache.status = job.attempts < job.maxAttempts ? "queued" : "failed";
    cache.error = message;
    if (cache.status === "failed") cache.completedAt = new Date();
    await cache.save();
    throw error;
  }
}
