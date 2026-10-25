/** Event identifiers are opaque; display names, contract IDs and object coercion are not evidence. */
export function normalizeAuctioneerEventId(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

export class AuctioneerEventIdentityError extends Error {
  readonly code = "auctioneer_event_identity_conflict";
  constructor() {
    super("The imported contract contains conflicting auction event IDs. Ask the auction team to check its event before retrying.");
    this.name = "AuctioneerEventIdentityError";
  }
}

export function resolveAuctioneerEventIdentity(values: readonly unknown[]): string | undefined {
  const ids = new Set(values.map(normalizeAuctioneerEventId).filter((id): id is string => id !== undefined));
  if (ids.size > 1) throw new AuctioneerEventIdentityError();
  return ids.values().next().value;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Explicit contract associations only: a task or lot's own id is not its contract. */
export function readAuctioneerContractIdentityCandidates(
  value: unknown,
  options: { standaloneContract?: boolean } = {},
): string[] {
  if (!record(value)) return [];
  const candidates: unknown[] = options.standaloneContract ? [value.id, value._id, value.uuid] : [];
  const contexts = [{ value, depth: 0 }];
  for (const context of contexts) {
    const source = context.value;
    candidates.push(source.contractId, source.contract_id, source.contractGuid, source.contract_guid);
    if (record(source.contract)) candidates.push(source.contract.id, source.contract._id, source.contract.uuid);
    if (context.depth >= 2) continue;
    for (const key of ["lot", "asset", "item", "contract"] as const) {
      const nested = source[key];
      if (record(nested)) contexts.push({ value: nested, depth: context.depth + 1 });
    }
  }
  return [...new Set(candidates.map(normalizeAuctioneerEventId).filter((id): id is string => id !== undefined))];
}

/** Read only event-specific fields in supported provider metadata, never a lot/contract's own id. */
export function readAuctioneerEventIdentity(
  value: unknown,
  options: { standaloneEvent?: boolean } = {},
): string | undefined {
  if (!record(value)) return undefined;
  const candidates: unknown[] = options.standaloneEvent ? [value.id] : [];
  // Two bounded context levels cover task.lot.contract without walking arbitrary payloads.
  const contexts = [{ value, depth: 0 }];
  for (const context of contexts) {
    const source = context.value;
    candidates.push(source.eventId, source.event_id, source.auctionEventId);
    if (record(source.event)) candidates.push(source.event.id);
    if (context.depth >= 2) continue;
    for (const key of ["lot", "asset", "item", "contract"] as const) {
      const nested = source[key];
      if (record(nested)) contexts.push({ value: nested, depth: context.depth + 1 });
    }
  }
  return resolveAuctioneerEventIdentity(candidates);
}
