import type { AuctioneerWorkItemSetup } from "@/services/auctioneer";
import type { ReportDraftRecord } from "@/services/reportDrafts";
import type { SavedInput } from "@/services/savedInputs";

export type ReportFormKind = "asset" | "lot-listing";

export type ReportFormHandoff = {
  version: 1;
  kind: ReportFormKind;
  returnTo?: string;
  savedInput?: SavedInput;
  resumeDraft?: ReportDraftRecord;
  resumeLocalDraftScopeId?: string;
  auctioneer?: AuctioneerWorkItemSetup;
};

type RouterLike = {
  push: (href: string) => void;
};

const HANDOFF_KEY = "cv:report-form-handoff:v1";

export function getReportFormPath(kind: ReportFormKind) {
  return kind === "asset" ? "/create/asset" : "/create/lot-listing";
}

export function navigateToReportForm(
  router: RouterLike,
  handoff: Omit<ReportFormHandoff, "version">
) {
  const payload: ReportFormHandoff = { version: 1, ...handoff };
  try {
    window.sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(payload));
  } catch {
    // Route navigation remains available when browser storage is restricted.
  }
  router.push(getReportFormPath(handoff.kind));
}

export function consumeReportFormHandoff(
  kind: ReportFormKind
): ReportFormHandoff | null {
  try {
    const serialized = window.sessionStorage.getItem(HANDOFF_KEY);
    if (!serialized) return null;
    const payload = JSON.parse(serialized) as ReportFormHandoff;
    if (payload?.version !== 1 || payload.kind !== kind) return null;

    // A handoff is intentionally single-use so stale draft state cannot leak
    // into a later report opened from the dashboard.
    window.sessionStorage.removeItem(HANDOFF_KEY);
    return payload;
  } catch {
    window.sessionStorage.removeItem(HANDOFF_KEY);
    return null;
  }
}
