import { describe, expect, it } from "vitest";
import { getExplicitCoordinates } from "../src/utils/auctionLocations.js";
import { normalizePreviewLotsForBusinessRules } from "../src/utils/previewLotNormalization.js";

const makeLot = () => ({
  lot_id: "lot-1",
  lot_number: "1",
  title: "Test asset",
  description: "Test asset",
});

describe("auction coordinate handling", () => {
  describe("getExplicitCoordinates", () => {
    it.each([
      ["null coordinates", { latitude: null, longitude: null }],
      ["missing longitude", { latitude: 50 }],
      ["missing latitude", { longitude: -104 }],
      ["blank coordinates", { latitude: "  ", longitude: "" }],
      ["latitude above its range", { latitude: 90.0001, longitude: 0 }],
      ["latitude below its range", { latitude: -90.0001, longitude: 0 }],
      ["longitude above its range", { latitude: 0, longitude: 180.0001 }],
      ["longitude below its range", { latitude: 0, longitude: -180.0001 }],
      ["boolean coordinates", { latitude: true, longitude: false }],
      ["array coordinates", { latitude: [50.1], longitude: [-104.2] }],
      ["object coordinates", { latitude: { value: 50.1 }, longitude: { value: -104.2 } }],
      ["symbol coordinates", { latitude: Symbol("50.1"), longitude: Symbol("-104.2") }],
      ["nonnumeric strings", { latitude: "north", longitude: "west" }],
      ["hexadecimal strings", { latitude: "0x32", longitude: "-0x68" }],
      ["scientific-notation strings", { latitude: "5e1", longitude: "-1.04e2" }],
    ])("rejects %s", (_description, input) => {
      expect(getExplicitCoordinates(input)).toBeUndefined();
    });

    it("preserves valid zero coordinates", () => {
      expect(getExplicitCoordinates({ latitude: 0, longitude: 0 })).toEqual({
        latitude: 0,
        longitude: 0,
      });
    });

    it("parses valid numeric strings", () => {
      expect(
        getExplicitCoordinates({
          latitude: " 50.44832 ",
          longitude: " -104.39937 ",
        })
      ).toEqual({ latitude: 50.44832, longitude: -104.39937 });
      expect(
        getExplicitCoordinates({ latitude: "+.5", longitude: "-104." })
      ).toEqual({ latitude: 0.5, longitude: -104 });
    });
  });

  describe("normalizePreviewLotsForBusinessRules", () => {
    it("does not synthesize a browser-location label when only coordinates exist", () => {
      const normalized = normalizePreviewLotsForBusinessRules({
        latitude: 51.5,
        longitude: -105.25,
        lots: [makeLot()],
      });

      expect(normalized).not.toHaveProperty("location");
      expect(normalized).toMatchObject({ latitude: 51.5, longitude: -105.25 });
      expect(normalized.lots[0]).not.toHaveProperty("location");
      expect(normalized.lots[0]).toMatchObject({
        latitude: 51.5,
        longitude: -105.25,
      });
      expect(JSON.stringify(normalized)).not.toContain("Current Browser Location");
    });

    it("preserves a readable location and its valid coordinates", () => {
      const normalized = normalizePreviewLotsForBusinessRules({
        location: "  North storage yard, Bay 3  ",
        latitude: "50.44832",
        longitude: "-104.39937",
        lots: [makeLot()],
      });

      expect(normalized).toMatchObject({
        location: "North storage yard, Bay 3",
        latitude: 50.44832,
        longitude: -104.39937,
      });
      expect(normalized.lots[0]).toMatchObject({
        location: "North storage yard, Bay 3",
        latitude: 50.44832,
        longitude: -104.39937,
      });
    });

    it("does not pair report coordinates with a lot at an independent location", () => {
      const normalized = normalizePreviewLotsForBusinessRules({
        location: "Main Inspection Yard",
        latitude: 50.44832,
        longitude: -104.39937,
        lots: [
          {
            ...makeLot(),
            location: "Independent Storage Site",
          },
        ],
      });

      expect(normalized.lots[0]).toMatchObject({
        location: "Independent Storage Site",
      });
      expect(normalized.lots[0]).not.toHaveProperty("latitude");
      expect(normalized.lots[0]).not.toHaveProperty("longitude");
    });

    it.each([
      "Current Browser Location",
      "Lat: 50.44832 / Long: -104.39937",
    ])("strips the non-readable location label %j but retains valid coordinates", (location) => {
      const normalized = normalizePreviewLotsForBusinessRules({
        location,
        latitude: 50.44832,
        longitude: -104.39937,
        lots: [makeLot()],
      });

      expect(normalized).not.toHaveProperty("location");
      expect(normalized).toMatchObject({
        latitude: 50.44832,
        longitude: -104.39937,
      });
      expect(normalized.lots[0]).not.toHaveProperty("location");
      expect(normalized.lots[0]).toMatchObject({
        latitude: 50.44832,
        longitude: -104.39937,
      });
    });

    it("clears an old root coordinate pair and inherited lot coordinates after a readable place-name edit", () => {
      const previousPreviewData = {
        location: "Old Inspection Yard",
        latitude: 50.1,
        longitude: -104.2,
      };
      const normalized = normalizePreviewLotsForBusinessRules(
        {
          location: "New Inspection Yard",
          latitude: 50.1,
          longitude: -104.2,
          lots: [
            {
              ...makeLot(),
              location: "Old Inspection Yard",
              latitude: 50.1,
              longitude: -104.2,
            },
            {
              ...makeLot(),
              lot_id: "independent-lot",
              location: "Independent Storage Site",
              latitude: 49.8,
              longitude: -97.1,
            },
          ],
        },
        { previousPreviewData }
      );

      expect(normalized).toMatchObject({ location: "New Inspection Yard" });
      expect(normalized).not.toHaveProperty("latitude");
      expect(normalized).not.toHaveProperty("longitude");
      expect(normalized.lots[0]).toMatchObject({
        location: "New Inspection Yard",
      });
      expect(normalized.lots[0]).not.toHaveProperty("latitude");
      expect(normalized.lots[0]).not.toHaveProperty("longitude");
      expect(normalized.lots[1]).toMatchObject({
        location: "Independent Storage Site",
        latitude: 49.8,
        longitude: -97.1,
      });
    });

    it("preserves a fresh coordinate pair consistently supplied with a changed readable place", () => {
      const normalized = normalizePreviewLotsForBusinessRules(
        {
          location: "New Inspection Yard",
          latitude: 51.5,
          longitude: -0.12,
          lots: [
            {
              ...makeLot(),
              location: "Old Inspection Yard",
              latitude: 51.5,
              longitude: -0.12,
            },
          ],
        },
        {
          previousPreviewData: {
            location: "Old Inspection Yard",
            latitude: 50.1,
            longitude: -104.2,
          },
        }
      );

      expect(normalized).toMatchObject({
        location: "New Inspection Yard",
        latitude: 51.5,
        longitude: -0.12,
      });
      expect(normalized.lots[0]).toMatchObject({
        location: "New Inspection Yard",
        latitude: 51.5,
        longitude: -0.12,
      });
    });

    it("preserves valid coordinates when the readable root location is unchanged", () => {
      const normalized = normalizePreviewLotsForBusinessRules(
        {
          location: "Existing Inspection Yard",
          latitude: 50.1,
          longitude: -104.2,
          lots: [makeLot()],
        },
        {
          previousPreviewData: {
            location: "Existing Inspection Yard",
            latitude: 50.1,
            longitude: -104.2,
          },
        }
      );

      expect(normalized).toMatchObject({
        location: "Existing Inspection Yard",
        latitude: 50.1,
        longitude: -104.2,
      });
    });

    it("keeps coordinates when a legacy placeholder is resolved to its readable name", () => {
      const normalized = normalizePreviewLotsForBusinessRules(
        {
          location: "Resolved Inspection Yard",
          latitude: 50.1,
          longitude: -104.2,
          lots: [makeLot()],
        },
        {
          previousPreviewData: {
            location: "Current Browser Location",
            latitude: 50.1,
            longitude: -104.2,
          },
        }
      );

      expect(normalized).toMatchObject({
        location: "Resolved Inspection Yard",
        latitude: 50.1,
        longitude: -104.2,
      });
    });
  });
});
