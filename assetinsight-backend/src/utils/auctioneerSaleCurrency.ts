/** Shared sale-currency lookup for setup and canonical report creation. */
export function auctioneerSaleCurrency(record: Record<string, any> | null | undefined): string | undefined {
  if (!record || typeof record !== "object") return undefined;
  const value = record.currency != null && record.currency !== "" ? record.currency : record.saleCurrency;
  if (typeof value !== "string") return undefined;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : undefined;
}

/** Older claims retain the provider currency in their frozen raw snapshot. */
export function savedContractCurrency(workItem: {
  contract: { currency?: string };
  snapshot?: { contract?: unknown };
}): string | undefined {
  const saved = auctioneerSaleCurrency(workItem.contract);
  if (saved) return saved;
  const raw = workItem.snapshot?.contract;
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? auctioneerSaleCurrency(raw as Record<string, any>)
    : undefined;
}
