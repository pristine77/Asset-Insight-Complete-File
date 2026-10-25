import { createHash } from "crypto";

export function auctioneer2ActiveContractKey(
  contractId: string,
  assignmentUserId: string,
  cycleKey: string
): string {
  const normalizedContractId = String(contractId || "").trim();
  const normalizedUserId = String(assignmentUserId || "").trim().toLowerCase();
  const normalizedCycleKey = String(cycleKey || "").trim();
  if (!normalizedContractId || !normalizedUserId || !normalizedCycleKey) {
    throw new Error(
      "Auctioneer contract, assignment user, and cycle IDs are required for an active key."
    );
  }
  const digest = createHash("sha256")
    .update(
      `${normalizedContractId}\u0000${normalizedUserId}\u0000${normalizedCycleKey}`
    )
    .digest("hex");
  return `auctioneer2-user:${digest}`;
}
