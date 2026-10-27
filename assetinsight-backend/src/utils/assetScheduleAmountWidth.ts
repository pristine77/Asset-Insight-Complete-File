/** Conservative Times-family widths in points for formatted monetary text.
 * Digits are tabular half-em; punctuation is a quarter-em. Unknown currency
 * glyphs reserve a full em. Renderers add their own cell padding separately.
 */
export function assetScheduleAmountWidth(text: string, fontSizePt: number): number {
  return Array.from(text).reduce((width, character) => width + (
    /[0-9$£€¥]/u.test(character) ? 0.5 :
    /[.,\s]/u.test(character) ? 0.25 :
    character === "-" ? 0.34 : 1
  ) * fontSizePt, 0);
}
