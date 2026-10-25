import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestHandler } from "express";

type Context = { request?: any; actor?: string; source?: string; action?: string; disabled?: boolean; verifiedLogoReceipts?: Set<string> };
export const reportActivityContext = new AsyncLocalStorage<Context>();
export const reportActivityRequestContext: RequestHandler = (req, res, next) => {
  const context: Context = { request: req, verifiedLogoReceipts: new Set() };
  res.once("finish", () => {
    if (res.statusCode < 400 || !["POST", "PUT", "PATCH", "DELETE"].includes(req.method) ||
        !/^\/api\/(?:asset|lot-listing)\/[a-f\d]{24}(?:\/|$)/i.test(req.originalUrl)) return;
    // A rejected HTTP request is not a successful report transition. Its bounded
    // observation must never change the response or any workflow fields.
    void import("../service/reportActivityService.js").then(({ recordRejectedActivityRequest }) =>
      reportActivityContext.run(context, () => recordRejectedActivityRequest(req, res.statusCode)))
      .catch(() => console.warn("Rejected-request activity could not be recorded; report state was not changed."));
  });
  reportActivityContext.run(context, next);
};
export const withoutReportActivity = <T>(work: () => T): T => reportActivityContext.run({ disabled: true }, work);
export function currentActivityContext() {
  const context = reportActivityContext.getStore();
  const req = context?.request;
  const suppliedSource = req?.get?.("X-Activity-Source");
  const source = ["web", "android", "ios", "admin"].includes(suppliedSource) ? suppliedSource : context?.source || "unknown";
  const suppliedId = req?.get?.("X-Activity-Id");
  const version = req?.get?.("X-App-Version");
  return {
    enabled: !!context && !context.disabled,
    disabled: context?.disabled === true,
    actor: String(req?.userId || req?.user?._id || context?.actor || "") || null,
    actorRole: req?.user?.role || (context?.actor ? "user" : "system"),
    device: req?.deviceId || null,
    appVersion: ["android", "ios"].includes(source) && typeof version === "string" && /^[A-Za-z0-9 ._()+-]{1,80}$/.test(version) && version.trim() !== "unknown" ? version.trim() : null,
    source: req?.originalUrl?.startsWith("/api/admin/") ? "admin" : source,
    activityId: typeof suppliedId === "string" && /^[a-zA-Z0-9._:-]{1,160}$/.test(suppliedId) ? suppliedId : undefined,
    path: String(req?.path || ""),
    method: String(req?.method || ""),
    action: context?.action,
    verifiedLogoReceipts: context?.verifiedLogoReceipts?.size || null,
  };
}
