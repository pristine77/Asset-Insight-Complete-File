/**
 * Thin reliability and error-translation boundary for Auctionsoft's internal API.
 * Configuration aliases keep existing deployments compatible, requests are aborted at
 * a fixed deadline, and upstream failures are mapped to gateway/service errors so API
 * callers never depend on provider-specific response bodies.
 */
type AuctionManagementStatus = "incoming" | "in_progress" | "completed";

const INTEGRATION_PATH = "/api/integrations/auction-management";

export class AuctionsoftClientError extends Error {
  statusCode: number;
  upstreamStatus?: number;
  code: string;

  constructor(message: string, statusCode: number, code: string, upstreamStatus?: number) {
    super(message);
    this.name = "AuctionsoftClientError";
    this.statusCode = statusCode;
    this.upstreamStatus = upstreamStatus;
    this.code = code;
  }
}

function getConfig() {
  const baseUrl = (
    process.env.AUCTIONSOFT_INTERNAL_API_BASE_URL ||
    process.env.AUCTIONSOFT_API_BASE_URL ||
    ""
  ).replace(/\/+$/, "");
  const apiKey = process.env.AUCTIONSOFT_API_KEY || process.env.AUCTION_MANAGEMENT_API_KEY || "";
  if (!baseUrl) {
    throw new AuctionsoftClientError("AUCTIONSOFT_API_BASE_URL is not configured", 503, "not_configured");
  }
  if (!apiKey) {
    throw new AuctionsoftClientError("AUCTIONSOFT_API_KEY is not configured", 503, "not_configured");
  }
  return { baseUrl, apiKey };
}

export function getAuctionsoftConfigStatus() {
  const baseUrl = (
    process.env.AUCTIONSOFT_INTERNAL_API_BASE_URL ||
    process.env.AUCTIONSOFT_API_BASE_URL ||
    ""
  ).replace(/\/+$/, "");
  return {
    configured: Boolean(baseUrl && (process.env.AUCTIONSOFT_API_KEY || process.env.AUCTION_MANAGEMENT_API_KEY)),
    baseUrl: baseUrl || null,
    usingInternalBaseUrl: Boolean(process.env.AUCTIONSOFT_INTERNAL_API_BASE_URL),
    apiKeyConfigured: Boolean(process.env.AUCTIONSOFT_API_KEY || process.env.AUCTION_MANAGEMENT_API_KEY),
  };
}

function buildAuctionsoftUrl(baseUrl: string, path: string) {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const integrationIndex = normalizedBase.indexOf(INTEGRATION_PATH);
  if (integrationIndex !== -1) {
    return `${normalizedBase.slice(0, integrationIndex + INTEGRATION_PATH.length)}${path}`;
  }
  if (normalizedBase.endsWith("/api")) {
    return `${normalizedBase}/integrations/auction-management${path}`;
  }
  return `${normalizedBase}${INTEGRATION_PATH}${path}`;
}

async function readError(response: Response) {
  const text = await response.text().catch(() => "");
  if (!text) return response.statusText || `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message || parsed?.message || text;
  } catch {
    return text;
  }
}

function mapUpstreamStatus(status: number) {
  if (status === 503) return 503;
  return 502;
}

export async function auctionsoftRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { baseUrl, apiKey } = getConfig();
  const url = buildAuctionsoftUrl(baseUrl, path);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AUCTIONSOFT_API_TIMEOUT_MS || 15000));

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
        ...(init.headers || {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AuctionsoftClientError(
      `Could not reach Auctionsoft at ${url}: ${message}`,
      502,
      "auctionsoft_unreachable",
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const upstreamMessage = await readError(response);
    throw new AuctionsoftClientError(
      `Auctionsoft request failed (${response.status}) at ${url}: ${upstreamMessage}`,
      mapUpstreamStatus(response.status),
      "auctionsoft_upstream_error",
      response.status,
    );
  }
  return response.json() as Promise<T>;
}

export function listAuctionManagementTasks(status: AuctionManagementStatus) {
  return auctionsoftRequest<{ data: any[] }>(`/tasks?status=${encodeURIComponent(status)}`);
}

export function getAuctionManagementTask(taskId: string) {
  return auctionsoftRequest<{ data: any }>(`/tasks/${encodeURIComponent(taskId)}`);
}

export function markAuctionManagementTaskOpened(taskId: string) {
  return auctionsoftRequest<{ data: any }>(`/tasks/${encodeURIComponent(taskId)}/opened`, {
    method: "POST",
    body: "{}",
  });
}

export function pushAuctionManagementResult(taskId: string, payload: Record<string, any>) {
  return auctionsoftRequest<{ success: boolean; processedLots: string[] }>(
    `/tasks/${encodeURIComponent(taskId)}/result`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}
