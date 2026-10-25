import { describe, expect, it } from "vitest";

import { buildScheduleAReportData } from "../src/service/scheduleAReportPdfService.js";

describe("Schedule A CR report data", () => {
  it("enables all-photo bank pages without mutating the normal CR snapshot", () => {
    const source = {
      bank_photos_enabled: false,
      imageUrls: ["https://example.test/1.jpg", "https://example.test/2.jpg"],
      lots: [
        {
          lot_number: "1",
          bank_photos_enabled: false,
          image_indexes: [0, 1],
          extra_image_urls: ["https://example.test/extra.jpg"],
        },
      ],
    };

    const scheduleA = buildScheduleAReportData(source);

    expect(scheduleA.bank_photos_enabled).toBe(true);
    expect(scheduleA.lots[0].bank_photos_enabled).toBe(true);
    expect(scheduleA.imageUrls).toEqual(source.imageUrls);
    expect(scheduleA.lots[0].image_indexes).toEqual([0, 1]);
    expect(scheduleA.lots[0].extra_image_urls).toEqual([
      "https://example.test/extra.jpg",
    ]);
    expect(scheduleA).not.toBe(source);
    expect(scheduleA.lots[0]).not.toBe(source.lots[0]);
    expect(source.bank_photos_enabled).toBe(false);
    expect(source.lots[0].bank_photos_enabled).toBe(false);
  });
});
