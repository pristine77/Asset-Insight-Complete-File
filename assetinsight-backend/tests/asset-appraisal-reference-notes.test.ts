import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  collectCoverPhotoUrls,
  hasExplicitCoverPhotoSelection,
  prepareCoverPhoto,
  resolveCoverPhotoSlotSources,
} from "../src/service/docx/builders/coverPhotos.js";
import {
  buildAppraisalOverview,
  resolveAppraisalOverviewData,
} from "../src/service/docx/builders/appraisalOverview.js";

describe("Asset appraisal annotated-reference corrections", () => {
  it("honors an ordered unique set of owned cover photos and caps it at four", () => {
    const owned = Array.from(
      { length: 6 },
      (_, index) => `https://example.test/owned-${index + 1}.jpg`
    );
    const urls = collectCoverPhotoUrls({
      imageUrls: owned,
      cover_image_urls: [
        owned[4],
        "https://untrusted.example/outsider.jpg",
        owned[1],
        owned[4],
        owned[5],
        owned[0],
        owned[2],
      ],
      lots: [{ image_url: owned[3], image_urls: owned }],
    });

    expect(urls).toEqual([owned[4], owned[1], owned[5], owned[0]]);
  });

  it("uses automatic lot-first cover selection when the saved choice is empty", () => {
    const primary = "https://example.test/lot-primary.jpg";
    expect(
      collectCoverPhotoUrls({
        cover_image_urls: [],
        imageUrls: [primary],
        lots: [{ image_url: primary }],
      })
    ).toEqual([primary]);
  });

  it("uses one explicitly selected cover photo once and leaves the other slots blank", () => {
    const selected = "https://example.test/selected-one.jpg";
    const reportData = {
      imageUrls: [selected],
      cover_image_urls: [selected],
    };

    expect(hasExplicitCoverPhotoSelection(reportData)).toBe(true);
    expect(
      resolveCoverPhotoSlotSources(
        [selected],
        4,
        !hasExplicitCoverPhotoSelection(reportData)
      )
    ).toEqual([selected, null, null, null]);
  });

  it("uses two explicitly selected cover photos once each in their saved order", () => {
    const selected = [
      "https://example.test/selected-two-b.jpg",
      "https://example.test/selected-two-a.jpg",
    ];
    const reportData = {
      imageUrls: [...selected].reverse(),
      cover_image_urls: selected,
    };

    expect(hasExplicitCoverPhotoSelection(reportData)).toBe(true);
    expect(
      resolveCoverPhotoSlotSources(
        selected,
        4,
        !hasExplicitCoverPhotoSelection(reportData)
      )
    ).toEqual([selected[0], selected[1], null, null]);
  });

  it("retains fixed-slot repetition for automatic empty or invalid selections", () => {
    const automaticPhotos = ["automatic-a", "automatic-b"];
    const emptySelection = {
      imageUrls: automaticPhotos,
      cover_image_urls: [],
    };
    const invalidSelection = {
      imageUrls: automaticPhotos,
      cover_image_urls: ["unowned-photo"],
    };

    expect(hasExplicitCoverPhotoSelection(emptySelection)).toBe(false);
    expect(hasExplicitCoverPhotoSelection(invalidSelection)).toBe(false);
    expect(resolveCoverPhotoSlotSources(automaticPhotos, 4, true)).toEqual([
      automaticPhotos[0],
      automaticPhotos[1],
      automaticPhotos[0],
      automaticPhotos[1],
    ]);
  });

  it("uses each lot's primary photo before remaining lot and report photos", () => {
    const urls = collectCoverPhotoUrls({
      lots: [
        {
          image_url: "https://example.test/lot-1-primary.jpg",
          image_urls: [
            "https://example.test/lot-1-primary.jpg",
            "https://example.test/lot-1-extra.jpg",
          ],
        },
        {
          image_url: "https://example.test/lot-2-primary.jpg",
          extra_image_urls: ["https://example.test/lot-2-extra.jpg"],
        },
      ],
      imageUrls: ["https://example.test/report-fallback.jpg"],
    });

    expect(urls).toEqual([
      "https://example.test/lot-1-primary.jpg",
      "https://example.test/lot-2-primary.jpg",
      "https://example.test/lot-1-extra.jpg",
      "https://example.test/lot-2-extra.jpg",
    ]);
  });

  it("fits and normalizes a source photo to the exact cover-template slot", async () => {
    const source = await sharp({
      create: {
        width: 80,
        height: 160,
        channels: 3,
        background: "#cc1f2f",
      },
    })
      .jpeg()
      .toBuffer();

    const prepared = await prepareCoverPhoto(source, 320, 120);
    const metadata = await sharp(prepared).metadata();

    expect(metadata.width).toBe(320);
    expect(metadata.height).toBe(120);
    expect(metadata.format).toBe("png");
    const pixel = await sharp(prepared)
      .removeAlpha()
      .raw()
      .toBuffer();
    expect(pixel[0]).toBe(pixel[1]);
    expect(pixel[1]).toBe(pixel[2]);
  });

  it("maps report data into the old appraisal's three clean overview sections", () => {
    const reportData = {
      owner_name: "Sanscon Equipment Ltd.",
      industry: "construction",
      locations_inspected: ["Regina, SK", "Emerald Park, SK"],
      company_contacts: "Jordan Smith",
      contact_phone: "(306) 555-0100",
      contact_email: "jordan@example.test",
      company_website: "https://sanscon.example.test",
      head_office_address: "79 Fenmar Drive, North York, ON, M9L 1M3",
      valuation_date: "2026-07-13T00:00:00.000Z",
      inspection_date: "2026-07-02T00:00:00.000Z",
      effective_date: "2026-07-13T00:00:00.000Z",
      asset_type: "construction equipment",
      asset_condition: "good",
      valuation_data: {
        methods: [
          { fullName: "Forced Liquidation Value" },
          { fullName: "Orderly Liquidation Value" },
        ],
      },
    };

    const data = resolveAppraisalOverviewData(reportData);

    expect(data.companyRows).toEqual([
      { label: "Owner Name", value: "Sanscon Equipment Ltd." },
      { label: "Industry", value: "Construction" },
      {
        label: "Locations Inspected",
        value: "Regina, SK, Emerald Park, SK",
      },
      {
        label: "Company Contacts",
        value: "Jordan Smith | (306) 555-0100 | jordan@example.test",
      },
      {
        label: "Company Website",
        value: "https://sanscon.example.test",
      },
      {
        label: "Head Office Address",
        value: "79 Fenmar Drive, North York, ON, M9L 1M3",
      },
    ]);
    expect(data.appraisalRows[0]).toEqual({
      label: "Method of Valuation",
      value: "Forced Liquidation Value & Orderly Liquidation Value",
    });
    expect(data.assetRows).toEqual([
      { label: "Asset Type", value: "Construction Equipment" },
      { label: "Asset Condition", value: "Good" },
    ]);
    expect(buildAppraisalOverview(reportData, 10_080)).toHaveLength(6);
  });
});
