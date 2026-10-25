const PHONE_PLACEHOLDER_PATTERN = /^(?:research(?:ing)?|pending|unknown|n\/?a|none|null|not\s+available|not\s+found|tbd|unavailable|no\s+(?:phone|number)|phone\s+pending)[.!\s]*$/i;

export type NormalizedPhone = {
  raw: string;
  formatted: string;
  identity: string;
};

export type CrmPhoneFields = {
  phoneRaw?: unknown;
  phoneFormatted?: unknown;
  contactPhones?: unknown;
  contactMobilePhones?: unknown;
  companyPhones?: unknown;
};

export type NormalizedCrmPhoneFields = {
  phoneRaw: string;
  phoneFormatted: string;
  contactPhones: string[];
  contactMobilePhones: string[];
  companyPhones: string[];
};

function cleanPhoneText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function splitPhoneValues(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((entry) => cleanPhoneText(entry).split(/[\n,;|]+/g))
    .map(cleanPhoneText)
    .filter(Boolean);
}

export function isCrmPhonePlaceholder(value: unknown): boolean {
  const text = cleanPhoneText(value);
  if (!text) return true;
  return PHONE_PLACEHOLDER_PATTERN.test(text);
}

/**
 * Returns a dialable phone while preserving the user's original spelling.
 * Seven digits is the minimum accepted local number and fifteen is the E.164
 * maximum. Extension digits are deliberately excluded from that validation.
 */
export function normalizeCrmPhone(value: unknown): NormalizedPhone | null {
  const raw = cleanPhoneText(value);
  if (!raw || isCrmPhonePlaceholder(raw)) return null;

  const extensionMatch = raw.match(/(?:ext\.?|extension|x)\s*(\d{1,8})\s*$/i);
  const extension = extensionMatch?.[1] || "";
  const mainText = extensionMatch ? raw.slice(0, extensionMatch.index).trim() : raw;
  const mainDigits = mainText.replace(/\D/g, "");
  if (mainDigits.length < 7 || mainDigits.length > 15) return null;

  let formatted = raw;
  let nanpDigits = mainDigits;
  if (nanpDigits.length === 11 && nanpDigits.startsWith("1")) {
    nanpDigits = nanpDigits.slice(1);
  }
  if (nanpDigits.length === 10) {
    formatted = `+1 (${nanpDigits.slice(0, 3)}) ${nanpDigits.slice(3, 6)}-${nanpDigits.slice(6)}`;
    if (extension) formatted += ` ext. ${extension}`;
  }

  return {
    raw,
    formatted,
    // A NANP number may arrive with or without its leading country code.
    // Canonicalizing that prefix prevents the same number from surviving in
    // both primary and alternate fields after imports from different sources.
    identity: `${nanpDigits.length === 10 ? nanpDigits : mainDigits}${extension ? `x${extension}` : ""}`,
  };
}

function normalizeCollection(value: unknown, globalSeen: Set<string>): string[] {
  const normalized: string[] = [];
  for (const candidate of splitPhoneValues(value)) {
    const phone = normalizeCrmPhone(candidate);
    if (!phone || globalSeen.has(phone.identity)) continue;
    globalSeen.add(phone.identity);
    normalized.push(phone.raw);
  }
  return normalized;
}

/**
 * Normalizes the full CRM phone surface in one pass. Collection order is
 * stable, so the first valid alternate can safely replace a placeholder
 * primary number without changing which number users see first.
 */
export function normalizeCrmPhoneFields(input: CrmPhoneFields): NormalizedCrmPhoneFields {
  const seen = new Set<string>();
  const contactPhones = normalizeCollection(input.contactPhones, seen);
  const contactMobilePhones = normalizeCollection(input.contactMobilePhones, seen);
  const companyPhones = normalizeCollection(input.companyPhones, seen);

  const explicitPrimary = [input.phoneRaw, input.phoneFormatted]
    .flatMap(splitPhoneValues)
    .map(normalizeCrmPhone)
    .find((phone): phone is NormalizedPhone => Boolean(phone));
  const promotedPrimary = explicitPrimary ||
    [...contactPhones, ...contactMobilePhones, ...companyPhones]
      .map(normalizeCrmPhone)
      .find((phone): phone is NormalizedPhone => Boolean(phone));

  // The primary number is exposed separately by every CRM client. Remove the
  // same identity from alternate collections so callers never see or dial a
  // duplicate merely because an importer populated both fields.
  const withoutPrimary = (values: string[]) =>
    promotedPrimary
      ? values.filter(
          (value) => normalizeCrmPhone(value)?.identity !== promotedPrimary.identity
        )
      : values;

  return {
    phoneRaw: promotedPrimary?.raw || "",
    phoneFormatted: promotedPrimary?.formatted || "",
    contactPhones: withoutPrimary(contactPhones),
    contactMobilePhones: withoutPrimary(contactMobilePhones),
    companyPhones: withoutPrimary(companyPhones),
  };
}

export function phoneFieldsEqual(
  current: CrmPhoneFields,
  normalized: NormalizedCrmPhoneFields
): boolean {
  const sameArray = (left: unknown, right: string[]) =>
    Array.isArray(left) &&
    left.length === right.length &&
    left.every((value, index) => cleanPhoneText(value) === right[index]);

  return (
    cleanPhoneText(current.phoneRaw) === normalized.phoneRaw &&
    cleanPhoneText(current.phoneFormatted) === normalized.phoneFormatted &&
    sameArray(current.contactPhones, normalized.contactPhones) &&
    sameArray(current.contactMobilePhones, normalized.contactMobilePhones) &&
    sameArray(current.companyPhones, normalized.companyPhones)
  );
}
