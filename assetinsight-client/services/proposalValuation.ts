import API from "@/lib/api";
import { getAccessToken } from "@/lib/auth-storage";
import { API_BASE } from "@/lib/config";
import { getDeviceKey } from "@/lib/device-access";
import type {
  ProposalValuationCandidate,
  ProposalValuationChange,
  ProposalValuationListItem,
  ProposalValuationPayload,
} from "@/components/reports/proposal-valuation/types";

type RevisionMutation = {
  baseRevision: number;
  clientMutationId: string;
};

function safeDispositionFilename(value: string | undefined) {
  if (!value) return undefined;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .split(/[\\/]/)
    .pop()
    ?.trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : undefined;
}

export function contentDispositionFilename(disposition: string | undefined) {
  if (!disposition) return undefined;

  const encodedMatch = /filename\*\s*=\s*([^;]+)/i.exec(disposition);
  if (encodedMatch?.[1]) {
    const encoded = encodedMatch[1]
      .trim()
      .replace(/^['"]|['"]$/g, "")
      .replace(/^[^']*'[^']*'/, "");
    try {
      const decoded = safeDispositionFilename(decodeURIComponent(encoded));
      if (decoded) return decoded;
    } catch {
      // Fall through to the plain filename parameter when encoding is invalid.
    }
  }

  const plainMatch = /filename\s*=\s*(?:"((?:\\.|[^"\\])*)"|([^;]*))/i.exec(
    disposition
  );
  const plain = (plainMatch?.[1] || plainMatch?.[2] || "")
    .replace(/\\(["\\])/g, "$1")
    .trim();
  return safeDispositionFilename(plain);
}

function headerValue(headers: unknown, name: string) {
  const candidate = headers as
    | { get?: (key: string) => unknown; [key: string]: unknown }
    | undefined;
  const viaGetter = candidate?.get?.(name);
  if (typeof viaGetter === "string") return viaGetter;
  const direct = candidate?.[name] ?? candidate?.[name.toLowerCase()];
  return typeof direct === "string" ? direct : undefined;
}

export type ProposalValuationEvent = {
  type: "ready" | "pv-revision" | "resync";
  reportId: string;
  revision?: number;
  updatedAt?: string;
  updatedBy?: string;
  mutationId?: string;
  reason?: string;
};

export class ProposalValuationAccessLost extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ProposalValuationAccessLost";
    this.status = status;
  }
}

export class ProposalValuationStreamAuthenticationError extends Error {
  constructor(message = "Your session expired. Live Proposal Valuation updates stopped.") {
    super(message);
    this.name = "ProposalValuationStreamAuthenticationError";
  }
}

export class ProposalValuationRevisionConflict extends Error {
  currentRevision: number;

  constructor(message: string, currentRevision: number) {
    super(message);
    this.name = "ProposalValuationRevisionConflict";
    this.currentRevision = currentRevision;
  }
}

function errorMessage(error: unknown, fallback: string) {
  const candidate = error as {
    response?: {
      status?: number;
      data?: { code?: string; message?: string; currentRevision?: number };
    };
    message?: string;
  };
  const data = candidate?.response?.data;
  const status = Number(candidate?.response?.status || 0);
  if (status === 403 || status === 404) {
    throw new ProposalValuationAccessLost(
      data?.message ||
        "You no longer have access to this Proposal Valuation.",
      status
    );
  }
  if (
    candidate?.response?.status === 409 &&
    data?.code === "PV_REVISION_CONFLICT"
  ) {
    throw new ProposalValuationRevisionConflict(
      data.message || "Proposal Valuation changed in another session.",
      Number(data.currentRevision) || 0
    );
  }
  return data?.message || candidate?.message || fallback;
}

function mutationId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function parseEventStream(
  response: Response,
  onEvent: (event: ProposalValuationEvent) => void
) {
  if (!response.ok || !response.body) {
    throw new Error(`Live updates unavailable (${response.status || "network"}).`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines: string[] = [];

  const dispatch = () => {
    if (!dataLines.length) return;
    if (["ready", "pv-revision", "resync"].includes(eventName)) {
      try {
        const data = JSON.parse(dataLines.join("\n")) as Omit<
          ProposalValuationEvent,
          "type"
        >;
        onEvent({ ...data, type: eventName as ProposalValuationEvent["type"] });
      } catch {
        // Ignore a malformed event and keep the stream alive.
      }
    }
    eventName = "message";
    dataLines = [];
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line) {
        dispatch();
      } else if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
  }
  dispatch();
}

export const ProposalValuationService = {
  newMutationId: mutationId,

  async list(signal?: AbortSignal) {
    try {
      const { data } = await API.get<{ items: ProposalValuationListItem[] }>(
        "/asset/proposal-valuations",
        { signal }
      );
      return data.items || [];
    } catch (error) {
      throw new Error(errorMessage(error, "Unable to load Proposal Valuations."));
    }
  },

  async get(reportId: string, signal?: AbortSignal) {
    try {
      const { data } = await API.get<ProposalValuationPayload>(
        `/asset/${encodeURIComponent(reportId)}/proposal-valuation`,
        { signal }
      );
      return data;
    } catch (error) {
      throw new Error(errorMessage(error, "Unable to load Proposal Valuation."));
    }
  },

  async exportExcel(reportId: string) {
    try {
      const response = await API.get<Blob>(
        `/asset/${encodeURIComponent(reportId)}/proposal-valuation/export`,
        { responseType: "blob" as const }
      );
      return {
        blob: response.data,
        filename: contentDispositionFilename(
          headerValue(response.headers, "content-disposition")
        ),
      };
    } catch (error) {
      const message = errorMessage(
        error,
        "Unable to export this Proposal Valuation to Excel."
      );
      throw new Error(message);
    }
  },

  async evaluatorOptions(reportId: string, query = "", signal?: AbortSignal) {
    try {
      const { data } = await API.get<{ items: ProposalValuationCandidate[] }>(
        `/asset/${encodeURIComponent(reportId)}/proposal-valuation/evaluator-options`,
        { params: query ? { q: query } : undefined, signal }
      );
      return data.items || [];
    } catch (error) {
      throw new Error(errorMessage(error, "Unable to load evaluator accounts."));
    }
  },

  async updateEvaluators(
    reportId: string,
    evaluatorUserIds: string[],
    request: RevisionMutation
  ) {
    try {
      const { data } = await API.put<ProposalValuationPayload>(
        `/asset/${encodeURIComponent(reportId)}/proposal-valuation/evaluators`,
        { evaluatorUserIds, ...request }
      );
      return data;
    } catch (error) {
      const message = errorMessage(error, "Unable to update evaluators.");
      throw new Error(message);
    }
  },

  async patchChanges(
    reportId: string,
    changes: ProposalValuationChange[],
    request: RevisionMutation
  ) {
    try {
      const { data } = await API.patch<ProposalValuationPayload>(
        `/asset/${encodeURIComponent(reportId)}/proposal-valuation`,
        { changes, ...request }
      );
      return data;
    } catch (error) {
      const message = errorMessage(error, "Unable to save Proposal Valuation.");
      throw new Error(message);
    }
  },

  async regenerate(reportId: string, request: RevisionMutation) {
    try {
      const { data } = await API.post<{
        queued: boolean;
        coalesced: boolean;
        revision: number;
        idempotent?: boolean;
      }>(
        `/asset/${encodeURIComponent(reportId)}/proposal-valuation/regenerate`,
        request
      );
      return data;
    } catch (error) {
      const message = errorMessage(error, "Unable to update report files.");
      throw new Error(message);
    }
  },

  async streamEvents(
    reportId: string,
    since: number,
    signal: AbortSignal,
    onEvent: (event: ProposalValuationEvent) => void
  ) {
    const headers = new Headers({ Accept: "text/event-stream" });
    const applyCurrentCredentials = () => {
      const token = getAccessToken();
      if (token) headers.set("Authorization", `Bearer ${token}`);
      else headers.delete("Authorization");
    };
    applyCurrentCredentials();
    const deviceKey = getDeviceKey();
    if (deviceKey) headers.set("X-Device-Key", deviceKey);
    const url = `${API_BASE}/asset/${encodeURIComponent(reportId)}/proposal-valuation/events?since=${encodeURIComponent(String(since))}`;
    let response = await fetch(url, { headers, signal, cache: "no-store" });
    if (response.status === 401) {
      try {
        // Reuse the API client's coalesced one-shot refresh behavior, then retry
        // this raw event stream once with the new bearer token.
        await API.get("/user/me", { signal });
      } catch {
        throw new ProposalValuationStreamAuthenticationError();
      }
      applyCurrentCredentials();
      response = await fetch(url, { headers, signal, cache: "no-store" });
      if (response.status === 401) {
        throw new ProposalValuationStreamAuthenticationError();
      }
    }
    if (response.status === 403 || response.status === 404) {
      throw new ProposalValuationAccessLost(
        "You no longer have access to this Proposal Valuation.",
        response.status
      );
    }
    await parseEventStream(response, onEvent);
  },

};
