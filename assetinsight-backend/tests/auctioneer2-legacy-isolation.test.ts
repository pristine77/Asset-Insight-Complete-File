import { describe, expect, it, vi } from "vitest";
import { pushAuctionsoftLotListingIfReady } from "../src/service/auctionsoftLotListingPush.js";

describe("Auctioneer 2.0 legacy integration isolation", () => {
  it("never starts the legacy Auctionsoft push for a linked report", async () => {
    const save = vi.fn(() => {
      throw new Error("legacy push should not persist or send");
    });

    await expect(
      pushAuctionsoftLotListingIfReady({
        auctioneerWorkItem: "auctioneer-work-item",
        auctionsoft: { taskId: "forged-legacy-task" },
        status: "approved",
        save,
      })
    ).resolves.toBeUndefined();
    expect(save).not.toHaveBeenCalled();
  });
});
