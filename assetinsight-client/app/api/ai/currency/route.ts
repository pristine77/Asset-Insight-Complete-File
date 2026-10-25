import { NextResponse } from "next/server";

export const runtime = "nodejs";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL_TEXT = process.env.OPENAI_MODEL_TEXT || "gpt-4.1-mini";

// Small fallback map for common locales/regions -> currencies
const REGION_TO_CCY: Record<string, string> = {
  US: "USD",
  CA: "CAD",
  GB: "GBP",
  UK: "GBP",
  AU: "AUD",
  NZ: "NZD",
  IN: "INR",
  JP: "JPY",
  CN: "CNY",
  SG: "SGD",
  AE: "AED",
  SA: "SAR",
  BR: "BRL",
  MX: "MXN",
  LK: "LKR",
  PK: "PKR",
  BD: "BDT",
  ZA: "ZAR",
  NG: "NGN",
  PH: "PHP",
  MY: "MYR",
  TH: "THB",
  ID: "IDR",
  KR: "KRW",
  HK: "HKD",
  TW: "TWD",
  AR: "ARS",
  CL: "CLP",
  CO: "COP",
  PE: "PEN",
  VE: "VES",
  TR: "TRY",
  EG: "EGP",
  KE: "KES",
  GH: "GHS",
  VN: "VND",
  EU: "EUR",
  FR: "EUR",
  DE: "EUR",
  ES: "EUR",
  IT: "EUR",
  NL: "EUR",
  IE: "EUR",
  PT: "EUR",
  BE: "EUR",
};

const COUNTRY_TO_CCY: Record<string, string> = {
  "united states": "USD",
  usa: "USD",
  canada: "CAD",
  india: "INR",
  "sri lanka": "LKR",
  "united kingdom": "GBP",
  england: "GBP",
  scotland: "GBP",
  wales: "GBP",
  australia: "AUD",
  "new zealand": "NZD",
  japan: "JPY",
  china: "CNY",
  singapore: "SGD",
  "united arab emirates": "AED",
  "saudi arabia": "SAR",
  brazil: "BRL",
  mexico: "MXN",
  france: "EUR",
  germany: "EUR",
  spain: "EUR",
  italy: "EUR",
  netherlands: "EUR",
  ireland: "EUR",
  portugal: "EUR",
  belgium: "EUR",
};

function heuristicCurrency(
  location?: string | null,
  acceptLanguage?: string | null
): string | null {
  try {
    const loc = String(location || "").toLowerCase();
    if (loc) {
      // Try country keywords
      for (const [k, v] of Object.entries(COUNTRY_TO_CCY)) {
        if (loc.includes(k)) return v;
      }
      // Try region code patterns like "+1 US", etc.
      const m = loc.match(/\b([A-Z]{2})\b/i);
      if (m && REGION_TO_CCY[m[1].toUpperCase()])
        return REGION_TO_CCY[m[1].toUpperCase()];
    }
    // Fallback to accept-language region
    if (acceptLanguage) {
      const primary = acceptLanguage.split(",")[0] || "";
      const region = (primary.split("-")[1] || "").toUpperCase();
      if (REGION_TO_CCY[region]) return REGION_TO_CCY[region];
    }
  } catch {}
  return null;
}

export async function POST(req: Request) {
  try {
    console.log("currency", req.body);
    console.log("currency", req.headers);
    console.log("currency", req.url);
    console.log("currency", req.method);
    const acceptLanguage = req.headers.get("accept-language") || "";
    let body: any = {};
    try {
      body = await req.json();
    } catch {}
    const locationRaw: string | undefined =
      typeof body?.location === "string" ? body.location : undefined;
    const lat: number | null =
      typeof body?.lat === "number"
        ? body.lat
        : typeof body?.lat === "string"
        ? parseFloat(body.lat)
        : null;
    const lng: number | null =
      typeof body?.lng === "number"
        ? body.lng
        : typeof body?.lng === "string"
        ? parseFloat(body.lng)
        : null;

    // 1) If geolocation provided, reverse geocode to country and map
    let currency: string | null = null;
    if (Number.isFinite(lat as any) && Number.isFinite(lng as any)) {
      try {
        const ua = process.env.NOMINATIM_USER_AGENT || "clearvalue-app/1.0";
        const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=3&addressdetails=1`;
        const resp = await fetch(url, { headers: { 'User-Agent': ua } });
        if (resp.ok) {
          const data = await resp.json();
          const cc2 = String(data?.address?.country_code || '').toUpperCase();
          console.log('[CurrencyAPI] Reverse geocode result', { lat, lng, cc2 });
          if (cc2 && REGION_TO_CCY[cc2]) {
            currency = REGION_TO_CCY[cc2];
          }
        }
        if (!currency) {
          // Secondary provider (no key required)
          const url2 = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`;
          const resp2 = await fetch(url2);
          if (resp2.ok) {
            const j2 = await resp2.json();
            const cc2b = String(j2?.countryCode || '').toUpperCase();
            console.log('[CurrencyAPI] Reverse geocode (BDC) result', { lat, lng, cc2b });
            if (cc2b && REGION_TO_CCY[cc2b]) {
              currency = REGION_TO_CCY[cc2b];
            }
          }
        }
      } catch {}
    }

    // 2) If still not found and a free-form location string is provided, try OpenAI
    if (!currency && OPENAI_API_KEY && locationRaw && String(locationRaw).trim().length > 1) {
      try {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: MODEL_TEXT,
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content:
                  "You are a helpful assistant that maps a user location (free‑form city/region/country) to a single ISO 4217 currency code. Respond with JSON only.",
              },
              {
                role: "user",
                content: `Location: ${locationRaw}\nIf unknown, infer from Accept-Language: ${acceptLanguage || "(none)"}.\nReturn JSON like {\"currency\":\"USD\"}.`,
              },
            ],
            temperature: 0.2,
          }),
        });
        console.log('[CurrencyAPI] OpenAI status', res.status);
        if (res.ok) {
          const data = await res.json();
          const content: string = data?.choices?.[0]?.message?.content || "";
          try {
            const parsed = JSON.parse(content || "{}");
            const c = String(parsed?.currency || parsed?.ccy || "").toUpperCase();
            if (/^[A-Z]{3}$/.test(c)) currency = c;
          } catch {}
        }
      } catch {}
    }

    // 3) Final fallback: Accept-Language / keyword heuristic
    if (!currency) {
      currency = heuristicCurrency(locationRaw, acceptLanguage) || "CAD";
      console.log('[CurrencyAPI] Heuristic currency', { acceptLanguage, locationRaw, currency });
    }

    console.log("currency", currency);
    return NextResponse.json({ currency }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Failed to detect currency" },
      { status: 500 }
    );
  }
}
