type PreviewLot = Record<string, any>;

const normalizeFieldKey = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/[^a-z0-9]+/g, "");

const PRIMARY_SERIAL_KEYS = new Set(["serialnumber", "serialno", "vin", "sn", "sno"]);

export const isPrimarySerialField = (value: unknown) =>
  PRIMARY_SERIAL_KEYS.has(normalizeFieldKey(value));

const toSpecRecord = (value: unknown): Record<string, string> => {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value
        .map((entry: any) => [
          String(entry?.field || "").trim(),
          String(entry?.value || "").trim(),
        ])
        .filter(([field]) => field)
    );
  }
  return value && typeof value === "object"
    ? { ...(value as Record<string, string>) }
    : {};
};

/** Keeps the root serial and Condition Report serial row as one editable value. */
export function applyPrimarySerialEdit(lot: PreviewLot, value: unknown): PreviewLot {
  const next = { ...lot };
  const serial = String(value ?? "");
  const specs = toSpecRecord(next.condition_report_specs);
  const overrides = toSpecRecord(next.condition_report_specs_manual_overrides);
  Object.keys(specs).forEach((field) => {
    if (isPrimarySerialField(field)) delete specs[field];
  });
  Object.keys(overrides).forEach((field) => {
    if (isPrimarySerialField(field)) delete overrides[field];
  });

  // Legacy drafts can carry deletion maps as well as the current array.
  // Remove only this edited field; unrelated hidden/deleted specs stay intact.
  for (const key of [
    "condition_report_specs_deleted",
    "deleted_condition_report_specs",
    "removed_condition_report_specs",
    "hidden_condition_report_specs",
  ]) {
    const collection = next[key];
    if (Array.isArray(collection)) {
      next[key] = collection.filter((field: unknown) => !isPrimarySerialField(field));
    } else if (collection && typeof collection === "object") {
      next[key] = Object.fromEntries(
        Object.entries(collection).filter(([field]) => !isPrimarySerialField(field))
      );
    }
  }
  const deletedCollection = next.condition_report_specs_deleted;
  const deleted = (Array.isArray(deletedCollection)
    ? deletedCollection
    : deletedCollection && typeof deletedCollection === "object"
      ? Object.entries(deletedCollection).filter(([, deleted]) => deleted).map(([field]) => field)
    : []
  )
    .map((field: unknown) => String(field || "").trim())
    .filter((field: string) => field && !isPrimarySerialField(field));

  next.serial_number = serial;
  next.condition_report_specs = specs;
  // A later preview edit must replace an older Excel/CR manual correction too.
  next.condition_report_specs_manual_overrides = { ...overrides, "Serial Number": serial };

  if (serial.trim()) {
    next.condition_report_specs["Serial Number"] = serial;
    next.condition_report_specs_deleted = deleted;
  } else {
    for (const field of ["serial_no_or_label", "sn_vin", "vin", "sn"]) {
      if (Object.prototype.hasOwnProperty.call(next, field)) next[field] = "";
    }
    next.condition_report_specs_deleted = [...deleted, "Serial Number"];
    if (Array.isArray(next.condition_report_specs_custom_order)) {
      next.condition_report_specs_custom_order =
        next.condition_report_specs_custom_order.filter(
          (field: unknown) => !isPrimarySerialField(field)
        );
    }
  }

  return next;
}
