import { afterEach, describe, expect, it, vi } from "vitest";

const axiosMock = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("axios", () => ({
  default: { get: axiosMock.get },
}));

import {
  applyVinModelYearFallback,
  enrichLotsWithVin,
} from "../src/service/vehicleApiService.js";
import { normalizeAuctioneerLotSpecs } from "../src/utils/auctioneerSpecRows.js";

const MODERN_2025_VIN = "1HGCM8A63SA004352";

afterEach(() => {
  axiosMock.get.mockReset();
  vi.restoreAllMocks();
});

describe("vehicle VIN enrichment", () => {
  it("keeps the full grouped decimal hour reading through VIN enrichment and CR derivation", async () => {
    axiosMock.get.mockResolvedValue({ data: { Results: [{}] } });
    const [lot] = await enrichLotsWithVin([{
      title: "2018 Caterpillar D6T LGP Crawler Dozer",
      serial_number: MODERN_2025_VIN,
      categories: "Crawler Dozer",
      details: "CAT D6T LGP; build 19A. Equipped with grade control, dozer blade, rear ripper, enclosed cab; displayed hour meter reading of 10,770.4 hours.",
    }]);

    const normalized = normalizeAuctioneerLotSpecs(lot);
    expect(normalized.condition_report_specs["Engine Hours (Showing Unverified)"]).toBe("10,770.4 Hours");
    expect(lot.details).toContain("10,770.4 hours");
    expect(lot.details).not.toContain("10; 770.4");
  });

  it("finds a VIN in serial_number and fills a missing vPIC year locally", async () => {
    axiosMock.get.mockResolvedValue({
      data: { Results: [{ Make: "Ford", Model: "F-150", ModelYear: "" }] },
    });
    const lots = await enrichLotsWithVin([
      {
        serial_number: `VIN: ${MODERN_2025_VIN}`,
        title: "Ford F-150",
        details: "",
      },
    ]);

    expect(axiosMock.get).toHaveBeenCalledTimes(1);
    expect(lots[0]).toMatchObject({
      year: 2025,
      title: "2025 Ford F-150",
      vinDecoded: { vin: MODERN_2025_VIN, year: 2025 },
    });
    expect(lots[0].details).toContain("Year: 2025");
  });

  it("uses the local year when vPIC is unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    axiosMock.get.mockRejectedValue(new Error("vPIC unavailable"));
    const lots = await enrichLotsWithVin([
      {
        vin: MODERN_2025_VIN,
        title: "Ford F-150",
      },
    ]);

    expect(lots[0]).toMatchObject({
      year: 2025,
      title: "2025 Ford F-150",
      vinDecoded: { vin: MODERN_2025_VIN, year: 2025 },
    });
  });

  it("never replaces an explicit antique year with vPIC or the local VIN code", async () => {
    axiosMock.get.mockResolvedValue({
      data: {
        Results: [
          { Make: "Ford", Model: "F-150", ModelYear: "2025" },
        ],
      },
    });
    const lots = await enrichLotsWithVin([
      {
        year: 1970,
        serial_number: MODERN_2025_VIN,
        title: "1970 Ford F-150",
      },
    ]);

    expect(lots[0].year).toBe(1970);
    expect(lots[0].title).toBe("1970 Ford F-150");
    expect(lots[0].vinDecoded.year).toBe(1970);
  });

  it("uses vPIC ahead of a conflicting local VIN cycle", async () => {
    axiosMock.get.mockResolvedValue({
      data: {
        Results: [
          { Make: "Ford", Model: "F-150", ModelYear: "1995" },
        ],
      },
    });
    const lots = await enrichLotsWithVin([
      {
        serial_number: MODERN_2025_VIN,
        title: "Ford F-150",
      },
    ]);

    expect(lots[0]).toMatchObject({
      year: 1995,
      title: "1995 Ford F-150",
      vinDecoded: { year: 1995 },
    });
  });

  it("does not treat an incidental description year as the model year", async () => {
    axiosMock.get.mockResolvedValue({
      data: {
        Results: [
          { Make: "Ford", Model: "F-150", ModelYear: "2025" },
        ],
      },
    });
    const lots = await enrichLotsWithVin([
      {
        serial_number: MODERN_2025_VIN,
        title: "Ford F-150",
        description: "Engine rebuilt in 2020",
      },
    ]);

    expect(lots[0].year).toBe(2025);
    expect(lots[0].vinDecoded.year).toBe(2025);
  });

  it("applies the free fallback to nested Asset lots and preserves spec years", () => {
    const lots = applyVinModelYearFallback([
      {
        items: [
          { serial_number: MODERN_2025_VIN },
          {
            serial_number: MODERN_2025_VIN,
            condition_report_specs: { "Model Year": "1970" },
            vinDecoded: { year: 2025, ModelYear: "2025" },
          },
          { serial_number: "1HGCM8A63SA00435" },
        ],
      },
    ]);

    expect(lots[0].items[0]).toMatchObject({
      year: 2025,
      vinDecoded: { year: 2025 },
    });
    expect(lots[0].items[1]).toMatchObject({
      year: 1970,
      vinDecoded: { year: 1970, ModelYear: "1970" },
    });
    expect(lots[0].items[2].year).toBeUndefined();
  });
});
