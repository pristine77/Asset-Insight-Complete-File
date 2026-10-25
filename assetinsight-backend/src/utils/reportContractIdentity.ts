/**
 * Canonical identity used when a contract number participates in duplicate
 * prevention. Presentation keeps the user's original value; this key is only
 * for comparisons and indexes.
 */
export const normalizeReportContractKey = (value: unknown): string =>
  String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en-US");

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Compatibility lookup for rows created before contract_key existed. It is
 * deliberately anchored and only relaxes whitespace/case, so a prefix cannot
 * block an unrelated contract.
 */
export const legacyReportContractRegex = (value: unknown): RegExp | null => {
  const normalized = String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ");
  if (!normalized) return null;
  return new RegExp(
    `^${normalized.split(" ").map(escapeRegex).join("\\s+")}$`,
    "iu"
  );
};
