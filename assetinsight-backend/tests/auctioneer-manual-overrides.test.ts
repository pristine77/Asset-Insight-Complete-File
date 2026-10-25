import { describe, expect, it } from "vitest";

import {
  applyAuctioneerManualSpecOverrides,
  buildAuctioneerSpecRows,
} from "../src/utils/auctioneerSpecRows.js";

describe("manual condition-report overrides", () => {
  it("preserves the administrator's exact capitalization", () => {
    const rows = buildAuctioneerSpecRows({
      categories: "Aerial Work Platforms",
      condition_report_specs: { "Lift Type": "Scissor lift" },
      condition_report_specs_manual_overrides: { "Lift Type": "Scissor Lift" },
    });

    expect(rows.find((row) => row.field === "Lift Type")?.value).toBe("Scissor Lift");
  });

  it("applies canonical aliases after generated values", () => {
    const result = applyAuctioneerManualSpecOverrides(
      {
        "Working Condition": "Unverified Running Condition",
        "Fuel Type": "Diesel",
      },
      {
        "Running Condition": "Starts and Runs",
        "Fuel Type": "Gasoline",
      }
    );

    expect(result).toMatchObject({
      "Running Condition": "Starts and Runs",
      "Fuel Type": "Gasoline",
    });
    expect(result["Working Condition"]).toBeUndefined();
  });

  it("keeps an intentional blank as a tombstone over generated data", () => {
    const result = applyAuctioneerManualSpecOverrides(
      { "Serial Number": "CA102717-054" },
      { "Serial Number": "" }
    );

    expect(result).toHaveProperty("Serial Number", "");
  });
});
