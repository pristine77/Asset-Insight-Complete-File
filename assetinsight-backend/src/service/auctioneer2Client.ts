/**
 * Provider boundary for Auctioneer2 HTTP operations. It validates deployment
 * configuration, enforces request deadlines, accepts documented response-envelope
 * variants, and translates upstream errors into stable application codes used by
 * controllers and durable delivery jobs.
 */
import { createHash } from "node:crypto";
import { auctioneerYoutubeUrl } from "./auctioneer2VideoPolicy.js";

export type Auctioneer2Record = Record<string, unknown>;

export type Auctioneer2Photo = {
  buffer: Buffer;
  filename: string;
  contentType: string;
  order?: number;
};

export const AUCTIONEER2_PHOTO_MAX_FILES_PER_REQUEST = 5;
export const AUCTIONEER2_PHOTO_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const AUCTIONEER2_PHOTO_MAX_BATCH_BYTES = 35 * 1024 * 1024;

export const AUCTIONEER_REOPEN_ERRORS: Record<string, string> = {
  LOTS_CLOSING_STARTED: "Lots have started closing for this event. This contract can no longer be reopened.",
  EVENT_CLOSED: "The auction event is closed or cancelled. This contract cannot be reopened.",
  PROPOSAL_REVIEWED: "The proposal has already been reviewed. Ask the auction team to review this contract before adding more lots.",
  REVOKED: "Your assignment to this contract has been revoked. Contact the auction team.",
  NO_GRANT: "You are no longer assigned to capture lots for this contract. Contact the auction team.",
  AMBIGUOUS_REOPEN_USER: "Auctioneer could not confirm your assignment. Ask the auction team to check the contract's Asset Insight users.",
};

const AUCTIONEER2_PHOTO_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

export class Auctioneer2ClientError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly upstreamStatus?: number;
  readonly ambiguousWrite: boolean;

  constructor(
    message: string,
    options: {
      statusCode: number;
      code: string;
      upstreamStatus?: number;
      ambiguousWrite?: boolean;
    }
  ) {
    super(message);
    this.name = "Auctioneer2ClientError";
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.upstreamStatus = options.upstreamStatus;
    this.ambiguousWrite = Boolean(options.ambiguousWrite);
  }
}

type Auctioneer2Config = {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
};

function configuredBaseUrl(): string {
  return String(
    process.env.AUCTIONEER2_API_BASE_URL ||
      process.env.AUCTIONEER2_BASE_URL ||
      ""
  )
    .trim()
    .replace(/\/+$/, "");
}

function isValidConfiguredBaseUrl(baseUrl: string): boolean {
  if (!baseUrl) return false;
  try {
    const parsed = new URL(baseUrl);
    return (
      parsed.protocol === "https:" &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash &&
      parsed.pathname.replace(/\/+$/, "") === "/api/external"
    );
  } catch {
    return false;
  }
}

function integrationEnabled(): boolean {
  return String(
      process.env.AUCTIONEER2_FEATURE_ENABLED ??
      process.env.AUCTIONEER2_ENABLED ??
      "false"
  )
    .trim()
    .toLowerCase() !== "false";
}

function getConfig(): Auctioneer2Config {
  const baseUrl = configuredBaseUrl();
  const apiKey = String(process.env.AUCTIONEER2_API_KEY || "").trim();
  if (!baseUrl || !apiKey) {
    throw new Auctioneer2ClientError("Auctioneer 2.0 is not configured.", {
      statusCode: 503,
      code: "auctioneer2_not_configured",
    });
  }
  if (!isValidConfiguredBaseUrl(baseUrl)) {
    throw new Auctioneer2ClientError(
      "Auctioneer 2.0 has an invalid server configuration.",
      {
        statusCode: 503,
        code: "auctioneer2_invalid_configuration",
      }
    );
  }
  if (!integrationEnabled()) {
    throw new Auctioneer2ClientError("Auctioneer 2.0 is disabled.", {
      statusCode: 503,
      code: "auctioneer2_disabled",
    });
  }
  const parsedTimeout = Number.parseInt(
    String(
      process.env.AUCTIONEER2_API_TIMEOUT_MS ||
        process.env.AUCTIONEER2_TIMEOUT_MS ||
        "15000"
    ),
    10
  );
  return {
    baseUrl,
    apiKey,
    timeoutMs: Number.isFinite(parsedTimeout)
      ? Math.max(1_000, Math.min(parsedTimeout, 120_000))
      : 15_000,
  };
}

export function getAuctioneer2ConfigStatus() {
  const baseUrl = configuredBaseUrl();
  return {
    enabled: integrationEnabled(),
    configured: Boolean(
      isValidConfiguredBaseUrl(baseUrl) &&
        String(process.env.AUCTIONEER2_API_KEY || "").trim()
    ),
    baseUrl: baseUrl || null,
    apiKeyConfigured: Boolean(String(process.env.AUCTIONEER2_API_KEY || "").trim()),
  };
}

function buildUrl(baseUrl: string, path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl}${normalizedPath}`;
}

function isRecord(value: unknown): value is Auctioneer2Record {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function mapUpstreamStatus(status: number): number {
  if (status === 429 || status === 503) return 503;
  if (status === 504) return 504;
  return 502;
}

/** Only documented validation meanings cross the provider trust boundary. */
function safeUpstreamValidation(
  status: number,
  responseText: string,
  apiKey: string
): Auctioneer2ClientError | undefined {
  if (responseText.length > 8_192) return undefined;
  let body: unknown = responseText.trim();
  try {
    body = JSON.parse(responseText.replace(/^\uFEFF/, ""));
  } catch {
    // Some deployments return a plain-text validation sentence. The same exact
    // allowlist below applies; HTML and arbitrary diagnostics remain private.
  }

  const codes = new Set<string>();
  const messages: string[] = [];
  const collect = (value: unknown, depth: number): void => {
    if (depth > 3) return;
    if (typeof value === "string") {
      const text = value.trim();
      if (/^[A-Z][A-Z0-9_]{0,63}$/.test(text)) codes.add(text);
      if (text.length <= 300) messages.push(text);
      return;
    }
    if (!isRecord(value)) return;
    if (typeof value.code === "string" && value.code.length <= 64) {
      codes.add(value.code.trim());
    }
    if (typeof value.message === "string") collect(value.message, depth + 1);
    // Known envelope fields only, never stack/details/customer/request payloads.
    collect(value.error, depth + 1);
    collect(value.data, depth + 1);
  };
  collect(body, 0);

  if (status === 409) {
    const refusal = [...codes].find(code => Object.prototype.hasOwnProperty.call(AUCTIONEER_REOPEN_ERRORS, code));
    if (refusal) return new Auctioneer2ClientError(AUCTIONEER_REOPEN_ERRORS[refusal],
      { statusCode: 409, code: refusal, upstreamStatus: status });
  }

  const lotConflict = messages
    .map(message =>
      /^Lot number ([0-9][A-Za-z0-9,._/-]{0,39}) is already assigned within (?:this|the|the same) (?:auction )?event\.?$/.exec(message)
    )
    .find(match =>
      match && !match[1].toLowerCase().includes(apiKey.toLowerCase())
    );
  if (
    status === 409 &&
    (codes.has("LOT_NUMBER_CONFLICT") || (codes.size === 0 && lotConflict))
  ) {
    const explanation = lotConflict
      ? `Lot number ${lotConflict[1]} is already assigned within this event.`
      : "Another lot in the same auction event already uses this lot number.";
    return new Auctioneer2ClientError(
      `LOT_NUMBER_CONFLICT: ${explanation} Resolve the conflicting number in Auctioneer, then retry sending.`,
      { statusCode: 409, code: "LOT_NUMBER_CONFLICT", upstreamStatus: status }
    );
  }

  /*
     Owner 2026-10-28: on a contract with a Schedule A, Auctioneer refuses a
     new lot that does not name its Schedule A item, and one that names an
     item not ticked "Several lots". Both are actionable by people, so the
     delivery error says what to do rather than echoing the provider.
  */
  if (status === 409 && codes.has("SCHEDULE_A_ITEM_REQUIRED")) {
    return new Auctioneer2ClientError(
      "SCHEDULE_A_ITEM_REQUIRED: Auctioneer 2.0 needs to know which Schedule A item this lot belongs to. Choose the Schedule A item for the lot, then send again.",
      { statusCode: 409, code: "SCHEDULE_A_ITEM_REQUIRED", upstreamStatus: status }
    );
  }
  if (status === 409 && codes.has("SCHEDULE_A_ITEM_NOT_SEVERAL_LOTS")) {
    return new Auctioneer2ClientError(
      "SCHEDULE_A_ITEM_NOT_SEVERAL_LOTS: The Schedule A item chosen for this lot is not marked Several lots in Auctioneer 2.0. Ask the office to tick Several lots on that item, then retry sending.",
      { statusCode: 409, code: "SCHEDULE_A_ITEM_NOT_SEVERAL_LOTS", upstreamStatus: status }
    );
  }

  /*
     Owner 2026-10-28: a returned Proposal item must name a listed item that
     was pushed to the user returning it. Auctioneer's sentence quotes the
     item's title, which is customer data, so only the meaning crosses here.
  */
  if (
    status === 400 &&
    messages.some((message) => /scheduleALineId|was not pushed|pushed to this Asset Insight user/.test(message))
  ) {
    return new Auctioneer2ClientError(
      "PROPOSAL_ITEM_NOT_PUSHED: Auctioneer 2.0 no longer has one of these Proposal items pushed to you. Refresh the Proposal, or ask the office to push the item to you again, then retry sending.",
      { statusCode: 409, code: "PROPOSAL_ITEM_NOT_PUSHED", upstreamStatus: status }
    );
  }

  if (status === 409 && codes.has("CONTRACT_ALREADY_COMPLETED")) {
    return new Auctioneer2ClientError(
      "CONTRACT_ALREADY_COMPLETED: The auction contract has already been completed. Ask the auction team to review its status before retrying.",
      { statusCode: 409, code: "CONTRACT_ALREADY_COMPLETED", upstreamStatus: status }
    );
  }

  /*
     Auctioneer refuses a contract close that does not name the user when more
     than one assigned user is still working, rather than guessing whose part
     to close. Asset Insight always names the user, so this should not occur;
     if it does, the caller gets a stable code and a sentence it can show,
     never the provider's own wording or its list of other users' ids.
  */
  if (status === 409 && codes.has("AMBIGUOUS_COMPLETION_USER")) {
    return new Auctioneer2ClientError(
      "AMBIGUOUS_COMPLETION_USER: Auctioneer could not tell whose part of the contract to close. Retry; if it happens again, ask the auction team to check the contract's Asset Insight assignments.",
      { statusCode: 409, code: "AMBIGUOUS_COMPLETION_USER", upstreamStatus: status }
    );
  }

  const closedEvent = messages.some(message =>
    /^Event "[^"\r\n]{1,160}" is closed\.?$/.test(message)
  );
  if (
    status === 400 &&
    (codes.has("EVENT_CLOSED") || (codes.size === 0 && closedEvent))
  ) {
    // Event titles are customer data and are not needed to explain the failure.
    return new Auctioneer2ClientError(
      "EVENT_CLOSED: The auction event is closed. Ask the auction team to review its status before retrying.",
      { statusCode: 400, code: "EVENT_CLOSED", upstreamStatus: status }
    );
  }
  return undefined;
}

async function parseResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    // A few reverse proxies prepend a UTF-8 BOM even when the upstream body is
    // otherwise valid JSON. JSON.parse does not accept that marker.
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Auctioneer2ClientError("Auctioneer 2.0 returned an invalid response.", {
      statusCode: 502,
      code: "auctioneer2_invalid_response",
      upstreamStatus: response.status,
    });
  }
}

export async function auctioneer2Request<T = Auctioneer2Record>(
  path: string,
  init: RequestInit = {},
  options: {
    ambiguousWriteOnNetworkFailure?: boolean;
    expectedStatuses?: readonly number[];
  } = {}
): Promise<T> {
  const { baseUrl, apiKey, timeoutMs } = getConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("X-API-Key", apiKey);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(baseUrl, path), {
      ...init,
      headers,
      signal: controller.signal,
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    throw new Auctioneer2ClientError(
      timedOut
        ? "Auctioneer 2.0 did not respond before the timeout."
        : "Auctioneer 2.0 could not be reached.",
      {
        statusCode: timedOut ? 504 : 502,
        code: timedOut ? "auctioneer2_timeout" : "auctioneer2_unreachable",
        ambiguousWrite: Boolean(options.ambiguousWriteOnNetworkFailure),
      }
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    if (response.status === 400 || response.status === 409) {
      const text = await response.text().catch(() => "");
      const validation = safeUpstreamValidation(response.status, text, apiKey);
      if (validation) throw validation;
    } else {
      await response.arrayBuffer().catch(() => undefined);
    }
    throw new Auctioneer2ClientError(
      `Auctioneer 2.0 rejected the request with status ${response.status}.`,
      {
        statusCode: mapUpstreamStatus(response.status),
        code:
          response.status === 429
            ? "auctioneer2_rate_limited"
            : response.status === 401 || response.status === 403
              ? "auctioneer2_auth_failed"
              : "auctioneer2_upstream_error",
        upstreamStatus: response.status,
        // A received HTTP response is not a transport ambiguity. The special
        // Unknown Lot reconciliation path is reserved for a timeout/network
        // failure where the upstream may have committed before disconnecting.
        ambiguousWrite: false,
      }
    );
  }

  if (
    options.expectedStatuses?.length &&
    !options.expectedStatuses.includes(response.status)
  ) {
    await response.arrayBuffer().catch(() => undefined);
    throw new Auctioneer2ClientError(
      `Auctioneer 2.0 returned an unexpected status ${response.status}.`,
      {
        statusCode: 502,
        code: "auctioneer2_invalid_response",
        upstreamStatus: response.status,
      }
    );
  }

  return (await parseResponse(response)) as T;
}

function extractArray(
  payload: unknown,
  keys: string[]
): Auctioneer2Record[] | undefined {
  if (Array.isArray(payload)) return payload.filter(isRecord);
  if (!isRecord(payload)) return undefined;
  if (
    Object.prototype.hasOwnProperty.call(payload, "success") &&
    payload.success !== true
  ) {
    return undefined;
  }
  for (const key of keys) {
    const candidate = payload[key];
    if (Array.isArray(candidate)) return candidate.filter(isRecord);
  }
  if (Array.isArray(payload.data)) return payload.data.filter(isRecord);
  if (isRecord(payload.data)) return extractArray(payload.data, keys);
  return undefined;
}

function requireArray(payload: unknown, keys: string[]): Auctioneer2Record[] {
  const result = extractArray(payload, keys);
  if (result) return result;
  throw new Auctioneer2ClientError(
    "Auctioneer 2.0 returned an invalid response.",
    {
      statusCode: 502,
      code: "auctioneer2_invalid_response",
    }
  );
}

function assertVerified(payload: unknown): void {
  if (isRecord(payload) && payload.success === true) return;
  throw new Auctioneer2ClientError(
    "Auctioneer 2.0 returned an invalid verification response.",
    {
      statusCode: 502,
      code: "auctioneer2_invalid_response",
    }
  );
}

export async function verifyAuctioneer2Connection() {
  const config = getAuctioneer2ConfigStatus();
  if (!config.configured || !config.enabled) {
    return { ...config, reachable: false, verificationEndpoint: null as string | null };
  }
  try {
    assertVerified(await auctioneer2Request("/auth/verify"));
    return { ...config, reachable: true, verificationEndpoint: "/auth/verify" };
  } catch (error) {
    const verificationRouteUnavailable =
      error instanceof Auctioneer2ClientError &&
      (error.upstreamStatus === 404 ||
        error.upstreamStatus === 405 ||
        // Older deployments can route an unknown /auth/verify path to an HTML
        // shell with HTTP 200. Treat that as an unavailable route and use the
        // legacy health check. A valid JSON success:false still fails closed.
        (error.code === "auctioneer2_invalid_response" &&
          error.upstreamStatus !== undefined &&
          error.upstreamStatus >= 200 &&
          error.upstreamStatus < 300));
    if (!verificationRouteUnavailable) throw error;
    assertVerified(await auctioneer2Request("/health"));
    return { ...config, reachable: true, verificationEndpoint: "/health" };
  }
}

export async function listContracts(): Promise<Auctioneer2Record[]> {
  return requireArray(await auctioneer2Request("/contracts"), [
    "contracts",
    "items",
    "results",
  ]);
}

export const AUCTIONEER2_INCOMING_CONTRACT_STATUS =
  "ProposalInAssetInsight" as const;

export async function listIncomingContracts(
  userId: string,
  includeCompleted = false
): Promise<Auctioneer2Record[]> {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) {
    throw new Auctioneer2ClientError(
      "An Asset Insight user is required to load incoming Auctioneer work.",
      {
        statusCode: 500,
        code: "auctioneer2_user_required",
      }
    );
  }
  const query = new URLSearchParams({
    status: AUCTIONEER2_INCOMING_CONTRACT_STATUS,
    userId: normalizedUserId,
  });
  if (includeCompleted) query.set("includeCompleted", "true");
  return requireArray(
    await auctioneer2Request(`/contracts?${query.toString()}`),
    ["items"]
  );
}

export type AuctioneerAccessRevision = string | number;
export type AuctioneerCapturePermission = {
  reopen: { allowed: boolean; reason: string | null; reopenUntil: string | null };
  accessRevision?: AuctioneerAccessRevision;
};

export function validAuctioneerAccessRevision(value: unknown): value is AuctioneerAccessRevision {
  return (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === "string" && value.length <= 200 && value.trim().length > 0);
}

function contractActorResponse(raw: unknown, contractId: string, userId: string): Auctioneer2Record {
  const data = isRecord(raw) && isRecord(raw.data) ? raw.data : raw;
  if (!isRecord(data) || (isRecord(raw) && raw.success === false) || data.success === false ||
      (data.contractId !== undefined && data.contractId !== contractId) ||
      (data.userId !== undefined && String(data.userId).toLowerCase() !== userId.toLowerCase())) {
    throw new Auctioneer2ClientError("Auctioneer could not confirm this contract and user. Refresh Incoming before continuing.",
      { statusCode: 502, code: "auctioneer2_invalid_response" });
  }
  return data;
}

export async function getContractCapturePermission(contractId: string, userId: string): Promise<AuctioneerCapturePermission> {
  const query = new URLSearchParams({ userId });
  const data = contractActorResponse(await contractReopenRequest(
    `/contracts/${encodeURIComponent(contractId)}/capture-permission?${query}`), contractId, userId);
  // Older Auctioneer deployments have no Re-Open capability. Never infer it.
  if (data.reopen === undefined) return { reopen: { allowed: false, reason: null, reopenUntil: null } };
  const reopen = data.reopen;
  if (!isRecord(reopen) || typeof reopen.allowed !== "boolean" ||
      (reopen.reason != null && typeof reopen.reason !== "string") ||
      (reopen.reopenUntil != null && (typeof reopen.reopenUntil !== "string" || !Number.isFinite(Date.parse(reopen.reopenUntil))))) {
    throw new Auctioneer2ClientError("Auctioneer returned incomplete Re-Open permission. Refresh Incoming before continuing.",
      { statusCode: 502, code: "auctioneer2_invalid_response" });
  }
  const reason = typeof reopen.reason === "string" && Object.prototype.hasOwnProperty.call(AUCTIONEER_REOPEN_ERRORS, reopen.reason)
    ? reopen.reason : null;
  return { reopen: { allowed: reopen.allowed, reason, reopenUntil: (reopen.reopenUntil as string) || null },
    ...(validAuctioneerAccessRevision(data.accessRevision) ? { accessRevision: data.accessRevision } : {}) };
}

export async function reopenContractForUser(contractId: string, input: { userId: string; reopenedBy: string }) {
  const data = contractActorResponse(await contractReopenRequest(
    `/contracts/${encodeURIComponent(contractId)}/reopen`,
    { method: "POST", body: JSON.stringify(input) }), contractId, input.userId);
  if ((data.reopened === true) === (data.alreadyOpen === true) || !validAuctioneerAccessRevision(data.accessRevision)) {
    throw new Auctioneer2ClientError("Auctioneer has not confirmed Re-Open. Refresh Incoming and retry this same Re-Open request.",
      { statusCode: 502, code: "auctioneer2_reopen_unconfirmed", ambiguousWrite: true });
  }
  return { contractId, reopened: data.reopened === true, alreadyOpen: data.alreadyOpen === true,
    accessRevision: data.accessRevision };
}

async function contractReopenRequest(path: string, init: RequestInit = {}) {
  try { return await auctioneer2Request<unknown>(path, init,
    { expectedStatuses: [200], ambiguousWriteOnNetworkFailure: init.method === "POST" }); }
  catch (error) {
    if (!(error instanceof Auctioneer2ClientError) || Object.prototype.hasOwnProperty.call(AUCTIONEER_REOPEN_ERRORS, error.code)) throw error;
    throw new Auctioneer2ClientError("Auctioneer could not confirm this request. Refresh Incoming and check the same contract before trying again.",
      { statusCode: error.statusCode, code: error.code, upstreamStatus: error.upstreamStatus, ambiguousWrite: error.ambiguousWrite });
  }
}

export async function listIncomingTasks(
  userId: string,
  contractId?: string
): Promise<Auctioneer2Record[]> {
  const normalizedUserId = String(userId || "").trim();
  if (!normalizedUserId) {
    throw new Auctioneer2ClientError(
      "An Asset Insight user is required to load incoming Auctioneer work.",
      {
        statusCode: 500,
        code: "auctioneer2_user_required",
      }
    );
  }
  const query = new URLSearchParams({ userId: normalizedUserId });
  const normalizedContractId = String(contractId || "").trim();
  if (normalizedContractId) query.set("contractId", normalizedContractId);
  return requireArray(await auctioneer2Request(`/tasks/incoming?${query.toString()}`), [
    "tasks",
    "submissions",
    "items",
    "results",
  ]);
}

export async function listCompletedTasks(): Promise<Auctioneer2Record[]> {
  return requireArray(await auctioneer2Request("/tasks/completed"), [
    "tasks",
    "submissions",
    "items",
    "results",
  ]);
}

export async function getContractLots(contractId: string): Promise<Auctioneer2Record[]> {
  return requireArray(
    await auctioneer2Request(`/contracts/${encodeURIComponent(contractId)}/lots`),
    ["lots", "items", "results"]
  );
}

/** One item of a contract's Schedule A, as GET /contracts/:id/schedule-a-items lists it. */
export type Auctioneer2ScheduleAItem = {
  lineId: string;
  title: string;
  /** Ticked "Several lots": the item may come back as more than one lot. */
  severalLots: boolean;
  /** The Auctioneer lot extra lots of this item name as scheduleAParentRef. */
  parentLotId: string | null;
  lotCount: number;
  sortOrder: number;
  /*
     A Proposal's list only (owner 2026-10-28): what the item is, whose it is,
     and whether it has come back. Present only when Auctioneer sends them.
  */
  lotNumber?: string;
  serialNumber?: string;
  year?: string;
  make?: string;
  model?: string;
  description?: string;
  assetInsightUserId?: string;
  sentToAssetInsight?: boolean;
  /** Returned captured (green). */
  returned?: boolean;
  /** Returned as not found (red), when Auctioneer reports it. */
  notFound?: boolean;
};

export type Auctioneer2ScheduleAItems = {
  contractId: string;
  hasScheduleA: boolean;
  items: Auctioneer2ScheduleAItem[];
};

/**
 * The contract's Schedule A items, in Schedule A order (owner 2026-10-28).
 *
 * The envelope is checked rather than trusted: success must be true, a
 * contractId that names another contract is refused, and hasScheduleA must be
 * a boolean. An item without a line id cannot be chosen and is dropped; ids
 * are kept as strings so a numeric id never reaches a client as a number.
 *
 * With options.userId, a Proposal's list is narrowed by Auctioneer to the
 * items pushed to that Asset Insight user (owner 2026-10-28). An item naming
 * another user is refused rather than shown: the filter is an authorization
 * boundary, not a presentation detail.
 */
export async function getContractScheduleAItems(
  contractId: string,
  options: { userId?: string } = {}
): Promise<Auctioneer2ScheduleAItems> {
  const normalizedContractId = String(contractId || "").trim();
  const userId = String(options.userId || "").trim();
  const invalid = () =>
    new Auctioneer2ClientError("Auctioneer 2.0 returned an invalid Schedule A item list.", {
      statusCode: 502,
      code: "auctioneer2_invalid_response",
    });
  if (!normalizedContractId) throw invalid();
  const query = userId ? `?${new URLSearchParams({ userId })}` : "";
  const raw = await auctioneer2Request<unknown>(
    `/contracts/${encodeURIComponent(normalizedContractId)}/schedule-a-items${query}`,
    {},
    { expectedStatuses: [200] }
  );
  // Documented shape is flat; a { success, data: {...} } envelope is accepted
  // like the other reads accept it.
  const payload = isRecord(raw) && !Array.isArray(raw.items) && isRecord(raw.data) ? raw.data : raw;
  if (
    !isRecord(raw) || raw.success !== true || !isRecord(payload) || payload.success === false ||
    typeof payload.hasScheduleA !== "boolean" || !Array.isArray(payload.items) ||
    (payload.contractId !== undefined && String(payload.contractId).trim() !== normalizedContractId)
  ) throw invalid();
  const text = (value: unknown) =>
    typeof value === "string" ? value.trim() : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  const optionalText = <K extends string>(key: K, value: unknown) => {
    const cleaned = text(value);
    return cleaned ? ({ [key]: cleaned } as Record<K, string>) : {};
  };
  const records = payload.items.filter(isRecord);
  if (userId && records.some((item) =>
    item.assetInsightUserId != null && text(item.assetInsightUserId).toLowerCase() !== userId.toLowerCase()
  )) {
    throw new Auctioneer2ClientError(
      "Auctioneer 2.0 returned Proposal items pushed to a different Asset Insight user.",
      { statusCode: 502, code: "auctioneer2_invalid_response" }
    );
  }
  const items = records
    .map((item, index) => {
      const sortOrder = Number(item.sortOrder);
      const lotCount = Number(item.lotCount);
      return {
        lineId: text(item.lineId),
        title: text(item.title),
        severalLots: item.severalLots === true,
        parentLotId: text(item.parentLotId) || null,
        lotCount: Number.isFinite(lotCount) && lotCount >= 0 ? lotCount : 0,
        sortOrder: Number.isFinite(sortOrder) ? sortOrder : index,
        ...optionalText("lotNumber", item.lotNumber),
        ...optionalText("serialNumber", item.serialNumber),
        ...optionalText("year", item.year),
        ...optionalText("make", item.make),
        ...optionalText("model", item.model),
        ...optionalText("description", item.description),
        ...optionalText("assetInsightUserId", item.assetInsightUserId),
        ...(typeof item.sentToAssetInsight === "boolean" ? { sentToAssetInsight: item.sentToAssetInsight } : {}),
        ...(typeof item.returned === "boolean" ? { returned: item.returned } : {}),
        ...(typeof item.notFound === "boolean" ? { notFound: item.notFound } : {}),
        index,
      };
    })
    .filter((item) => item.lineId)
    // Auctioneer already lists them in order; a stable sort only guards a
    // deployment that does not.
    .sort((first, second) => first.sortOrder - second.sortOrder || first.index - second.index)
    .map(({ index: _index, ...item }) => item);
  return { contractId: normalizedContractId, hasScheduleA: payload.hasScheduleA, items };
}

/** One returned Proposal item, as POST /proposals/:contractId/review-items takes it. */
export type Auctioneer2ProposalReviewItem = {
  /** Asset Insight's own reference; a later return with the same one replaces it. */
  proposalItemRef: string;
  /** The listed item this completes; absent for an item that was not on the list. */
  scheduleALineId?: string;
  /** A listed item the user could not find (owner 2026-10-28, red). */
  notFound?: true;
  description?: string;
  year?: string;
  make?: string;
  model?: string;
  serialNumber?: string;
  hours?: string;
  category?: string;
  conditionReport?: string;
  photos?: string[];
};

export type Auctioneer2ProposalReviewReturn = {
  contractId: string;
  reviewItemCount: number;
  /** The Proposal is still in the Asset Insight queue (some listed item is not back). */
  remainsInAssetInsight: boolean;
};

/**
 * Returns Proposal items to Auctioneer for the office's review (owner
 * 2026-10-28). Nothing here creates an Auctioneer lot: the office approves the
 * returned list, and only then does the contract run the Schedule A flow.
 *
 * Auctioneer replaces an item returned again under the same proposalItemRef,
 * so a lost response is safe to repeat while the Proposal is still open. A
 * repeat after the last item closed the Proposal is refused with
 * CONTRACT_ALREADY_COMPLETED, which the caller has to reconcile.
 */
export async function returnProposalReviewItems(
  contractId: string,
  input: {
    completedBy: string;
    completedByUserId: string;
    items: Auctioneer2ProposalReviewItem[];
    /**
     * A Proposal without a list (one user) stays in the Asset Insight queue
     * when true; its absence closes it. A list Proposal ignores it: it closes
     * once every listed item is back.
     */
    moreLotsExpected?: boolean;
  }
): Promise<Auctioneer2ProposalReviewReturn> {
  const normalizedContractId = String(contractId || "").trim();
  const userId = String(input.completedByUserId || "").trim();
  if (!normalizedContractId || !userId || input.items.length < 1 || input.items.length > 500) {
    throw new Auctioneer2ClientError(
      "A Proposal, an Asset Insight user and 1 to 500 items are required to return Proposal items.",
      { statusCode: 500, code: "auctioneer2_proposal_return_invalid" }
    );
  }
  const response = await auctioneer2Request<unknown>(
    `/proposals/${encodeURIComponent(normalizedContractId)}/review-items`,
    {
      method: "POST",
      body: JSON.stringify({
        completedBy: String(input.completedBy || "").trim() || `Asset Insight user ${userId}`,
        completedByUserId: userId,
        items: input.items,
        ...(input.moreLotsExpected === true ? { moreLotsExpected: true } : {}),
      }),
    },
    { expectedStatuses: [200, 201], ambiguousWriteOnNetworkFailure: true }
  );
  if (
    !isRecord(response) || response.success !== true ||
    (response.contractId !== undefined && String(response.contractId).trim() !== normalizedContractId) ||
    typeof response.remainsInAssetInsight !== "boolean"
  ) {
    throw new Auctioneer2ClientError(
      "Auctioneer 2.0 returned an invalid response while receiving the Proposal items.",
      { statusCode: 502, code: "auctioneer2_invalid_response", ambiguousWrite: true }
    );
  }
  const count = Number(response.reviewItemCount);
  return {
    contractId: normalizedContractId,
    reviewItemCount: Number.isInteger(count) && count >= 0 ? count : input.items.length,
    remainsInAssetInsight: response.remainsInAssetInsight,
  };
}

export async function getLot(lotId: string): Promise<Auctioneer2Record> {
  const rawPayload = await auctioneer2Request<unknown>(
    `/lots/${encodeURIComponent(lotId)}`
  );
  const payload =
    isRecord(rawPayload) && isRecord(rawPayload.data)
      ? rawPayload.data
      : rawPayload;
  if (isRecord(payload) && isRecord(payload.lot)) {
    // Preserve the convenient flat lot fields while retaining the immutable
    // contract/event/services/photo context used by setup and reconciliation.
    return {
      /*
         "A To-Do Board job for this lot is out with Asset Insight and not yet
         finished." Auctioneer may send it inside the lot block or beside it;
         flattening used to keep only the lot block, so a flag sent beside it
         would vanish here and delivery would take an unfinished re-inspection
         for an already finished lot. Beside it is copied in first, so a value
         inside the lot block wins.
      */
      ...(typeof payload.awaitingAssetInsightReinspection === "boolean"
        ? { awaitingAssetInsightReinspection: payload.awaitingAssetInsightReinspection }
        : {}),
      ...payload.lot,
      ...(isRecord(payload.contract) ? { contract: payload.contract } : {}),
      ...(isRecord(payload.event) ? { event: payload.event } : {}),
      ...(Array.isArray(payload.photos) ? { photos: payload.photos } : {}),
      ...(Array.isArray(payload.services) ? { services: payload.services } : {}),
      ...(Array.isArray(payload.lifecycle) ? { lifecycle: payload.lifecycle } : {}),
    };
  }
  if (isRecord(payload)) return payload;
  throw new Auctioneer2ClientError("Auctioneer 2.0 returned an invalid lot.", {
    statusCode: 502,
    code: "auctioneer2_invalid_response",
  });
}

export function patchLot(
  lotId: string,
  body: Auctioneer2Record
): Promise<Auctioneer2Record> {
  return auctioneer2Request(`/lots/${encodeURIComponent(lotId)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function completeConditionReport(
  lotId: string,
  body: Auctioneer2Record
): Promise<Auctioneer2Record> {
  return auctioneer2Request(`/lots/${encodeURIComponent(lotId)}/complete-cr`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function submitLot(body: Auctioneer2Record): Promise<Auctioneer2Record> {
  return auctioneer2Request(
    "/lots/submit",
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    { ambiguousWriteOnNetworkFailure: true }
  );
}

export function markArrived(
  lotId: string,
  body: Auctioneer2Record = {}
): Promise<Auctioneer2Record> {
  return auctioneer2Request(`/lots/${encodeURIComponent(lotId)}/mark-arrived`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function pushToAssetInsight(
  lotId: string,
  body: Auctioneer2Record = {}
): Promise<Auctioneer2Record> {
  return auctioneer2Request(`/lots/${encodeURIComponent(lotId)}/push-to-asset-insight`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/**
 * Close the WHOLE contract task, naming nobody.
 *
 * Kept for work that predates per-user assignment (no assignmentUserId), where
 * there is nobody to name and the contract itself is what finishes. Anything
 * assigned to a user closes through closeContractPartForUser instead, because
 * on a contract shared by several users an unnamed close is refused by
 * Auctioneer, and a guessed one would sign off someone else's work.
 */
export function completeContractTask(
  contractId: string,
  body: Auctioneer2Record = {}
): Promise<Auctioneer2Record> {
  return auctioneer2Request(`/contracts/${encodeURIComponent(contractId)}/task-completed`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** What Auctioneer answered when one Asset Insight user closed their part. */
export type Auctioneer2ContractPartClose = {
  contractId: string;
  /**
   * The user Auctioneer closed for — the completedByUserId it was sent, echoed
   * back. Null when the whole contract had already closed before this call, in
   * which case Auctioneer changes nothing and names nobody.
   */
  userId: string | null;
  /**
   * That user's assignment after the call, as Auctioneer reports it:
   *   "completed"  their part is closed (also on a repeat of the same close);
   *   "revoked"    they had been taken off the contract, so there was nothing
   *                of theirs to close;
   *   null         Auctioneer holds no assignment for them on this contract,
   *                or the contract had already closed.
   * An unknown status is not evidence of closing this user's part. It is only
   * retained when Auctioneer confirms the entire contract is complete.
   */
  userStatus: string | null;
  /** Every assigned user has now closed theirs: the whole contract is complete. */
  taskCompleted: boolean;
  /** The contract was already complete before this call; nothing changed. */
  alreadyCompleted: boolean;
};

/**
 * Close ONE user's part of a contract.
 *
 * POST /contracts/:contractId/task-completed with completedByUserId naming the
 * Asset Insight user (their MongoDB _id — the same id Auctioneer keys their
 * assignment by). Auctioneer completes that user's assignment only, then
 * decides for itself whether the contract as a whole is finished: it is when
 * every assigned user has closed theirs. A contract nobody was ever assigned
 * per user still closes outright, which is Auctioneer's rule, not ours.
 *
 * The endpoint is idempotent — a repeat changes nothing and reports the first
 * outcome — so a lost response is safe to retry with the same arguments.
 *
 * The answer is checked rather than trusted: success must be true, the whole-
 * contract flag must be a boolean, and a reply that names a DIFFERENT user than
 * the one asked for is refused outright, because recording it would tell this
 * user their part is closed when somebody else's was.
 */
export async function closeContractPartForUser(
  contractId: string,
  input: { completedBy: string; completedByUserId: string }
): Promise<Auctioneer2ContractPartClose> {
  const normalizedContractId = String(contractId || "").trim();
  const userId = String(input.completedByUserId || "").trim();
  if (!normalizedContractId || !userId) {
    throw new Auctioneer2ClientError(
      "A contract and an Asset Insight user are required to close a part of an Auctioneer contract.",
      { statusCode: 500, code: "auctioneer2_user_required" }
    );
  }
  const response = await auctioneer2Request<unknown>(
    `/contracts/${encodeURIComponent(normalizedContractId)}/task-completed`,
    {
      method: "POST",
      body: JSON.stringify({
        completedBy: String(input.completedBy || "").trim() || `Asset Insight user ${userId}`,
        completedByUserId: userId,
      }),
    }
  );
  const invalid = () =>
    new Auctioneer2ClientError(
      "Auctioneer 2.0 returned an invalid response while closing the contract.",
      { statusCode: 502, code: "auctioneer2_invalid_response" }
    );
  if (
    !isRecord(response) || response.success !== true ||
    typeof response.contractId !== "string" ||
    response.contractId.trim() !== normalizedContractId
  ) throw invalid();
  const echoedUserId =
    typeof response.userId === "string" ? response.userId.trim() : "";
  if (echoedUserId && echoedUserId.toLowerCase() !== userId.toLowerCase()) {
    throw new Auctioneer2ClientError(
      "Auctioneer closed the contract for a different user than the one who asked. Nothing was recorded; ask the auction team to check the contract's Asset Insight assignments.",
      { statusCode: 502, code: "auctioneer2_contract_close_user_mismatch" }
    );
  }
  // Validate identity before the already-completed shortcut as well. A generic
  // success receipt or an active/unknown grant is not proof that a part closed.
  if (response.alreadyCompleted === true) {
    if (response.taskCompleted !== undefined && response.taskCompleted !== true) throw invalid();
    return {
      contractId: normalizedContractId,
      userId: null,
      userStatus: null,
      taskCompleted: true,
      alreadyCompleted: true,
    };
  }
  if (typeof response.taskCompleted !== "boolean") throw invalid();
  const userStatus = typeof response.userStatus === "string"
    ? response.userStatus.trim()
    : "";
  if (
    !response.taskCompleted &&
    (!echoedUserId || !["completed", "revoked"].includes(userStatus))
  ) throw invalid();
  return {
    contractId: normalizedContractId,
    userId: echoedUserId || null,
    userStatus: userStatus || null,
    taskCompleted: response.taskCompleted,
    alreadyCompleted: false,
  };
}

/**
 * Set a lot's walkaround video.
 *
 * The same endpoint the photos go to, because that is where Auctioneer keeps it:
 * a video is one more item in the lot's gallery, taking a sort order among the
 * photographs, and the portal stores it as a row whose media type is "video".
 * IT IS A LINK, NOT A FILE — nothing is fetched, encoded or uploaded here, which
 * is why this is a small JSON call rather than part of the batched photo run.
 *
 * Auctioneer accepts a video on its own, with no photos alongside, and holds one
 * video per lot: sending a different link replaces it, sending the same one
 * again is a no-op. That is what makes this safe to repeat on a retry.
 */
export async function setLotVideo(
  lotId: string,
  videoUrl: string
): Promise<Auctioneer2Record> {
  const url = auctioneerYoutubeUrl(videoUrl);
  if (!url) throw new Auctioneer2ClientError("Auctioneer requires a valid YouTube link in the lot video field.", { statusCode: 400, code: "auctioneer2_invalid_video" });
  const response = await auctioneer2Request<Auctioneer2Record>(
    `/lots/${encodeURIComponent(lotId)}/photos`,
    {
      method: "POST",
      body: JSON.stringify({ video_url: url }),
    },
    { expectedStatuses: [200, 201] }
  );
  const video = response?.video as Auctioneer2Record | undefined;
  if (response?.success !== true || auctioneerYoutubeUrl(video?.url) !== url) {
    throw new Auctioneer2ClientError("Auctioneer did not confirm the saved lot video. Retry the same delivery; photos will not be resent.", { statusCode: 502, code: "auctioneer2_invalid_video_response" });
  }
  return response;
}

export async function uploadLotPhotos(
  lotId: string,
  photos: Auctioneer2Photo[]
): Promise<Auctioneer2Record> {
  if (
    photos.length < 1 ||
    photos.length > AUCTIONEER2_PHOTO_MAX_FILES_PER_REQUEST
  ) {
    throw new Auctioneer2ClientError(
      "Each Auctioneer photo request must contain 1 to 5 images.",
      {
        statusCode: 400,
        code: "auctioneer2_invalid_photo_batch",
      }
    );
  }

  let totalBytes = 0;
  const payloadPhotos = photos.map((photo, index) => {
    if (photo.buffer.byteLength > AUCTIONEER2_PHOTO_MAX_FILE_BYTES) {
      throw new Auctioneer2ClientError("An Auctioneer photo exceeds the 20 MB limit.", {
        statusCode: 400,
        code: "auctioneer2_photo_too_large",
      });
    }
    totalBytes += photo.buffer.byteLength;

    const normalizedContentType = String(photo.contentType || "")
      .split(";")[0]
      .trim()
      .toLowerCase()
      .replace(/^image\/jpg$/, "image/jpeg");
    if (!AUCTIONEER2_PHOTO_CONTENT_TYPES.has(normalizedContentType)) {
      throw new Auctioneer2ClientError(
        "An Auctioneer photo has an unsupported image type.",
        {
          statusCode: 400,
          code: "auctioneer2_invalid_photo_type",
        }
      );
    }
    const filename = String(photo.filename || "").trim();
    if (!filename) {
      throw new Auctioneer2ClientError(
        "An Auctioneer photo filename is required.",
        {
          statusCode: 400,
          code: "auctioneer2_invalid_photo_filename",
        }
      );
    }
    const order = photo.order ?? index;
    if (!Number.isInteger(order) || order < 0) {
      throw new Auctioneer2ClientError(
        "An Auctioneer photo order must be a non-negative integer.",
        {
          statusCode: 400,
          code: "auctioneer2_invalid_photo_order",
        }
      );
    }

    return {
      data: `data:${normalizedContentType};base64,${photo.buffer.toString("base64")}`,
      content_type: normalizedContentType,
      filename,
      sha256: createHash("sha256").update(photo.buffer).digest("hex"),
      order,
    };
  });

  if (totalBytes > AUCTIONEER2_PHOTO_MAX_BATCH_BYTES) {
    throw new Auctioneer2ClientError(
      "An Auctioneer photo request exceeds the 35 MB decoded batch limit.",
      {
        statusCode: 400,
        code: "auctioneer2_photo_batch_too_large",
      }
    );
  }

  const response = await auctioneer2Request<Auctioneer2Record>(
    `/lots/${encodeURIComponent(lotId)}/photos`,
    {
      method: "POST",
      body: JSON.stringify({ photos: payloadPhotos }),
    },
    { expectedStatuses: [201] }
  );

  const nestedData = isRecord(response.data) ? response.data : undefined;
  const delivery = String(response.delivery ?? nestedData?.delivery ?? "")
    .trim()
    .toLowerCase();
  const results = extractArray(response, ["photos", "images", "results"]);
  const validResults =
    Array.isArray(results) &&
    results.length === payloadPhotos.length &&
    results.every((result) => {
      const skipped = result.skipped === true || result.duplicate === true;
      const photoUrl =
        result.photoUrl ?? result.photo_url ?? result.url ?? result.storageUrl;
      const sortOrder = result.sortOrder ?? result.sort_order ?? result.order;
      return (
        (skipped || (typeof photoUrl === "string" && photoUrl.trim().length > 0)) &&
        Number.isInteger(sortOrder) &&
        Number(sortOrder) >= 0
      );
    });

  if (response.success !== true || delivery !== "base64" || !validResults) {
    throw new Auctioneer2ClientError(
      "Auctioneer 2.0 returned an invalid photo upload response.",
      {
        statusCode: 502,
        code: "auctioneer2_invalid_response",
        upstreamStatus: 201,
      }
    );
  }
  return response;
}
