export const CRM_QUADRANT_OPTIONS = [
  { value: "NW", label: "North West" }, { value: "NE", label: "North East" },
  { value: "SW", label: "South West" }, { value: "SE", label: "South East" },
  { value: "NORTH", label: "North" }, { value: "SOUTH", label: "South" },
  { value: "EAST", label: "East" }, { value: "WEST", label: "West" },
  { value: "CENTRAL", label: "Central" },
] as const;

export function parseCrmQuadrants(value?: string): string[] {
  const allowed = new Set<string>(CRM_QUADRANT_OPTIONS.map((option) => option.value));
  return Array.from(new Set((value || "").split(",").map((part) => part.trim().toUpperCase()).filter((part) => allowed.has(part))));
}

/** datetime-local uses the user's clock; retain tomorrow at 17:00 across DST changes. */
export function defaultCrmDueDate(now = new Date()) {
  const date = new Date(now);
  date.setDate(date.getDate() + 1);
  date.setHours(17, 0, 0, 0);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T17:00`;
}

export function crmMutationOutcomeUnknown(error: unknown) {
  const status = (error as { response?: { status?: unknown } })?.response?.status;
  return typeof status !== "number" || status === 408 || status >= 500;
}
