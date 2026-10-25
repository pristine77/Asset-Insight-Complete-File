import type { AuctioneerWorkItemSetup } from "@/services/auctioneer";

export function acceptedAuctioneerReportId(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const reportId = (response as { reportId?: unknown }).reportId;
  return typeof reportId === "string" && reportId.trim()
    ? reportId.trim()
    : undefined;
}

export function auctioneerSuccessorState(
  previous: AuctioneerWorkItemSetup,
  next: AuctioneerWorkItemSetup
): "fresh" | "used" | "invalid" {
  if (
    !next.workItemId ||
    !next.contract.id ||
    !next.contract.contractNo ||
    next.workItemId === previous.workItemId ||
    next.reportType !== previous.reportType ||
    next.contract.id !== previous.contract.id ||
    next.contract.contractNo !== previous.contract.contractNo
  ) return "invalid";

  // An idempotent retry can recover a successor already used in another tab.
  // Never present a fresh form under that accepted submission identity.
  if (next.reportId || next.status === "report_created" || next.status === "sent") {
    return "used";
  }

  if (
    next.status !== "claimed" ||
    !next.clientSubmissionId ||
    next.clientSubmissionId === previous.clientSubmissionId ||
    next.kind !== "unknown" ||
    next.lots.length > 0
  ) return "invalid";
  return "fresh";
}
