import type { CrmPerson, CrmTaskItem, CrmTaskStatus, CrmLostReason } from "@/services/crm";
import { safeCrmUrl } from "@/services/crm";

export type CrmDetailUser = { id: string; name?: string; company?: string; email?: string; phone?: string };

export function crmPersonId(person?: CrmPerson | string | null) {
  return typeof person === "string" ? person : person?._id || "";
}

export function crmPersonLabel(person?: CrmPerson | string | null) {
  return typeof person === "object" && person ? person.username || person.email || "CRM agent" : "CRM agent";
}

export function crmDate(value?: string, includeTime = false) {
  if (!value) return "Not set";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Not set";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "short", day: "numeric",
    ...(includeTime ? { hour: "numeric", minute: "2-digit" } as const : {}),
  }).format(date);
}

export function crmPhoneOptions(task: Pick<CrmTaskItem, "phoneFormatted" | "phoneRaw" | "contactPhones" | "contactMobilePhones" | "companyPhones">) {
  const values = [
    ["Primary", task.phoneFormatted], ["Primary", task.phoneRaw],
    ...(task.contactPhones || []).map((phone, i) => [`Contact ${i + 1}`, phone]),
    ...(task.contactMobilePhones || []).map((phone, i) => [`Mobile ${i + 1}`, phone]),
    ...(task.companyPhones || []).map((phone, i) => [`Company ${i + 1}`, phone]),
  ];
  const seen = new Set<string>();
  return values.flatMap(([label, value]) => {
    if (!value || /^(?:researching(?:\.{3})?|pending|unknown|n\/?a|none|not\s+(?:available|found|provided)|no\s+(?:phone|number)|tbd|-+)$/i.test(value.trim())) return [];
    const extension = value.match(/(?:ext\.?|extension|x)\s*(\d{1,8})\s*$/i);
    const main = extension ? value.slice(0, extension.index).trim() : value.trim();
    const digits = main.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) return [];
    const normalized = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
    const identity = normalized + (extension ? `x${extension[1]}` : "");
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [{ label, value, href: `tel:${main.startsWith("+") ? "+" : ""}${digits}${extension ? `,${extension[1]}` : ""}` }];
  });
}

export function crmWebsite(value?: string) {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (/^[a-z][a-z\d+.-]*:/i.test(raw)) return safeCrmUrl(raw);
  return safeCrmUrl(`https://${raw}`);
}

export function crmSocialLinks(value?: string) {
  const platforms: Record<string, string> = {
    facebook: "https://facebook.com/", fb: "https://facebook.com/",
    instagram: "https://instagram.com/", ig: "https://instagram.com/",
    linkedin: "https://linkedin.com/in/", twitter: "https://x.com/", x: "https://x.com/",
    youtube: "https://youtube.com/@", yt: "https://youtube.com/@", tiktok: "https://www.tiktok.com/@",
  };
  const links = (value || "").split(/[\n,;|]+/).flatMap((chunk) => {
    const urls = chunk.match(/(?:https?:\/\/|www\.)[^\s,;|<>]+/gi);
    if (urls) return urls.map(crmWebsite);
    const candidate = chunk.trim();
    const handle = candidate.match(/^(facebook|fb|instagram|ig|linkedin|twitter|x|youtube|yt|tiktok)\s*[:\-]?\s*@?([a-z0-9._-]{2,})$/i);
    if (handle) return [safeCrmUrl(platforms[handle[1].toLowerCase()] + handle[2])];
    return /^[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s<>]*)?$/i.test(candidate) ? [crmWebsite(candidate)] : [];
  }).filter((link): link is string => Boolean(link));
  return [...new Set(links)];
}

export function crmReminderText(status: CrmTaskStatus, lostReason?: CrmLostReason) {
  if (["contacted", "inspection_required", "inspection_complete"].includes(status)) return "Reminders repeat every 7 days while this stage stays unchanged.";
  if (["proposal_submitted", "decision_pending"].includes(status)) return "Reminders repeat every 2 days while this stage stays unchanged.";
  if (status === "lost" && lostReason !== "competitor") return "Lost leads with this reason receive a reminder every 30 days.";
  if (status === "won" || (status === "lost" && lostReason === "competitor")) return "This stage closes the lead and stops automatic reminders.";
  return "New leads receive reminders after moving to the next stage.";
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", bull: "•", hellip: "…" };

/** Rewrite output is converted to text without creating or rendering an HTML document. */
export function crmEmailPlainText(value: string) {
  return value
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(?:p|div|h[1-6]|ul|ol)\s*>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
      if (!entity.startsWith("#")) return ENTITIES[entity.toLowerCase()] ?? match;
      const code = entity.toLowerCase().startsWith("#x") ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
    })
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function crmEmailHref(to: string, subject: string, body: string, user: CrmDetailUser) {
  const recipient = to.trim();
  if (!/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(recipient)) throw new Error("Enter a valid recipient email address.");
  const signature = [user.name, user.company, user.phone, user.email].filter(Boolean).join("\n");
  const message = `${body.trim()}${signature ? `\n\n—\n${signature}` : ""}`;
  return `mailto:${encodeURIComponent(recipient)}?subject=${encodeURIComponent(subject.replace(/[\r\n]/g, " ").trim())}&body=${encodeURIComponent(message)}`;
}
