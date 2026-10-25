import { describe, expect, it } from "vitest";
import { mergeSubmittedPreviewData } from "./previewSaveMerge";

describe("mergeSubmittedPreviewData", () => {
  it("keeps edited descriptions when a server response contains an older snapshot", () => {
    const result = mergeSubmittedPreviewData(
      {
        server_revision: 3,
        lots: [{ lot_id: "lot-1", description: "Original description", server_value: true }],
      },
      {
        contract_no: "CTR-1",
        lots: [{ lot_id: "lot-1", description: "Updated description" }],
      }
    );

    expect(result.server_revision).toBe(3);
    expect(result.lots[0]).toEqual({
      lot_id: "lot-1",
      description: "Updated description",
      server_value: true,
    });
  });

  it("matches lots by stable identity when server order differs", () => {
    const result = mergeSubmittedPreviewData(
      {
        lots: [
          { lot_id: "lot-2", description: "Old second" },
          { lot_id: "lot-1", description: "Old first" },
        ],
      },
      {
        lots: [
          { lot_id: "lot-1", description: "Edited first" },
          { lot_id: "lot-2", description: "Edited second" },
        ],
      }
    );

    expect(result.lots.map((lot: any) => lot.description)).toEqual([
      "Edited second",
      "Edited first",
    ]);
  });

  it("keeps sibling edits distinct when generated lots share an internal id", () => {
    const result = mergeSubmittedPreviewData(
      {
        lots: [
          { lot_id: "duplicate-ai-id", lot_number: "1", description: "Server first" },
          { lot_id: "duplicate-ai-id", lot_number: "2", description: "Server second" },
        ],
      },
      {
        lots: [
          {
            lot_id: "duplicate-ai-id",
            lot_number: "825291",
            description: "First line\nFirst continuation",
          },
          {
            lot_id: "duplicate-ai-id",
            lot_number: "825295",
            description: "Second line\nSecond continuation",
          },
        ],
      }
    );

    expect(
      result.lots.map((lot: any) => [lot.lot_number, lot.description])
    ).toEqual([
      ["825291", "First line\nFirst continuation"],
      ["825295", "Second line\nSecond continuation"],
    ]);
  });
});
