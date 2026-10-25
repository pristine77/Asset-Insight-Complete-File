/** Presentation-only substitutions for system messages; never mutate saved evidence or user inputs. */
export function salvageSystemText(value: unknown, fallback = ""): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value
    .replace(/\bOpenAI\b/gi, "processing service")
    .replace(/\bGPT[-\s]?\d[\w.-]*\b/gi, "assessment engine")
    .replace(/\bAI[- ]generated\b/gi, "automatically generated")
    .replace(/\bAI\b/gi, "automated assessment");
}
