import { describe, expect, it } from "vitest";
import {
  assetPreviewFingerprint,
  matchesAssetGenerationSnapshot,
  stableAssetPreviewJson,
} from "../src/utils/assetGenerationIdentity.js";

describe("Asset generation identity", () => {
  it("excludes the separately revision-fenced PV sheet from generation identity", () => {
    const snapshot = {
      contract_no: "IDENTITY-100",
      lots: [{ lot_id: "lot-1", description: "Accepted review data" }],
    };
    const persisted = {
      ...snapshot,
      admin_schedule_sheet: {
        rows: [{ lot_id: "lot-1", cr_details: "Merged PV projection" }],
      },
    };

    expect(stableAssetPreviewJson(persisted)).toBe(
      stableAssetPreviewJson(snapshot)
    );
    expect(assetPreviewFingerprint(persisted)).toBe(
      assetPreviewFingerprint(snapshot)
    );
    expect(
      matchesAssetGenerationSnapshot(
        {
          preview_data: persisted,
          generation_progress: {
            previewFingerprint: assetPreviewFingerprint(snapshot),
          },
        },
        snapshot
      )
    ).toBe(true);
  });

  it("still detects report-generation edits and only ignores the top-level PV field", () => {
    const accepted = {
      contract_no: "IDENTITY-200",
      lots: [
        {
          lot_id: "lot-2",
          description: "Accepted description",
          admin_schedule_sheet: "ordinary nested source data",
        },
      ],
    };

    expect(
      assetPreviewFingerprint({
        ...accepted,
        lots: [{ ...accepted.lots[0], description: "Different description" }],
      })
    ).not.toBe(assetPreviewFingerprint(accepted));
    expect(
      assetPreviewFingerprint({
        ...accepted,
        lots: [
          {
            ...accepted.lots[0],
            admin_schedule_sheet: "different nested source data",
          },
        ],
      })
    ).not.toBe(assetPreviewFingerprint(accepted));
  });
});
