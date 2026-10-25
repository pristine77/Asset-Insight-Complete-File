import { describe, expect, it } from "vitest";
import {
  buildCertificateOfAppraisal,
  resolveAssetCertificateData,
} from "../src/service/docx/builders/certificate.js";

describe("Asset Certificate of Value", () => {
  it("uses explicit FLV and OLV methods and formats the reference certificate slots", async () => {
    const reportData = {
      owner_name: "Sanscon Equipment Ltd.",
      location: "79 Fenmar Drive, North York, ON, M9L 1M3",
      currency: "CAD",
      valuation_data: {
        methods: [
          { method: "FLV", value: 8_558_800 },
          { method: "Orderly Liquidation Value", value: 9_659_850 },
        ],
      },
    };

    const data = resolveAssetCertificateData(reportData);

    expect(data.recipientName).toBe("Sanscon Equipment Ltd.");
    expect(data.recipientAddressLines).toEqual([
      "79 Fenmar Drive,",
      "North York, ON",
      "M9L 1M3",
    ]);
    expect(data.formattedForcedLiquidationValue).toBe("$8,558,800.00");
    expect(data.formattedOrderlyLiquidationValue).toBe("$9,659,850.00");
    expect(data.primarySignatory).toEqual({
      name: "Certified Appraiser",
      role: "Certified Appraiser",
      company: "McDougall Auctioneers Ltd.",
    });
    expect(data.secondarySignatory).toBeUndefined();

    const blocks = await buildCertificateOfAppraisal(
      reportData,
      9_360,
      "July 13, 2026"
    );
    expect(blocks).toHaveLength(7);
  });

  it("derives certificate totals from the same Schedule A values when explicit totals are absent", () => {
    const data = resolveAssetCertificateData({
      client_name: "Acme Industries",
      currency: "CAD",
      lots: [
        {
          lot_number: "001",
          title: "Excavator",
          location: "Regina, SK",
          estimated_value: 100_000,
        },
        {
          lot_number: "002",
          title: "Loader",
          location: "Regina, SK",
          estimated_value: 50_000,
        },
      ],
    });

    expect(data.forcedLiquidationValue).toBe(105_000);
    expect(data.orderlyLiquidationValue).toBe(127_500);
    expect(data.formattedForcedLiquidationValue).toBe("$105,000.00");
    expect(data.formattedOrderlyLiquidationValue).toBe("$127,500.00");
    expect(data.recipientAddressLines[0]).toBe("Regina, SK");
  });

  it("does not repeat a parent lot value for nested catalogue items", () => {
    const data = resolveAssetCertificateData({
      client_name: "Catalogue Client",
      currency: "CAD",
      lots: [
        {
          lot_number: "001",
          title: "Restaurant equipment package",
          estimated_value: 100_000,
          items: [
            { title: "Commercial fryer" },
            { title: "Commercial range" },
          ],
        },
      ],
    });

    expect(data.forcedLiquidationValue).toBe(70_000);
    expect(data.orderlyLiquidationValue).toBe(85_000);
  });

  it("preserves the complete legal owner and certificate address", () => {
    const owner =
      "The Long Form Industrial Equipment Holdings Corporation of Canada Ltd.";
    const address =
      "Suite 1234, 100 Very Long Business Park Boulevard, Toronto, ON, M5V 3A8";
    const data = resolveAssetCertificateData({
      owner_name: owner,
      certificate_address: address,
    });

    expect(data.recipientName).toBe(owner);
    expect(data.recipientAddressLines.join(" ")).toContain("M5V 3A8");
    expect(data.recipientAddressLines.join(" ")).not.toContain("…");
  });

  it("allows certificate signatory overrides without changing the retained two-column layout", () => {
    const data = resolveAssetCertificateData({
      client_name: "Test Client",
      certificate_signatories: [
        {
          name: "Avery Appraiser, CPPA",
          title: "Senior Appraiser",
          company: "Example Appraisals Ltd.",
        },
        {
          name: "Riley Reviewer, CPPA",
          role: "Review Appraiser",
          company: "Example Appraisals Ltd.",
        },
      ],
      total_forced_liquidation_value: 70_000,
      total_orderly_liquidation_value: 85_000,
    });

    expect(data.primarySignatory).toEqual({
      name: "Avery Appraiser, CPPA",
      role: "Senior Appraiser",
      company: "Example Appraisals Ltd.",
    });
    expect(data.secondarySignatory).toEqual({
      name: "Riley Reviewer, CPPA",
      role: "Review Appraiser",
      company: "Example Appraisals Ltd.",
    });
  });
});
