import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Auctioneer2ClientError,
  getContractScheduleAItems,
  returnProposalReviewItems,
} from "../src/service/auctioneer2Client.js";

const ENV_KEYS = ["AUCTIONEER2_API_BASE_URL", "AUCTIONEER2_API_KEY", "AUCTIONEER2_FEATURE_ENABLED"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("Auctioneer 2.0 Proposal list calls (owner 2026-10-28)", () => {
  beforeEach(() => {
    process.env.AUCTIONEER2_API_BASE_URL = "https://auctioneer.example/api/external";
    process.env.AUCTIONEER2_API_KEY = "test-secret";
    process.env.AUCTIONEER2_FEATURE_ENABLED = "true";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("reads one user's items with what each item is and whether it came back", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      success: true, contractId: "proposal-1", hasScheduleA: true,
      items: [{
        lineId: "line-a", title: "2019 Tractor", severalLots: false, parentLotId: null, lotCount: 0, sortOrder: 1,
        lotNumber: 12, serialNumber: " SN-1 ", year: "2019", make: "Deere", model: "6155R", description: "Cab",
        assetInsightUserId: "user-1", assetInsightUserName: "Pat", sentToAssetInsight: true, returned: false,
      }],
    }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await getContractScheduleAItems("proposal-1", { userId: "user-1" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://auctioneer.example/api/external/contracts/proposal-1/schedule-a-items?userId=user-1");
    expect(result.items).toEqual([{
      lineId: "line-a", title: "2019 Tractor", severalLots: false, parentLotId: null, lotCount: 0, sortOrder: 1,
      lotNumber: "12", serialNumber: "SN-1", year: "2019", make: "Deere", model: "6155R", description: "Cab",
      assetInsightUserId: "user-1", sentToAssetInsight: true, returned: false,
    }]);
  });

  it("refuses a per-user list that holds another user's item", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      success: true, contractId: "proposal-1", hasScheduleA: true,
      items: [{ lineId: "line-c", title: "Other", assetInsightUserId: "user-2", sentToAssetInsight: true }],
    })));
    await expect(getContractScheduleAItems("proposal-1", { userId: "user-1" }))
      .rejects.toMatchObject({ statusCode: 502, code: "auctioneer2_invalid_response" });
  });

  it("returns items to review-items and reads whether the Proposal stayed in the queue", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      success: true, contractId: "proposal-1", reviewItemCount: 2, status: "ProposalInAssetInsight", remainsInAssetInsight: true,
    }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const items = [
      { proposalItemRef: "ai-line-1", scheduleALineId: "line-a", description: "Tractor", photos: ["https://assetinsight.test/1.jpg"] },
      { proposalItemRef: "ai-line-2", scheduleALineId: "line-b", notFound: true as const },
    ];
    await expect(returnProposalReviewItems("proposal-1", { completedBy: "Pat", completedByUserId: "user-1", items }))
      .resolves.toEqual({ contractId: "proposal-1", reviewItemCount: 2, remainsInAssetInsight: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://auctioneer.example/api/external/proposals/proposal-1/review-items");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ completedBy: "Pat", completedByUserId: "user-1", items });
  });

  it("treats a reply without remainsInAssetInsight as unconfirmed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ success: true, contractId: "proposal-1" }, 201)));
    await expect(returnProposalReviewItems("proposal-1", {
      completedBy: "Pat", completedByUserId: "user-1", items: [{ proposalItemRef: "x", description: "Tire" }],
    })).rejects.toMatchObject({ code: "auctioneer2_invalid_response", ambiguousWrite: true });
  });

  it.each([
    "items[0]: Schedule A item \"Customer's tractor\" was not pushed to this Asset Insight user",
    "items[0].scheduleALineId must name one of this Proposal's Schedule A items",
  ])("explains a refused item without echoing Auctioneer's wording: %s", async (error) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error }, 400)));
    const caught = await returnProposalReviewItems("proposal-1", {
      completedBy: "Pat", completedByUserId: "user-1", items: [{ proposalItemRef: "x", scheduleALineId: "line-z", description: "Tire" }],
    }).catch((value) => value);
    expect(caught).toBeInstanceOf(Auctioneer2ClientError);
    expect(caught).toMatchObject({ code: "PROPOSAL_ITEM_NOT_PUSHED", statusCode: 409, upstreamStatus: 400 });
    expect(caught.message).not.toContain("tractor");
  });
});
