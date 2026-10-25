export type SmartUploadOrderReviewState = {
  orderReviewRequired: boolean;
  unresolvedDividerIds: string[];
};

export type SmartUploadReviewStateValidation = {
  valid: boolean;
  unresolvedDividerIds: string[];
  duplicateFileIds: string[];
  emptyFileIds: string[];
  nonDividerFileIds: string[];
};

const resolveBoolean = (value: unknown): boolean =>
  value === true || value === "true" || value === 1 || value === "1";

const uniqueIds = (values: Iterable<unknown>): string[] =>
  Array.from(
    new Set(
      Array.from(values, (value) => String(value).trim()).filter(Boolean)
    )
  );

/**
 * Resolve durable review state while keeping sessions created before these
 * fields were introduced safe. A legacy ambiguous session defaults every
 * detected divider to unresolved instead of silently appearing reviewed.
 */
export function resolveSmartUploadOrderReviewState(args: {
  orderReviewRequired?: unknown;
  unresolvedDividerIds?: unknown;
  dividerFileIds: Iterable<unknown>;
  detailsOrderAmbiguous?: unknown;
}): SmartUploadOrderReviewState {
  const dividerFileIds = uniqueIds(args.dividerFileIds);
  const dividerSet = new Set(dividerFileIds);
  const hasPersistedReviewFlag =
    typeof args.orderReviewRequired === "boolean";
  const orderReviewRequired = hasPersistedReviewFlag
    ? args.orderReviewRequired === true
    : resolveBoolean(args.detailsOrderAmbiguous);
  const rawUnresolvedDividerIds = Array.isArray(args.unresolvedDividerIds)
    ? args.unresolvedDividerIds.map((value) => String(value).trim())
    : [];
  const uniqueUnresolvedDividerIds = uniqueIds(rawUnresolvedDividerIds);
  const hasInvalidPersistedDividerId = rawUnresolvedDividerIds.some(
    (fileId) => !fileId || !dividerSet.has(fileId)
  );
  const unresolvedDividerIds = uniqueUnresolvedDividerIds.filter((fileId) =>
    dividerSet.has(fileId)
  );

  const resolvedUnresolvedDividerIds =
    orderReviewRequired &&
    !hasPersistedReviewFlag &&
    unresolvedDividerIds.length === 0
      ? dividerFileIds
      : unresolvedDividerIds;

  return {
    orderReviewRequired:
      orderReviewRequired ||
      hasInvalidPersistedDividerId ||
      resolvedUnresolvedDividerIds.length > 0,
    unresolvedDividerIds: resolvedUnresolvedDividerIds,
  };
}

/** Validate a PATCH review list without silently discarding bad entries. */
export function validateSmartUploadUnresolvedDividerIds(
  dividerFileIds: Iterable<unknown>,
  rawUnresolvedDividerIds: unknown[]
): SmartUploadReviewStateValidation {
  const dividerSet = new Set(uniqueIds(dividerFileIds));
  const normalized = rawUnresolvedDividerIds.map((value) =>
    String(value).trim()
  );
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const fileId of normalized) {
    if (seen.has(fileId)) duplicates.add(fileId);
    seen.add(fileId);
  }
  const duplicateFileIds = Array.from(duplicates);
  const emptyFileIds = Array.from(seen).filter((fileId) => !fileId);
  const nonDividerFileIds = Array.from(seen).filter(
    (fileId) => fileId.length > 0 && !dividerSet.has(fileId)
  );

  return {
    valid:
      duplicateFileIds.length === 0 &&
      emptyFileIds.length === 0 &&
      nonDividerFileIds.length === 0,
    unresolvedDividerIds: normalized,
    duplicateFileIds,
    emptyFileIds,
    nonDividerFileIds,
  };
}
