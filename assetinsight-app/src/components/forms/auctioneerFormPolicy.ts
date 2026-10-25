import type { MixedLot } from '../camera/types';
import type { AuctioneerWorkItemSetup } from '../../services/auctioneerService';

export function auctioneerSeedLots(setup: AuctioneerWorkItemSetup): MixedLot[] {
  const count = setup.kind === 'scheduleA' ? setup.lots.length : 0;
  return Array.from({ length: count }, (_, index) => ({
    id: `auctioneer-${setup.workItemId}-${index + 1}`,
    mode: 'single_lot' as const,
    files: [], extraFiles: [], coverIndex: 0,
  }));
}

export function hasValidAuctioneerLotStructure(setup: AuctioneerWorkItemSetup | undefined, lots: MixedLot[]): boolean {
  if (!setup || setup.kind !== 'scheduleA') return true;
  return lots.length === setup.lots.length && lots.every((lot, index) =>
    lot.id === `auctioneer-${setup.workItemId}-${index + 1}` && lot.mode === 'single_lot');
}

export function auctioneerLotSource(setup: AuctioneerWorkItemSetup | undefined, index: number) {
  const source = setup?.kind === 'scheduleA' ? setup.lots[index] : undefined;
  return source ? {
    source_key: source.sourceKey,
    source_lot_id: source.lotId,
    source_submission_id: source.submissionId,
  } : {};
}

export function acceptedAuctioneerReportId(value: unknown): string | undefined {
  const reportId = value && typeof value === 'object' ? (value as { reportId?: unknown }).reportId : undefined;
  return typeof reportId === 'string' && reportId.trim() ? reportId.trim() : undefined;
}
