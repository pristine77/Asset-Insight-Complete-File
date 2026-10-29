/**
 * A Proposal worked item by item (owner 2026-10-28).
 *
 * The office uploads a Schedule A list onto a Proposal, assigns ticked items to
 * Asset Insight users (several users per list) and pushes them. Each user sees
 * the Proposal with only their own items, captures each one (photos, condition
 * report) and returns it to Auctioneer against its listed item. Nothing
 * returned at this stage becomes an Auctioneer lot: the office approves the
 * list, and the contract then runs the regular Schedule A flow.
 *
 * The owner's three outcomes for what comes back, in Auctioneer's colours:
 *   green  a listed item, captured — returned with its scheduleALineId;
 *   red    a listed item the user could not find — returned with notFound;
 *   blue   an item that was not on the list, added in Asset Insight —
 *          returned without a scheduleALineId.
 * A listed item that is neither stays outstanding. Auctioneer takes the
 * Proposal out of the queue once every listed item is green or red.
 *
 * How a report lot names its listed item: the form seeds one lot per listed
 * item with source_key = proposalItemSourceKey(lineId). That key travels the
 * same path a Schedule A line's key already does (submission, preview job,
 * preview edits) as auctioneer_source_key, so no new per-lot field had to be
 * carried through every report pipeline. Any other key is an extra (blue).
 *
 * Pure helpers only; the integration, report-link and delivery services share
 * them so all three agree on which lot is which item.
 */
import { createHash } from "crypto";
import type { Auctioneer2ScheduleAItem } from "./auctioneer2Client.js";
import type {
  IAuctioneerProposalItem,
  IAuctioneerWorkItem,
} from "../models/auctioneerWorkItem.model.js";

export const PROPOSAL_ITEM_SOURCE_PREFIX = "proposal-line:";
export const PROPOSAL_ITEM_INVALID_CODE = "AUCTIONEER_PROPOSAL_ITEM_INVALID";
export const PROPOSAL_ITEM_INVALID_MESSAGE =
  "One of the listed Proposal items in this form is no longer assigned to you, or appears twice. Reopen the Proposal from Incoming and try again.";

/** Auctioneer keeps proposalItemRef to 64 characters. */
const PROPOSAL_ITEM_REF_MAX = 64;
/** Auctioneer keeps a returned item's description to 500 characters. */
const PROPOSAL_DESCRIPTION_MAX = 500;

function clean(value: unknown): string {
  return typeof value === "string"
    ? value.trim()
    : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : "";
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

type ProposalWorkItem = Pick<IAuctioneerWorkItem, "proposalList"> | null | undefined;

/** True for a work item created from a Proposal's list (see the module comment). */
export function isProposalListWorkItem(workItem: ProposalWorkItem | { proposalList?: unknown }): boolean {
  return Boolean(workItem && (workItem as { proposalList?: unknown }).proposalList);
}

export function proposalItemSourceKey(lineId: string): string {
  return `${PROPOSAL_ITEM_SOURCE_PREFIX}${clean(lineId)}`;
}

/** The listed item a report lot's source key names, or "" for anything else. */
export function proposalLineIdFromSourceKey(sourceKey: unknown): string {
  const key = clean(sourceKey);
  return key.startsWith(PROPOSAL_ITEM_SOURCE_PREFIX)
    ? key.slice(PROPOSAL_ITEM_SOURCE_PREFIX.length).trim()
    : "";
}

/**
 * The proposalItemRef of a listed item. Derived from the contract and the
 * line, not from the work item, so whichever of this user's reports returns
 * the item, Auctioneer replaces the earlier return instead of keeping two —
 * including a not-found item that turned up after all.
 */
export function proposalListedItemRef(contractId: string, lineId: string): string {
  return `ai-line-${hash(`${clean(contractId)}:${clean(lineId)}`).slice(0, 40)}`;
}

/**
 * The proposalItemRef of an item that was not on the list: the same
 * reference /lots/submit receives as contractLotRef for an Unknown lot, so a
 * retried delivery replaces rather than duplicates it.
 */
export function proposalExtraItemRef(clientSubmissionId: string, lotIndex: number): string {
  const ref = `${clean(clientSubmissionId)}:${lotIndex + 1}`;
  return ref.length <= PROPOSAL_ITEM_REF_MAX
    ? ref
    : `ai-extra-${hash(ref).slice(0, 40)}`;
}

/**
 * True when Auctioneer described the items as a Proposal's list. Only a
 * Proposal's items say whether they were pushed (sentToAssetInsight); a
 * Schedule A list, or an Auctioneer that predates Proposal lists, never does,
 * and is never mistaken for one.
 */
export function isProposalListResponse(items: readonly Auctioneer2ScheduleAItem[]): boolean {
  return items.some((item) => typeof item.sentToAssetInsight === "boolean");
}

/**
 * The items Auctioneer says were pushed to this user. Auctioneer already
 * filters by ?userId=; this checks each item says so itself, so a response
 * that ignored the filter can never hand the user somebody else's items.
 */
export function proposalItemsPushedTo(
  items: readonly Auctioneer2ScheduleAItem[],
  userId: string
): Auctioneer2ScheduleAItem[] {
  const user = clean(userId).toLowerCase();
  return items.filter((item) =>
    item.sentToAssetInsight === true && clean(item.assetInsightUserId).toLowerCase() === user
  );
}

/** A Proposal list as Auctioneer sent it, kept in the work item's own shape. */
export function proposalItemsFromScheduleAItems(
  items: readonly Auctioneer2ScheduleAItem[]
): IAuctioneerProposalItem[] {
  const seen = new Set<string>();
  const result: IAuctioneerProposalItem[] = [];
  for (const item of items) {
    const lineId = clean(item.lineId);
    if (!lineId || seen.has(lineId)) continue;
    seen.add(lineId);
    const optional = (key: keyof IAuctioneerProposalItem, value: unknown) => {
      const text = clean(value);
      return text ? { [key]: text } : {};
    };
    result.push({
      lineId,
      title: clean(item.title) || "Proposal item",
      ...optional("lotNumber", item.lotNumber),
      ...optional("serialNumber", item.serialNumber),
      ...optional("year", item.year),
      ...optional("make", item.make),
      ...optional("model", item.model),
      ...optional("description", item.description),
      returned: item.returned === true || item.notFound === true,
    } as IAuctioneerProposalItem);
  }
  return result;
}

export function sameProposalItems(
  first: readonly IAuctioneerProposalItem[] | null | undefined,
  second: readonly IAuctioneerProposalItem[] | null | undefined
): boolean {
  const key = (items: readonly IAuctioneerProposalItem[] | null | undefined) =>
    JSON.stringify((items || []).map((item) => [
      item.lineId, item.title, item.lotNumber || "", item.serialNumber || "", item.year || "",
      item.make || "", item.model || "", item.description || "", item.returned === true,
    ]));
  return key(first) === key(second);
}

export type ProposalItemState = "outstanding" | "in_other_report" | "returned" | "not_found";

/**
 * Where each of the user's listed items stands, for the form:
 *   not_found        this user returned it as not found (red);
 *   returned         Auctioneer already holds a return for it;
 *   in_other_report  one of this user's other reports, not yet sent, has it;
 *   outstanding      still to be captured — the form offers these.
 * A red item is reported as not_found even though Auctioneer counts it as
 * returned, so the form can say which it was.
 */
export function proposalItemStates(input: {
  items: readonly IAuctioneerProposalItem[];
  notFoundLineIds: ReadonlySet<string>;
  otherReportLineIds: ReadonlySet<string>;
}): Array<IAuctioneerProposalItem & { state: ProposalItemState }> {
  return input.items.map((item) => ({
    ...item,
    state: input.notFoundLineIds.has(item.lineId)
      ? "not_found"
      : item.returned
        ? "returned"
        : input.otherReportLineIds.has(item.lineId)
          ? "in_other_report"
          : "outstanding",
  }));
}

/** The listed items a report's lots capture, in lot order; "" for an extra. */
export function proposalLotLineIds(lots: readonly unknown[]): string[] {
  return lots.map((lot) =>
    lot && typeof lot === "object"
      ? proposalLineIdFromSourceKey((lot as Record<string, unknown>).auctioneer_source_key ??
          (lot as Record<string, unknown>).source_key)
      : ""
  );
}

/** A returned item's description: Auctioneer requires one and keeps 500 characters. */
export function proposalReturnDescription(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    const text = clean(candidate);
    if (text) return text.slice(0, PROPOSAL_DESCRIPTION_MAX);
  }
  return "";
}
