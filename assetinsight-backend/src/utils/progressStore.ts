// Simple in-memory progress store with TTL cleanup
// Note: This is per-process and will reset on server restart. For production, use Redis or DB.

export type ProgressPhase = "upload" | "processing" | "done" | "error";

export type StepRec = {
  key: string;
  label: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
};

export type ProgressRecord = {
  id: string;
  phase: ProgressPhase;
  createdAt: number;
  updatedAt: number;
  steps: StepRec[];
  // Server-only progress (0..1) for the processing part after client upload
  serverProgress01: number;
  message?: string;
  result?: {
    reportId?: string;
    reportType?: string;
    status?: string;
  };
};

const TTL_MS = 30 * 60 * 1000; // 30 minutes
const store = new Map<string, ProgressRecord>();

function cleanup() {
  const now = Date.now();
  for (const [id, rec] of store.entries()) {
    if (now - rec.updatedAt > TTL_MS) store.delete(id);
  }
}

export function startProgress(id: string) {
  const now = Date.now();
  const rec: ProgressRecord = {
    id,
    phase: "processing",
    createdAt: now,
    updatedAt: now,
    steps: [],
    serverProgress01: 0,
  };
  store.set(id, rec);
  cleanup();
  return rec;
}

export function getProgress(id: string) {
  cleanup();
  return store.get(id);
}

export function updateProgress(
  id: string,
  patch: Partial<Pick<ProgressRecord, "phase" | "steps" | "serverProgress01" | "message" | "result">>
) {
  const rec = store.get(id);
  if (!rec) return;
  if (patch.phase) rec.phase = patch.phase;
  if (patch.steps) rec.steps = patch.steps;
  if (typeof patch.serverProgress01 === "number") rec.serverProgress01 = patch.serverProgress01;
  if (typeof patch.message === "string") rec.message = patch.message;
  if (patch.result) rec.result = { ...(rec.result || {}), ...patch.result };
  rec.updatedAt = Date.now();
}

export function endProgress(id: string, ok: boolean, message?: string) {
  const rec = store.get(id);
  if (!rec) return;
  rec.phase = ok ? "done" : "error";
  rec.updatedAt = Date.now();
  if (message) rec.message = message;
}
