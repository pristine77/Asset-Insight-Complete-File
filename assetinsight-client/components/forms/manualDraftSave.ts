/**
 * Persists an editable form revision without starting report processing.
 * Draft preview generation remains an explicit action in the Previews page.
 */
export async function saveManualDraftOnly(
  persist: () => Promise<boolean>,
  onCommitted: () => void
): Promise<boolean> {
  const committed = await persist();
  if (!committed) return false;
  onCommitted();
  return true;
}
