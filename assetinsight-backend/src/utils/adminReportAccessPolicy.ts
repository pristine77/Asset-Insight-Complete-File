/** Shared operational/report field-value access; ownership alone is not an admin capability. */
export function canInspectAdminReport(record: { status?: string; approval_assigned_to?: any }, userId?: string): boolean {
  const status = String(record.status || "").trim().toLowerCase();
  const assigned = record.approval_assigned_to?._id || record.approval_assigned_to;
  return ["approved", "completed"].includes(status) ||
    (["pending", "pending_approval"].includes(status) && !assigned) ||
    !!(assigned && userId && String(assigned) === userId);
}
