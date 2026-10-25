/** View-only selection. It must never slice or replace the report's saved lots. */
export function reportLotNavigation(totalLots: number, selectedIndex: number, includeSummary = false) {
  const total = Number.isFinite(totalLots) ? Math.max(0, Math.floor(totalLots)) : 0;
  const first = includeSummary || total === 0 ? -1 : 0;
  const selected = Number.isFinite(selectedIndex)
    ? Math.max(first, Math.min(Math.floor(selectedIndex), total - 1))
    : first;
  return {
    total,
    selected,
    previous: selected > first ? selected - 1 : null,
    next: selected < total - 1 ? selected + 1 : null,
    position: selected < 0 ? "Report summary" : `Viewing lot ${selected + 1} of ${total}`,
    loaded: `All ${total} ${total === 1 ? "lot is" : "lots are"} loaded`,
  };
}
