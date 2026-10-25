import { describe, expect, it } from "vitest";
import {
  legacyReportContractRegex,
  normalizeReportContractKey,
} from "../src/utils/reportContractIdentity.js";
import { resolveSubmissionContractClaim } from "../src/service/reportSubmissionConflictService.js";

describe("report contract identity", () => {
  it("normalizes compatible Unicode, case, and whitespace to one identity", () => {
    expect(normalizeReportContractKey("  ＡＢＣ\t １２３  ")).toBe("abc 123");
    expect(normalizeReportContractKey("ABC 123")).toBe("abc 123");
  });

  it("builds an anchored compatibility match for pre-key records", () => {
    const expression = legacyReportContractRegex("  Contract   A.100  ");
    expect(expression?.test("CONTRACT\tA.100")).toBe(true);
    expect(expression?.test("Contract A-100")).toBe(false);
    expect(expression?.test("Contract A.100 extra")).toBe(false);
  });

  it("never turns a contract number into a submission claim", () => {
    expect(
      resolveSubmissionContractClaim({ contractNo: " ＡＢＣ  １２３ " })
    ).toBeUndefined();
    expect(
      resolveSubmissionContractClaim({ contractNo: "ABC 123", forceNew: true })
    ).toBeUndefined();
    expect(
      resolveSubmissionContractClaim({ contractNo: "ABC 123", draftPreview: true })
    ).toBeUndefined();
  });
});
