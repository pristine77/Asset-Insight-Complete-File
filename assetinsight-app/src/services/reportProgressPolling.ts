type Progress = { phase: string; message?: string };

/** Serial polling: no overlapping requests; loss of progress is not upload failure. */
export function pollAcceptedReport({
  load,
  onDone,
  onError,
  onPending,
  intervalMs = 3000,
  maxDurationMs = 10 * 60_000,
  maxFailures = 5,
}: {
  load: () => Promise<Progress>;
  onDone: () => void;
  onError: (message: string) => void;
  onPending: () => void;
  intervalMs?: number;
  maxDurationMs?: number;
  maxFailures?: number;
}) {
  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    clearTimeout(deadline);
  };
  const pending = () => {
    if (stopped) return;
    stop();
    onPending();
  };
  const deadline = setTimeout(pending, maxDurationMs);
  const tick = async () => {
    try {
      const progress = await load();
      if (stopped) return;
      failures = 0;
      if (progress.phase === 'done') {
        stop();
        onDone();
        return;
      }
      if (progress.phase === 'error') {
        stop();
        onError(progress.message || 'The server could not finish this report.');
        return;
      }
    } catch {
      if (stopped) return;
      failures += 1;
      if (failures >= maxFailures) {
        pending();
        return;
      }
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };
  timer = setTimeout(() => void tick(), intervalMs);
  return stop;
}
