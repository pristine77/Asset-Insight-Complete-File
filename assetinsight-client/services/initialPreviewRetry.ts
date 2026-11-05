import API, { type RetriableAxiosConfig } from "@/lib/api";

export type InitialPreviewKind = "asset" | "lotListing";
export type InitialPreviewRetryState = {
  initialPreviewRetryEligible: boolean;
  initialPreviewRetryIneligibleReason: string | null;
  initialPreviewRetryRevision: string | null;
};

const endpoint = (kind: InitialPreviewKind, id: string) =>
  `/${kind === "asset" ? "asset" : "lot-listing"}/${encodeURIComponent(id)}/retry-preview`;

export async function getInitialPreviewRetry(kind: InitialPreviewKind, id: string, signal: AbortSignal): Promise<InitialPreviewRetryState> {
  const response = await API.get(endpoint(kind, id), { signal, timeout: 30_000 });
  const state = response.data?.data;
  if (!state || typeof state.initialPreviewRetryEligible !== "boolean" ||
    (state.initialPreviewRetryIneligibleReason != null && typeof state.initialPreviewRetryIneligibleReason !== "string") ||
    (state.initialPreviewRetryEligible && !/^[a-f0-9]{64}$/.test(state.initialPreviewRetryRevision || ""))) {
    throw new Error("Retry availability could not be confirmed. Refresh this report before trying again.");
  }
  return state;
}

export async function retryInitialPreview(kind: InitialPreviewKind, id: string, baseRevision: string, signal: AbortSignal): Promise<"queued" | "ready"> {
  const response = await API.post(endpoint(kind, id), { baseRevision }, {
    signal, timeout: 60_000, _retry: true,
  } as RetriableAxiosConfig);
  const receipt = response.data?.data;
  const ready = receipt?.job_status === "done" && receipt?.preview_available === true;
  if (response.status !== 202 || receipt?.reportId !== id || receipt?.retry_stage !== "initial_preview" ||
    (!ready && !["queued", "processing"].includes(receipt?.job_status))) {
    throw new Error("Retry confirmation was not received. Refresh this report to check whether processing started.");
  }
  return ready ? "ready" : "queued";
}
