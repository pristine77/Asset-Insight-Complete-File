import { describe, expect, it } from "vitest";
import { sessionTypeToDraftType } from "../src/service/reportDraftService.js";

describe("Smart Upload report draft session type", () => {
  it("keeps the canonical lotListing session in the lot-listing draft namespace", () => {
    expect(sessionTypeToDraftType("lotListing")).toBe("lotListing");
  });

  it("keeps compatibility with the legacy hyphenated session spelling", () => {
    expect(sessionTypeToDraftType("lot-listing")).toBe("lotListing");
  });

  it("maps asset sessions to asset drafts", () => {
    expect(sessionTypeToDraftType("asset")).toBe("asset");
  });
});
