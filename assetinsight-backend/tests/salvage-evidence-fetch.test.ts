import { afterEach, describe, expect, it, vi } from "vitest";
import axios from "axios";
import dns from "node:dns";
import sharp from "sharp";
import { evidenceText, fetchSalvageEvidence, fetchSalvageExchangeRate, isPublicEvidenceAddress, safeSalvageEvidenceUrl, salvageProvincialGuidanceExcerpt } from "../src/service/salvageEvidenceFetch.js";
import { prepareSalvagePhotos } from "../src/service/salvageImagePreparation.js";

afterEach(() => vi.restoreAllMocks());
describe("Public salvage source retrieval", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.1.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2002:7f00:1::", "2001:db8::1"])("rejects non-public destination %s", (ip) => {
    expect(isPublicEvidenceAddress(ip)).toBe(false);
  });
  it.each(["8.8.8.8", "93.184.216.34", "2001:4860:4860::8888"])("accepts globally routable address %s", (ip) => {
    expect(isPublicEvidenceAddress(ip)).toBe(true);
  });
  it.each(["file:///etc/passwd", "http://user:secret@example.com", "http://127.1", "http://2130706433", "http://localhost/", "http://example.internal/", "https://example.com:4000/"])("rejects unsafe URL %s", (url) => {
    expect(safeSalvageEvidenceUrl(url)).toBeNull();
  });
  it("strips tracking and fragment while preserving listing query identity", () => {
    expect(safeSalvageEvidenceUrl("https://example.com/lot?id=25&utm_source=test#image")).toBe("https://example.com/lot?id=25");
  });
  it("bounds retrieval and rejects redirect to loopback without making that request", async () => {
    const get = vi.spyOn(axios, "get").mockResolvedValue({ status: 302, headers: { location: "http://127.0.0.1/metadata" }, data: "" });
    await expect(fetchSalvageEvidence("https://example.com/lot", Date.now() + 30000)).rejects.toThrow("not public");
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][1]).toMatchObject({ maxRedirects: 0, proxy: false, timeout: 15000, maxContentLength: 2 * 1024 * 1024 });
  });
  it("checks DNS answers at actual socket lookup, including rebinding to private ranges", async () => {
    const get = vi.spyOn(axios, "get").mockResolvedValue({ status: 200, headers: { "content-type": "text/html" }, data: "<p>A Canadian public listing with readable details.</p>" });
    await fetchSalvageEvidence("https://example.com/lot", Date.now() + 30000);
    const options = get.mock.calls[0][1] as any;
    const lookup = options.httpsAgent.options.lookup;
    vi.spyOn(dns, "lookup").mockImplementation(((_host: any, _options: any, callback: any) => callback(null, [{ address: "127.0.0.1", family: 4 }])) as any);
    const error = await new Promise<any>((resolve) => lookup("example.com", {}, (err: any) => resolve(err)));
    expect(error.code).toBe("EACCES");
    expect(options.httpAgent.options.lookup).toBe(lookup);
  });
  it("does not execute or preserve embedded script/style instructions as evidence", () => {
    expect(evidenceText('<style>secret{}</style><script>fetch("private")</script><p>Sold CAD&nbsp;4,500 &#38; GST</p>')).toBe("Sold CAD 4,500 & GST");
  });
  it("retrieves exact or latest prior Bank of Canada rate without making up holiday rates", async () => {
    const get = vi.spyOn(axios, "get").mockResolvedValue({ status: 200, headers: { "content-type": "application/json" },
      data: JSON.stringify({ observations: [{ d: "2026-09-08", FXUSDCAD: { v: "1.37" } }] }) });
    const fx = await fetchSalvageExchangeRate("USD", "2026-09-08", Date.now() + 30000);
    expect(fx).toMatchObject({ cadPerUnit: 1.37, date: "2026-09-08" });
    expect(fx?.reference.excerpt).toBe('{"d":"2026-09-08","FXUSDCAD":{"v":"1.37"}}');
    expect(get.mock.calls[0][0]).toBe("https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?start_date=2026-09-01&end_date=2026-09-08");
    get.mockResolvedValue({ status: 200, headers: { "content-type": "application/json" }, data: JSON.stringify({ observations: [
      { d: "2026-09-01", FXUSDCAD: { v: "1.35" } }, { d: "2026-09-04", FXUSDCAD: { v: "1.36" } }, { d: "2026-09-08", FXUSDCAD: { v: "1.37" } },
    ] }) });
    expect(await fetchSalvageExchangeRate("USD", "2026-09-06", Date.now() + 30000)).toMatchObject({ cadPerUnit: 1.36, date: "2026-09-04" });
    get.mockResolvedValue({ status: 200, headers: { "content-type": "application/json" }, data: '{"observations":[]}' });
    expect(await fetchSalvageExchangeRate("USD", "2026-09-06", Date.now() + 30000)).toBeNull();
  });
});

describe("Substantive provincial guidance excerpts", () => {
  const navigation = "Mandatory Vehicle Branding Program | ontario.ca Skip to main content Log in to continue Please log in for full account access. Government of Ontario home page Search Submit Français FR Search Topics Menu Sign in close Benefits and taxes Business and economy Driving and road safety Vehicle branding Salvage inspections ServiceOntario Account";

  it.each([null, undefined, 123, "", "Mandatory Vehicle Branding Program", navigation,
    "Salvage rebuilt irreparable vehicle branding. Search the website for more information.",
    "Vehicle branding is available from the navigation menu; sign in for account access.",
  ])("does not invent guidance from missing text, headings or navigation (%s)", (value) => {
    expect(salvageProvincialGuidanceExcerpt(value)).toBeNull();
  });

  it("selects body guidance after an unpunctuated title/navigation prefix", () => {
    // Controlled parser fixture, not a statement of current provincial law.
    const body = "A vehicle branded as salvage must pass a structural inspection before its brand can be changed to rebuilt.";
    const source = `${navigation} ${body} More information about fees and forms follows.`;
    const excerpt = salvageProvincialGuidanceExcerpt(source);
    expect(excerpt).toBe(body.slice(2)); // Begins at the first substantive subject after the menu.
    expect(source).toContain(excerpt!);
    expect(excerpt).not.toMatch(/menu|log in|skip to/i);
  });

  it("preserves exact source wording rather than generating a policy summary", () => {
    const sentence = "In this example, a vehicle is written off when the documented repair cost exceeds its assessed value.";
    expect(salvageProvincialGuidanceExcerpt(sentence)).toBe(sentence);
    expect(salvageProvincialGuidanceExcerpt("Vehicle status. A rebuilt vehicle may require a safety inspection before registration is completed."))
      .toBe("A rebuilt vehicle may require a safety inspection before registration is completed.");
  });

  it("can retain a substantive French provincial source sentence", () => {
    const sentence = "Un véhicule gravement accidenté doit subir une inspection mécanique avant de pouvoir être remis en circulation.";
    expect(salvageProvincialGuidanceExcerpt(sentence)).toBe(sentence);
  });

  it("does not turn adjacent title-only terms into evidence or truncate an oversized sentence", () => {
    expect(salvageProvincialGuidanceExcerpt(`Vehicle branding ${"unrelated website text ".repeat(20)} must be accessible.`)).toBeNull();
    expect(salvageProvincialGuidanceExcerpt(`A salvage vehicle must ${"retain documented inspection evidence ".repeat(50)}.`)).toBeNull();
  });
});

describe("Fifty-photo preparation", () => {
  it("preserves all fifty originals and limits conversions to four", async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } }).png().toBuffer();
    let active = 0, peak = 0;
    const get = vi.spyOn(axios, "get").mockImplementation(async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1)); active--;
      return { data: png };
    });
    const urls = Array.from({ length: 50 }, (_, i) => `https://assetinsight.pro/${i}.png`);
    const prepared = await prepareSalvagePhotos(urls);
    expect(prepared).toHaveLength(50); expect(peak).toBeLessThanOrEqual(4);
    expect(get.mock.calls.map(([url]) => url)).toEqual(urls);
    expect(prepared.every((photo) => photo.width === 4 && photo.height === 4 && photo.buffer[0] === 0xff)).toBe(true);
  });
});
