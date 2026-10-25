import API from "@/lib/api";
import { pendingBrowserActivity, acknowledgeBrowserActivity } from "@/components/forms/drafts/storage";

/** Only operational metadata is sent; never starts photo uploads or report jobs. */
export function startReportActivitySync(owner: string) {
  let closed = false, running = false;
  let controller: AbortController | undefined;
  async function sync() {
    if (closed || running || document.visibilityState !== "visible" || !navigator.onLine) return;
    running = true;
    try {
      for (let i = 0; i < 10 && !closed && document.visibilityState === "visible"; i++) {
        const events = await pendingBrowserActivity(owner);
        if (!events.length || closed) break;
        controller = new AbortController();
        const response = await API.post("/report-activity/events", { ownerId: owner, events }, { signal: controller.signal, timeout: 15000 });
        if (closed) return;
        const acknowledgements = response.data?.data?.acknowledgements;
        if (!Array.isArray(acknowledgements)) break;
        const sent = new Set(events.map(event => event.eventId));
        const ids = acknowledgements.filter((ack: { eventId: string }) => sent.has(ack.eventId)).map((ack: { eventId: string }) => ack.eventId);
        await acknowledgeBrowserActivity(owner, ids);
        if (ids.length !== events.length) break;
      }
    } catch { /* The same IDs remain durable after a lost acknowledgement. */ }
    finally { running = false; }
  }
  const wake = () => { if (document.visibilityState !== "visible") controller?.abort(); else void sync(); };
  const timer = window.setInterval(() => void sync(), 30000);
  window.addEventListener("online", wake); document.addEventListener("visibilitychange", wake);
  void sync();
  return () => { closed = true; controller?.abort(); window.clearInterval(timer); window.removeEventListener("online", wake); document.removeEventListener("visibilitychange", wake); };
}
