import { describe, expect, it } from "vitest";
import { resolveScheduleAMapping } from "../src/service/auctioneerScheduleAMapping.js";

const sources = [
  { sourceKey: "a", lotId: "upstream-a", raw: {} },
  { sourceKey: "b", lotId: "upstream-b", raw: {} },
];
describe("Schedule A split identity", () => {
  it("preserves interleaved report order and exact parent identity", () => {
    const mapped = resolveScheduleAMapping(sources, [
      { key: "a" }, { key: "a:split:1", parentKey: "a" },
      { key: "b" }, { key: "b:split:1", parentKey: "b" },
    ]);
    expect(mapped.map(row => row.key)).toEqual(["a", "a:split:1", "b", "b:split:1"]);
    expect(mapped.map(row => row.source.lotId)).toEqual(["upstream-a", "upstream-a", "upstream-b", "upstream-b"]);
  });
  it.each([
    [{ key: "a" }, { key: "b" }, { key: "x", parentKey: "missing" }],
    [{ key: "a" }, { key: "b" }, { key: "a", parentKey: "a" }],
    [{ key: "a" }, { key: "b" }, { parentKey: "a" }],
    [{ key: "a" }, { key: "b" }, { key: "x", parentKey: "a" }, { key: "x", parentKey: "b" }],
    [{ key: "b" }, { key: "a" }],
    [{ key: "a" }],
  ])("rejects missing, duplicated or changed identities (%#)", (...lots) => {
    expect(() => resolveScheduleAMapping(sources, lots)).toThrow();
  });
  it("retains legacy positional originals but never guesses a split key", () => {
    expect(resolveScheduleAMapping(sources, [{}, {}]).map(row => row.key)).toEqual(["a", "b"]);
  });
});
