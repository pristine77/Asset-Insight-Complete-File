/** The capture group's identity and the label already shown on the phone. */
export type CaptureLotIdentity = { capture_lot_id: string; capture_lot_number: string };

export function captureLotIdentity(
  lot: { id: string; lotNumber?: string; lot_number?: string | number },
  index: number
): CaptureLotIdentity {
  const number = lot.lotNumber ?? lot.lot_number;
  return {
    capture_lot_id: lot.id,
    capture_lot_number: number != null && String(number).trim() ? String(number).trim() : String(index + 1),
  };
}
