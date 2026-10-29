import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Auctioneer2ClientError,
  getContractScheduleAItems,
  submitLot,
} from "../src/service/auctioneer2Client.js";

const ENV_KEYS = ["AUCTIONEER2_API_BASE_URL", "AUCTIONEER2_API_KEY", "AUCTIONEER2_FEATURE_ENABLED"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("Auctioneer 2.0 Schedule A items (owner 2026-10-28)", () => {
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

  it("reads the contract's items in Schedule A order with string ids", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({
      success: true, contractId: "contract/1", hasScheduleA: true,
      items: [
        { lineId: 22, title: "Misc Shop Tools", severalLots: true, parentLotId: "lot-tools", lotCount: 1, sortOrder: 2 },
        { lineId: "line-ford", title: "2021 Ford F150", severalLots: false, parentLotId: null, lotCount: 0, sortOrder: 1 },
        { title: "No line id", severalLots: true, parentLotId: "lot-x", sortOrder: 0 },
        "not an item",
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getContractScheduleAItems("contract/1")).resolves.toEqual({
      contractId: "contract/1", hasScheduleA: true,
      items: [
        { lineId: "line-ford", title: "2021 Ford F150", severalLots: false, parentLotId: null, lotCount: 0, sortOrder: 1 },
        { lineId: "22", title: "Misc Shop Tools", severalLots: true, parentLotId: "lot-tools", lotCount: 1, sortOrder: 2 },
      ],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://auctioneer.example/api/external/contracts/contract%2F1/schedule-a-items");
    expect(init.method).toBeUndefined();
    expect((init.headers as Headers).get("X-API-Key")).toBe("test-secret");
  });

  it.each([
    ["an unsuccessful body", { success: false, hasScheduleA: true, items: [] }],
    ["another contract", { success: true, contractId: "contract-2", hasScheduleA: true, items: [] }],
    ["no hasScheduleA flag", { success: true, contractId: "contract-1", items: [] }],
    ["no item list", { success: true, contractId: "contract-1", hasScheduleA: false }],
  ])("refuses %s", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(body)));
    await expect(getContractScheduleAItems("contract-1")).rejects.toMatchObject({
      statusCode: 502, code: "auctioneer2_invalid_response",
    });
  });

  it("reports an older Auctioneer without the route as an upstream error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Not found", { status: 404 })));
    const error = await getContractScheduleAItems("contract-1").catch((caught) => caught);
    expect(error).toBeInstanceOf(Auctioneer2ClientError);
    expect(error).toMatchObject({ upstreamStatus: 404, code: "auctioneer2_upstream_error" });
  });

  it.each([
    ["SCHEDULE_A_ITEM_REQUIRED", "Choose the Schedule A item for the lot, then send again."],
    ["SCHEDULE_A_ITEM_NOT_SEVERAL_LOTS", "Ask the office to tick Several lots on that item, then retry sending."],
  ])("explains Auctioneer's %s refusal of a new lot", async (code, sentence) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ success: false, code, message: "provider wording test-secret" }, 409)));
    const error = await submitLot({ contractId: "contract-1" }).catch((caught) => caught);
    expect(error).toBeInstanceOf(Auctioneer2ClientError);
    expect(error).toMatchObject({ statusCode: 409, upstreamStatus: 409, code, ambiguousWrite: false });
    expect(error.message.startsWith(`${code}: `)).toBe(true);
    expect(error.message).toContain(sentence);
    expect(error.message).not.toContain("test-secret");
  });
});
