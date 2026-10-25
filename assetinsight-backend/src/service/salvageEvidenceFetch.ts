import axios from "axios";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { createHash } from "node:crypto";

/** Evidence fetching is deliberately independent of the authenticated storage downloader. */
export function isPublicEvidenceAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
  }
  // Permit only native, globally routable unicast IPv6, excluding transition/documentation ranges.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) &&
    !/^2001:(?:db8|0|10|20):/i.test(address) && !/^2002:/i.test(address);
}

export function safeSalvageEvidenceUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (!/^https?:$/.test(url.protocol) || url.username || url.password ||
      (url.port && !["80", "443"].includes(url.port)) || !hostname.includes(".") ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid)$/i.test(hostname) ||
      (isIP(hostname) && !isPublicEvidenceAddress(hostname))) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return null; }
}

const lookup: NonNullable<http.AgentOptions["lookup"]> = (hostname, options, callback) => {
  // Resolve on the actual socket lookup (also after redirects); no DNS check/connect race.
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, "", 4);
    if (!addresses.length || addresses.some(({ address }) => !isPublicEvidenceAddress(address))) {
      return callback(Object.assign(new Error("Evidence URL is not public."), { code: "EACCES" }), "", 4);
    }
    if (options.all) (callback as unknown as (e: null, records: typeof addresses) => void)(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
};
const httpAgent = new http.Agent({ lookup, keepAlive: false });
const httpsAgent = new https.Agent({ lookup, keepAlive: false });

export function evidenceText(html: string): string {
  return html.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code: string) => {
      const point = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : parseInt(code, 10);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : " ";
    })
    .replace(/&(nbsp|amp|quot|apos|lt|gt);/gi, (_, key: string) => ({ nbsp: " ", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" }[key.toLowerCase()] || " "))
    .replace(/\s+/g, " ").trim();
}

/**
 * Select an actual policy sentence, not the first occurrence in a page title or
 * navigation. This is a conservative excerpt selector, not a legal interpreter.
 * Returned text is a contiguous source substring; missing evidence stays null.
 */
export function salvageProvincialGuidanceExcerpt(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim().slice(0, 120_000);
  const subjects = /\b(?:vehicles?|cars?|owners?|insurers?|salvage|rebuilt|irreparable|branding|written.off|write.off|total.loss|v[ée]hicules?|propri[ée]taires?|assureurs?|reconstruit|irr[ée]cup[ée]rable|perte totale)\b/gi;
  const policy = /\b(?:salvage|rebuilt|irreparable|brand(?:ing|ed)?|written.off|write.off|total.loss|structural inspection|safety inspection|reconstruit|irr[ée]cup[ée]rable|gravement accident[ée]|perte totale|inspection (?:m[ée]canique|structurale))\b/i;
  const statement = /\b(?:is|are|means?|must|cannot|can not|may|can|will|requires?|required|pass(?:es|ed)?|has|have|need(?:s)?|est|sont|signifie|doit|doivent|peut|peuvent|n[ée]cessite|exige)\b/i;
  const physicalSubject = /\b(?:vehicles?|cars?|owners?|insurers?|v[ée]hicules?|propri[ée]taires?|assureurs?)\b/i;
  const navigation = /\b(?:skip to (?:main|content)|sign[ -]in|log[ -]in|search submit|menu|newsletter|cookie preferences|se connecter|connexion|rechercher|navigation)\b/i;
  for (const match of text.matchAll(subjects)) {
    let start = match.index!;
    // Preserve a short introductory phrase such as "A vehicle" or "In Ontario,
    // vehicles", but never drag a long page title/menu into the selected text.
    const before = text.slice(Math.max(0, start - 40), start);
    const boundary = Math.max(before.lastIndexOf(". "), before.lastIndexOf("! "), before.lastIndexOf("? "));
    const prefix = before.slice(boundary < 0 ? 0 : boundary + 2);
    if ((start < 40 || boundary >= 0) && prefix.length <= 36 && !navigation.test(prefix)) start -= prefix.length;
    const rest = text.slice(start, start + 1001);
    const end = /[.!?](?=\s|$)/.exec(rest);
    const candidate = (end ? rest.slice(0, end.index + 1) : rest).trim();
    if (candidate.length < 50 || candidate.length > 1000 || navigation.test(candidate)) continue;
    // A heading followed by unrelated prose is not evidence of a policy. The
    // subject, policy topic and declarative/obligation wording must be nearby.
    const predicate = statement.exec(candidate.slice(0, 240));
    if (!policy.test(candidate.slice(0, 300)) || !predicate) continue;
    // A menu label such as "Vehicle branding ... A vehicle must ..." must
    // not borrow the later subject's predicate and masquerade as guidance.
    const subjectEnd = match.index! - start + match[0].length;
    if (physicalSubject.test(candidate.slice(subjectEnd, predicate.index))) continue;
    return candidate;
  }
  return null;
}

export interface SalvageFetchedEvidence { url: string; text: string; accessedAt: string; contentHash: string }

export async function fetchSalvageEvidence(rawUrl: string, deadlineAt: number): Promise<SalvageFetchedEvidence> {
  let target = safeSalvageEvidenceUrl(rawUrl);
  if (!target) throw new Error("Evidence URL is not public.");
  for (let redirect = 0; redirect <= 3; redirect++) {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new Error("Evidence retrieval deadline reached.");
    const response = await axios.get(target, {
      timeout: Math.min(15_000, remaining), signal: AbortSignal.timeout(Math.min(15_000, remaining)),
      responseType: "text", transformResponse: [(data: string) => data],
      maxContentLength: 2 * 1024 * 1024, maxBodyLength: 2 * 1024 * 1024,
      maxRedirects: 0, proxy: false, httpAgent, httpsAgent,
      validateStatus: (status) => status >= 200 && status < 400,
      headers: { Accept: "text/html,text/plain,application/json", "User-Agent": "AssetInsight-Evidence/2.0" },
    });
    if (response.status >= 300) {
      const next = safeSalvageEvidenceUrl(new URL(String(response.headers.location || ""), target).href);
      if (!next || next === target) throw new Error("Evidence redirect is not public.");
      target = next;
      continue;
    }
    if (!/^(text\/(html|plain)|application\/(json|ld\+json|xhtml\+xml))(;|$)/i.test(String(response.headers["content-type"] || ""))) {
      throw new Error("Evidence is not a supported public text page.");
    }
    const text = evidenceText(String(response.data || "")).slice(0, 120_000);
    if (text.length < 30) throw new Error("No readable public evidence was returned.");
    return { url: target, text, accessedAt: new Date().toISOString(), contentHash: createHash("sha256").update(text).digest("hex") };
  }
  throw new Error("Evidence redirect limit reached.");
}

/** Latest official observation on/before valuation date, within a bounded holiday lookback. */
export async function fetchSalvageExchangeRate(currency: string, date: string, deadlineAt: number): Promise<{ cadPerUnit: number; date: string; reference: Record<string, unknown> } | null> {
  if (!/^[A-Z]{3}$/.test(currency) || currency === "CAD" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const series = `FX${currency}CAD`;
  const valuationTime = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(valuationTime)) return null;
  const startDate = new Date(valuationTime - 7 * 86400000).toISOString().slice(0, 10);
  const url = `https://www.bankofcanada.ca/valet/observations/${series}/json?start_date=${startDate}&end_date=${date}`;
  try {
    const fetched = await fetchSalvageEvidence(url, deadlineAt);
    const payload = JSON.parse(fetched.text);
    const observation = Array.isArray(payload.observations) ? payload.observations.filter((item: any) =>
      typeof item.d === "string" && item.d >= startDate && item.d <= date && Number(item[series]?.v) > 0)
      .sort((a: any, b: any) => b.d.localeCompare(a.d))[0] : null;
    const rate = Number(observation?.[series]?.v);
    if (!Number.isFinite(rate) || rate <= 0) return null;
    return { cadPerUnit: rate, date: observation.d, reference: { id: `ref-boc-${currency.toLowerCase()}-${observation.d}`, kind: "web", url,
      title: `Bank of Canada ${currency}/CAD daily exchange rate (${observation.d})`, publisher: "Bank of Canada", accessedAt: fetched.accessedAt,
      excerpt: JSON.stringify(observation), photoIds: [] } };
  } catch { return null; }
}
