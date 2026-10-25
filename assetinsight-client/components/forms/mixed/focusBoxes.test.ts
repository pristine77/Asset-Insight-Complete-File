import { describe, expect, it } from "vitest";
import { buildMixedFocusBoxes } from "./focusBoxes";
import { getMixedFileKey, type MixedLot } from "./types";

const image = (name: string, lastModified: number) =>
  new File(["image"], name, { type: "image/jpeg", lastModified });

describe("buildMixedFocusBoxes", () => {
  it("uses global main-then-extra upload order across lots", () => {
    const firstMain = image("first.jpg", 1);
    const firstExtra = image("first-extra.jpg", 2);
    const secondMain = image("second.jpg", 3);
    const lots: MixedLot[] = [
      {
        id: "one",
        files: [firstMain],
        extraFiles: [firstExtra],
        coverIndex: 0,
        mode: "single_lot",
        annotations: {
          [getMixedFileKey(firstMain)]: [
            { id: "first-focus", x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
          ],
        },
      },
      {
        id: "two",
        files: [secondMain],
        extraFiles: [],
        coverIndex: 0,
        mode: "per_item",
        annotations: {
          [getMixedFileKey(secondMain)]: [
            { id: "second-focus", x: 0.5, y: 0.6, w: 0.2, h: 0.1 },
          ],
        },
      },
    ];

    expect(buildMixedFocusBoxes(lots)).toEqual([
      { imageIndex: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      { imageIndex: 2, x: 0.5, y: 0.6, w: 0.2, h: 0.1 },
    ]);
  });

  it("ignores malformed annotations without shifting image order", () => {
    const first = image("first.jpg", 1);
    const second = image("second.jpg", 2);
    const lots: MixedLot[] = [
      {
        id: "one",
        files: [first, second],
        extraFiles: [],
        coverIndex: 0,
        annotations: {
          [getMixedFileKey(first)]: [
            { id: "invalid", x: Number.NaN, y: 0, w: 1, h: 1 },
          ],
          [getMixedFileKey(second)]: [
            { id: "valid", x: 0, y: 0, w: 1, h: 1 },
          ],
        },
      },
    ];

    expect(buildMixedFocusBoxes(lots)).toEqual([
      { imageIndex: 1, x: 0, y: 0, w: 1, h: 1 },
    ]);
  });
});
