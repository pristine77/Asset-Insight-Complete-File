import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import API from "@/lib/api";
import {
  AuctioneerService,
  type AuctioneerProposalItem,
  type AuctioneerWorkItemSetup,
} from "@/services/auctioneer";
import ProposalListField from "./ProposalListField";
import { buildAuctioneerSeedLots, proposalItemLot } from "./auctioneerSeed";

/*
   Owner 2026-10-28: a Proposal's list, pushed item by item. Listed items are
   captured one lot each (green), returned as not found at once (red), and
   lots the user adds are items that were not listed (blue).
*/

vi.mock("@/lib/api", () => ({ default: { get: vi.fn(), post: vi.fn() } }));
vi.mock("@/components/ui/toast", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const item = (lineId: string, state: AuctioneerProposalItem["state"], extra: Partial<AuctioneerProposalItem> = {}) => ({
  lineId, sourceKey: `proposal-line:${lineId}`, title: `Item ${lineId}`, state, ...extra,
});

function setup(items: AuctioneerProposalItem[]): AuctioneerWorkItemSetup {
  return {
    workItemId: "work-1", cycleKey: "cycle-1", kind: "unknown", reportType: "asset",
    contract: { id: "proposal-1", contractNo: "P-100", customerName: "Customer", eventTitle: "Sale", location: "Regina" },
    lots: [], requiresScheduleAItem: false, scheduleAChoices: [], proposalList: { items },
  };
}

describe("Proposal list on the website (owner 2026-10-28)", () => {
  beforeEach(() => {
    vi.mocked(API.get).mockReset();
    vi.mocked(API.post).mockReset();
  });

  it("starts the form with one fixed-mode lot per listed item still to capture", () => {
    const integration = setup([
      item("a", "outstanding", { lotNumber: "12", serialNumber: "SN-1", year: "2019", make: "Deere" }),
      item("b", "returned"),
      item("c", "not_found"),
      item("d", "in_other_report"),
      item("e", "outstanding"),
    ]);
    const lots = buildAuctioneerSeedLots(integration);
    expect(lots.map((lot) => lot.source?.key)).toEqual(["proposal-line:a", "proposal-line:e"]);
    expect(lots[0]).toMatchObject({
      mode: "single_lot",
      source: { label: "Lot 12", title: "Item a", locked: false, listed: true, description: "2019 Deere · Serial/VIN SN-1" },
    });
    expect(lots[1].source?.label).toBe("Listed item");
  });

  it("starts like an Unknown Lots form when nothing is left to capture, and leaves other work alone", () => {
    const done = buildAuctioneerSeedLots(setup([item("b", "returned")]));
    expect(done).toHaveLength(1);
    expect(done[0].source).toMatchObject({ key: "work-1:unknown:1", locked: false });
    expect(done[0].source?.listed).toBeUndefined();
    const plain = { ...setup([]), proposalList: undefined, lots: [{ sourceKey: "s1", title: "Trailer" }] };
    expect(buildAuctioneerSeedLots(plain)[0].source).toMatchObject({ key: "s1", locked: false });
  });

  it("shows each item's state and puts a removed item back into the form", () => {
    const integration = setup([item("a", "outstanding"), item("b", "outstanding"), item("c", "returned"), item("d", "not_found"), item("e", "in_other_report")]);
    const onAddItem = vi.fn();
    render(
      <ProposalListField id="proposal" integration={integration} lots={[proposalItemLot(integration, integration.proposalList!.items[0])]}
        onAddItem={onAddItem} onItemNotFound={vi.fn()} />
    );
    expect(screen.getByText("In this form")).toBeTruthy();
    expect(screen.getByText("Returned")).toBeTruthy();
    expect(screen.getByText("Returned as not found")).toBeTruthy();
    expect(screen.getByText("In another report")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add to form" }));
    expect(onAddItem).toHaveBeenCalledWith(expect.objectContaining({ lineId: "b" }));
    // Only items still to capture can be marked not found.
    expect(screen.getAllByRole("button", { name: "Not found" })).toHaveLength(2);
  });

  it("returns an item as not found only after confirmation, then drops its lot", async () => {
    const integration = setup([item("a", "outstanding"), item("b", "outstanding")]);
    vi.mocked(API.post).mockResolvedValueOnce({ data: { success: true, data: {
      notFound: ["a"], remainsInAssetInsight: true,
      setup: { ...integration, proposalList: { items: [item("a", "not_found"), item("b", "outstanding")] } },
    } } });
    const onItemNotFound = vi.fn();
    render(
      <ProposalListField id="proposal" integration={integration} lots={buildAuctioneerSeedLots(integration)}
        onAddItem={vi.fn()} onItemNotFound={onItemNotFound} />
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Not found" })[0]);
    expect(API.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Return as not found" }));
    await waitFor(() => expect(onItemNotFound).toHaveBeenCalledWith(expect.objectContaining({ lineId: "a" })));
    expect(API.post).toHaveBeenCalledWith(
      "/auctioneer/work-items/work-1/proposal-items/not-found",
      { lineIds: ["a"] },
      expect.any(Object)
    );
    expect(await screen.findByText("Returned as not found")).toBeTruthy();
  });

  it("keeps the lot when Auctioneer refuses the not-found return", async () => {
    const integration = setup([item("a", "outstanding")]);
    vi.mocked(API.post).mockRejectedValueOnce({ response: { status: 409, data: { code: "auctioneer_proposal_item_not_outstanding", message: "This item was already returned." } } });
    const onItemNotFound = vi.fn();
    render(
      <ProposalListField id="proposal" integration={integration} lots={buildAuctioneerSeedLots(integration)}
        onAddItem={vi.fn()} onItemNotFound={onItemNotFound} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Not found" }));
    fireEvent.click(screen.getByRole("button", { name: "Return as not found" }));
    const { toast } = await import("@/components/ui/toast");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("This item was already returned."));
    expect(onItemNotFound).not.toHaveBeenCalled();
  });

  it("reads the list from setup defensively and leaves setups without one unchanged", async () => {
    vi.mocked(API.get).mockResolvedValueOnce({ data: { success: true, data: {
      workItemId: "work-1", kind: "unknown", reportType: "asset", contract: { id: "proposal-1", contractNo: "P-100" }, lots: [],
      proposalList: { items: [
        { lineId: "a", sourceKey: "proposal-line:a", title: " Tractor ", lotNumber: 12, state: "outstanding" },
        { lineId: "a", sourceKey: "proposal-line:a", title: "Repeat", state: "outstanding" },
        { lineId: "b", title: "No key", state: "outstanding" },
        { lineId: "c", sourceKey: "proposal-line:c", title: "Future state", state: "something_new" },
      ] },
    } } });
    const listed = await AuctioneerService.getSetup("work-1");
    expect(listed.proposalList?.items).toEqual([
      { lineId: "a", sourceKey: "proposal-line:a", title: "Tractor", lotNumber: "12", state: "outstanding" },
      { lineId: "c", sourceKey: "proposal-line:c", title: "Future state", state: "returned" },
    ]);
    vi.mocked(API.get).mockResolvedValueOnce({ data: { success: true, data: {
      workItemId: "work-2", kind: "unknown", reportType: "asset", contract: { id: "contract-2", contractNo: "C-2" }, lots: [],
    } } });
    expect(await AuctioneerService.getSetup("work-2")).not.toHaveProperty("proposalList");
  });
});
