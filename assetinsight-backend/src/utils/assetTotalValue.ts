function numericAssetValue(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/[^0-9.-]+/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Mixed Asset lots can contain both a lot-level value and item values. Taking
 * the larger aggregate avoids double-counting while repairing legacy catalogue
 * lots whose lot-level value represented only the first item.
 */
export function calculateAssetLotsTotalValue(lots: any[]): number {
  return (Array.isArray(lots) ? lots : []).reduce((sum, lot) => {
    const lotValue = numericAssetValue(lot?.estimated_value);
    const itemValue = Array.isArray(lot?.items)
      ? lot.items.reduce(
          (itemSum: number, item: any) =>
            itemSum + numericAssetValue(item?.estimated_value),
          0
        )
      : 0;
    return sum + Math.max(lotValue, itemValue);
  }, 0);
}
