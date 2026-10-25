import { createHash, randomUUID } from "node:crypto";
import openai from "../utils/openaiClient.js";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses.js";

export const SALVAGE_DEFAULT_MODEL = "gpt-6-astra";
export const SALVAGE_DEADLINE_MS = 15 * 60 * 1000;
const MAX_CALLS = 12;
type SalvageResponseRequest = Omit<ResponseCreateParamsNonStreaming, "model"> & { max_tool_calls?: number };

// Operational receipts prevent duplicate work after a timeout or worker restart.
// Only the validated result and evidence provenance are retained from responses.
export interface SalvageProviderCall {
  id: string;
  stage: string;
  status: "reserved" | "complete" | "uncertain" | "rejected";
  failure?: string;
  result?: Record<string, unknown>;
  consultedUrls?: string[];
  searchPerformed?: boolean;
}
export interface SalvageResearchCheckpoint {
  schemaVersion: 1;
  runId: string;
  inputHash: string;
  startedAt: string;
  deadlineAt: string;
  calls: SalvageProviderCall[];
  stages: Record<string, unknown>;
  warnings: string[];
  result?: Record<string, unknown>;
}
export class SalvageResearchLimitError extends Error {}
export class SalvageModelAccessError extends Error {
  constructor() { super("Salvage assessment access is unavailable. Please contact support to check the service configuration before retrying."); }
}
const verifiedModelAccess = new Map<string, number>();

export async function ensureSalvageModelAccess(model: string, deadlineAt = Date.now() + 15_000): Promise<void> {
  const keyFingerprint = createHash("sha256").update(String(openai.apiKey || "configured-client")).digest("hex");
  const cacheKey = `${keyFingerprint}:${model}`;
  if ((verifiedModelAccess.get(cacheKey) || 0) > Date.now()) return;
  const timeout = Math.min(15_000, deadlineAt - Date.now());
  if (timeout <= 0) throw new SalvageResearchLimitError("The research deadline was reached before model access could be verified.");
  try {
    const result = await openai.models.retrieve(model, { timeout, maxRetries: 0, signal: AbortSignal.timeout(timeout) });
    if (result.id !== model && !(model === SALVAGE_DEFAULT_MODEL && result.id.startsWith(`${model}-`))) throw new SalvageModelAccessError();
    verifiedModelAccess.set(cacheKey, Date.now() + 15 * 60 * 1000);
  } catch { throw new SalvageModelAccessError(); }
}
export function clearSalvageModelAccessCache(): void { verifiedModelAccess.clear(); }

export function salvageModel(search = false): string {
  const model = String(process.env[search ? "OPENAI_SALVAGE_SEARCH_MODEL" : "OPENAI_SALVAGE_MODEL"] || SALVAGE_DEFAULT_MODEL).trim();
  // Keep the validated model family; never silently fall back to another workload.
  if (!/^gpt-6-astra(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) throw new SalvageModelAccessError();
  return model;
}
export function newSalvageResearchCheckpoint(inputHash: string): SalvageResearchCheckpoint {
  const startedAt = new Date();
  return { schemaVersion: 1, runId: randomUUID(), inputHash, startedAt: startedAt.toISOString(),
    deadlineAt: new Date(startedAt.getTime() + SALVAGE_DEADLINE_MS).toISOString(), calls: [], stages: {}, warnings: [] };
}

export class SalvageResearchExecution {
  constructor(public checkpoint: SalvageResearchCheckpoint, private persist: (value: SalvageResearchCheckpoint) => Promise<void>) {}
  async save(): Promise<void> { await this.persist(structuredClone(this.checkpoint)); }
  assertRemaining(): void {
    if (Date.now() >= Date.parse(this.checkpoint.deadlineAt)) throw new SalvageResearchLimitError("The 15-minute research deadline was reached; completed evidence is retained.");
    if (this.checkpoint.calls.some((c) => c.status === "reserved" || c.status === "uncertain")) {
      throw new SalvageResearchLimitError("A previous provider request has an uncertain outcome. Automatic research stopped to avoid duplicate work; completed evidence is retained.");
    }
  }
  async json(stage: string, request: SalvageResponseRequest, options: { search?: boolean; imageCount?: number } = {}): Promise<{ data: Record<string, unknown>; consultedUrls: string[]; searchPerformed: boolean }> {
    const completed = this.checkpoint.calls.find((c) => c.stage === stage && c.status === "complete");
    if (completed?.result) return { data: completed.result, consultedUrls: completed.consultedUrls || [], searchPerformed: completed.searchPerformed === true };
    if (completed) throw new SalvageResearchLimitError(`The saved ${stage} response could not be validated; it will not be requested again automatically.`);
    this.assertRemaining();
    if (this.checkpoint.calls.length >= MAX_CALLS) throw new SalvageResearchLimitError("The research call limit was reached.");
    const textBytes = Buffer.byteLength(JSON.stringify(request).replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g, "[image]"));
    if (textBytes > 180_000) throw new SalvageResearchLimitError("Research context exceeded the bounded request size.");
    if ((options.imageCount || 0) > 10) throw new SalvageResearchLimitError("Research image batch exceeded ten photos.");
    const model = salvageModel(options.search);
    await ensureSalvageModelAccess(model, Date.parse(this.checkpoint.deadlineAt));
    const call: SalvageProviderCall = { id: randomUUID(), stage, status: "reserved" };
    this.checkpoint.calls.push(call);
    await this.save();
    let response: Awaited<ReturnType<typeof openai.responses.create>>;
    try {
      const timeout = Math.min(180_000, Date.parse(this.checkpoint.deadlineAt) - Date.now());
      if (timeout <= 0) throw new SalvageResearchLimitError("The research deadline was reached.");
      const boundedRequest: ResponseCreateParamsNonStreaming & { max_tool_calls?: number } = { ...request, model, store: false, service_tier: "default", stream: false,
        max_output_tokens: Math.min(12_000, Math.max(1, request.max_output_tokens || 4_000)),
        ...(request.max_tool_calls ? { max_tool_calls: Math.min(4, Math.max(1, request.max_tool_calls)) } : {}),
      };
      response = await openai.responses.create(boundedRequest, { maxRetries: 0, timeout, signal: AbortSignal.timeout(timeout) });
    } catch (error) {
      const status = Number((error as { status?: number })?.status);
      call.status = [400, 401, 403, 404, 422, 429].includes(status) ? "rejected" : "uncertain";
      call.failure = [401, 403, 404].includes(status) ? "model_access" : call.status === "uncertain" ? "response_unknown" : "provider_rejected";
      await this.save();
      if ([401, 403, 404].includes(status)) throw new SalvageModelAccessError();
      throw new SalvageResearchLimitError(call.status === "uncertain" ? "Provider response was not received; automatic retries stopped because the outcome is uncertain." : "The provider rejected this research request; no fallback model was used.");
    }
    const result = response as unknown as Record<string, any>;
    const output: Record<string, any>[] = Array.isArray(result.output) ? result.output : [];
    call.searchPerformed = output.some((item) => item.type === "web_search_call" && item.action?.type === "search");
    const consulted = new Set<string>();
    for (const item of output) {
      if (item.type === "web_search_call") for (const source of item.action?.sources || []) if (typeof source.url === "string") consulted.add(source.url);
      if (item.type === "message") for (const part of item.content || []) for (const annotation of part.annotations || []) {
        if (annotation.type === "url_citation" && typeof annotation.url === "string") consulted.add(annotation.url);
      }
    }
    call.consultedUrls = [...consulted];
    call.status = "complete";
    try {
      if (result.status !== "completed") throw new Error("Incomplete provider response.");
      const parsed = JSON.parse(result.output_text || "");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid object.");
      call.result = parsed;
    } catch { call.failure = "invalid_structured_response"; }
    await this.save();
    if (!call.result) throw new SalvageResearchLimitError(`The ${stage} response was incomplete or invalid; no replacement facts were invented.`);
    return { data: call.result, consultedUrls: call.consultedUrls, searchPerformed: call.searchPerformed };
  }
}
