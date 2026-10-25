/** Presentation only: retain uncertainty, automation and source attribution, without product branding. */
export function salvageDisplayText(value: unknown): string {
  return String(value ?? '')
    .replace(/\bOpenAI\b/gi, 'processing service')
    .replace(/\bGPT[-\s]?\d[\w.-]*(?:-astra)?\b/gi, 'processing model')
    .replace(/\bAI-generated\b/gi, 'automatically prepared')
    .replace(/\bAI\b/g, 'automated');
}
