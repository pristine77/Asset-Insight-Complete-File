// The local-save layer does not import native networking/authentication services.
let handoff: (() => Promise<void>) | undefined;
export function registerBackupHandoff(work: () => Promise<void>) {
  handoff = work;
  return () => { if (handoff === work) handoff = undefined; };
}
export async function flushBackupHandoff() {
  if (!handoff) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([handoff(), new Promise<void>(resolve => { timeout = setTimeout(resolve, 5000); })]);
  } catch { /* Local SQLite outbox remains durable; the backup UI reports retry status. */ }
  finally { if (timeout) clearTimeout(timeout); }
}
