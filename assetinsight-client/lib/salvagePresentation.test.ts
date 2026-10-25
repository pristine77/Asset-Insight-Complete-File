import { describe, expect, it } from "vitest";
import { salvageSystemText } from "./salvagePresentation";

describe("Salvage system-message presentation", () => {
  it("removes implementation labels without hiding uncertainty or implying human verification", () => {
    expect(salvageSystemText("AI-generated GPT-6-astra result from OpenAI: VIN unreadable; needs review."))
      .toBe("automatically generated assessment engine result from processing service: VIN unreadable; needs review.");
    expect(salvageSystemText("CAD 1,200 cost not verified")).toBe("CAD 1,200 cost not verified");
    expect(salvageSystemText(undefined, "Temporarily unavailable")).toBe("Temporarily unavailable");
  });
});
