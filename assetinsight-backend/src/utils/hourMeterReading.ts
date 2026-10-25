/**
 * Derives a reading only from an intact numeric token next to an hours label.
 * Consume all adjacent numeric punctuation before validating: taking the final
 * suffix of `10; 770.4 hours` would silently turn 10,770.4 into 770.4. Ambiguous
 * legacy text is left unresolved, never repaired by joining arbitrary numbers.
 * This is an unreviewed-prose fallback, not a formatter for saved spec values.
 */
export function extractHourMeterReading(text: string): string {
  const source = text;
  const patterns = [
    // Keep the existing exact Engine Hours preference when equipment also has
    // independent separator/threshing counters or an earlier generic reading.
    /\bengine\s+hours?(?:\s*\((?:showing\s+)?unverified\))?(?:\s+showing(?:\s+unverified)?)?\s*[:#=-]?\s*(\d+(?:,\s*\d{3})*(?:\.\d+)?)/gi,
    /\bhour\s+meter(?:\s+reading)?(?:\s+of)?\s*[:#=-]?\s*(\d+(?:,\s*\d{3})*(?:\.\d+)?)/gi,
    /\b(?:engine\s+|showing\s+|operating\s+)?hours?(?:\s*\((?:showing\s+)?unverified\))?(?:\s+showing(?:\s+unverified)?)?\s*[:#=-]?\s*(\d+(?:,\s*\d{3})*(?:\.\d+)?)/gi,
    /(?<![\w.,:;+/\-–—−])(\d+(?:,\s*\d{3})*(?:\.\d+)?)\s*(?:hours?|hrs?)\b/gi,
  ];
  for (const [index, pattern] of patterns.entries()) {
    let match = pattern.exec(source);
    // A separator, threshing or rotor meter is not the engine-hour meter.
    while (match && /\b(?:separator|threshing|rotor)(?:\s+(?:hours?|hour\s+meter(?:\s+reading)?)(?:\s*\((?:showing\s+)?unverified\))?(?:\s+showing(?:\s+unverified)?)?\s*[:#=-]?)?\s*$/i.test(source.slice(0, match.index))) {
      match = pattern.exec(source);
    }
    if (!match) {
      // An explicit unreadable engine reading must not borrow another counter.
      if (index === 0 && /\bengine\s+hours?\b/i.test(source)) return "";
      continue;
    }
    const candidate = match[1].trim().replace(/,\s+(?=\d)/g, ",");
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(candidate)) return "";
    const start = match.index + match[0].indexOf(match[1]);
    const before = source.slice(0, start);
    const rawAfter = source.slice(start + match[1].length);
    const after = rawAfter.trimStart();
    // A number cannot start halfway through a malformed grouping, clock or
    // range, including one interrupted by a newline or non-breaking space.
    if (/\d[\s,.:;+/\-–—−]*$/.test(before)) return "";
    if (/^\d/.test(after)) return "";
    // An independent next numeric clause ("; 6 cylinders") is not part of
    // this reading; an unlabeled/hour-valued second number is ambiguous.
    const nextNumericClause = after.match(/^([,.:;+/\-–—−\s]+)\d[\d,.\s]*\s*([a-z]*)/i);
    if (nextNumericClause && (
      nextNumericClause[1].trim() !== ";" ||
      !nextNumericClause[2] || /^(?:hours?|hrs?)$/i.test(nextNumericClause[2])
    )) return "";
    if (/^[,:]\s*(?:$|[,.:;])/.test(after)) return "";
    // Hours labels cannot turn a speed, distance or power value into hours.
    const nextLabelOnNewLine = /^[\t ]*[\r\n]/.test(rawAfter) && /^[a-z][a-z ()/\-]{0,60}[:#]/i.test(after);
    if (/^[a-z]/i.test(after) && !/^(?:hours?|hrs?|showing|unverified)\b/i.test(after) && !nextLabelOnNewLine) return "";
    return candidate;
  }
  return "";
}
