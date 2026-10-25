import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { localizedSalvageMethod, localizedSalvageSystemMessage } from "../src/service/salvageReportLanguage.js";

describe("Salvage deterministic report localization", () => {
  it.each(["fr", "es"])("covers every literal assessment exclusion and limitation in %s", language => {
    const source = readFileSync(new URL("../src/service/salvageAssessment.ts", import.meta.url), "utf8");
    const messages = [...source.matchAll(/exclusions\.push\("([^"\n]+)"\)|exclusionReasons\.push\("([^"\n]+)"\)|add\("[A-Z_]+", "([^"\n]+)"|code: "RESEARCH_STALE", message: "([^"\n]+)"/g)].map(match => match[1] || match[2] || match[3] || match[4]);
    expect(messages.length).toBeGreaterThan(35);
    for (const message of messages) {
      const result = localizedSalvageSystemMessage(message, language);
      expect(result, message).not.toBe(message);
      expect(result.match(/\d[\d,.]*%?/g) || []).toEqual(message.match(/\d[\d,.]*%?/g) || []);
      expect(result).not.toMatch(/\b(?:OpenAI|GPT|AI)\b/);
    }
  });
  it("retains zero/unknown safeguards, dates, policy limits and no certification claims", () => {
    expect(localizedSalvageSystemMessage("Parts, labour or other charges lack complete supported inputs. Known subtotal is not a complete repair estimate.", "fr")).toContain("n’est pas une estimation complète");
    expect(localizedSalvageSystemMessage("This value reflects advertised asking prices, not verified completed sales.", "es")).toContain("no ventas realizadas verificadas");
    expect(localizedSalvageSystemMessage("Evidence must be dated on/before valuation date and no older than one year", "es")).toContain("no superior a un año");
    expect(localizedSalvageSystemMessage("Evidence-dated valuation support only; not a structural/mechanical inspection, roadworthiness or title certification, EV battery safety determination, or insurer settlement decision.", "fr")).toContain("ne s’agit ni d’une inspection");
  });
  it("only translates known dynamic grammar and preserves original IDs", () => {
    expect(localizedSalvageSystemMessage("Duplicate vehicle/listing: comp-ABC_123", "fr")).toBe("Véhicule/annonce en double: comp-ABC_123");
    expect(localizedSalvageSystemMessage("Missing verified eventDate evidence", "es")).toBe("Falta evidencia verificada: fecha del evento");
    expect(localizedSalvageSystemMessage("Photo-derived vin conflicts with another photo or supplied information. Supplied information remains authoritative; appraiser verification is required.", "fr")).toContain("restent prioritaires");
    expect(localizedSalvageSystemMessage("Missing verified inventedField evidence", "fr")).toBe("Missing verified inventedField evidence");
  });
  it.each(["fr", "es", "en"])("keeps unknown research/user/source content unchanged in %s", language => {
    const original = "Source says: Unverified source content. VIN X123 / CAD 1,000.50\nDo not rewrite my quote.";
    expect(localizedSalvageSystemMessage(original, language)).toBe(original);
    expect(localizedSalvageSystemMessage("Research lead: listing may be sold; verify it", language)).toBe("Research lead: listing may be sold; verify it");
    expect(localizedSalvageSystemMessage("constructor", language)).toBe("constructor");
  });
  it.each(["fr", "es"])("translates only appraiser override prefix in %s", language => {
    const rationale = "  Supplied [R9] CAD 5,000\nAsking price is not a sale. AI source wording unchanged.";
    const result = localizedSalvageMethod({ status: "appraiser_override", method: `Appraiser override: ${rationale}`, priceBasis: null, comparableIds: [] }, language);
    expect(result.endsWith(rationale)).toBe(true);
    expect(result).toContain("[R9] CAD 5,000");
    expect(result).not.toMatch(/^Appraiser override:/);
  });
  it.each(["fr", "es"])("distinguishes supported-sale and provisional-asking medians in %s", language => {
    const suffix = " median of 6 eligible distinct vehicles. Range is the observed minimum–maximum, not a confidence interval.";
    const sold = localizedSalvageMethod({ status: "supported", method: `Verified-sale${suffix}`, priceBasis: "sold", comparableIds: ["id-preserved"] }, language);
    const asking = localizedSalvageMethod({ status: "provisional", method: `Provisional asking-market${suffix}`, priceBasis: "asking", comparableIds: [] }, language);
    expect(sold).toContain("6"); expect(asking).toContain("6"); expect(sold).not.toBe(asking);
    expect(asking).toContain("provis");
    expect(sold).toContain(language === "fr" ? "et non un intervalle de confiance" : "no un intervalo de confianza");
    const mismatch = `Verified-sale${suffix}`;
    expect(localizedSalvageMethod({ status: "provisional", method: mismatch, priceBasis: "asking", comparableIds: [] }, language)).toBe(mismatch);
  });
  it("does not synthesize a method from status or mutate conclusions", () => {
    const conclusion = { status: "supported", method: "Legacy custom method\n[R1]", priceBasis: "sold", comparableIds: ["R1"] };
    const original = structuredClone(conclusion);
    expect(localizedSalvageMethod(conclusion, "fr")).toBe(conclusion.method);
    expect(localizedSalvageMethod(conclusion, "en")).toBe(conclusion.method);
    expect(localizedSalvageSystemMessage("Unverified source content", "de")).toBe("Unverified source content");
    expect(conclusion).toEqual(original);
  });
});
