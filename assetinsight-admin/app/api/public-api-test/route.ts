import { NextResponse, type NextRequest } from "next/server";

const PUBLIC_API_BASE_URL =
  process.env.NEXT_PUBLIC_SERVER_URL ||
  process.env.SERVER_URL ||
  "https://api.assetinsightvaluator.com";

function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function resolveApiUrl(input: string) {
  const baseUrl = normalizeBaseUrl(PUBLIC_API_BASE_URL);
  const base = new URL(baseUrl);
  const raw = input.trim();
  if (!raw) throw new Error("Request URL is required");

  let url: URL;
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    url = new URL(raw);
    if (url.origin !== base.origin) {
      throw new Error(`URL must use ${base.origin}`);
    }
  } else {
    const path = raw.startsWith("/") ? raw : `/${raw}`;
    url = new URL(path, base);
  }

  if (!url.pathname.startsWith("/api/v1/")) {
    throw new Error("Only /api/v1 URLs can be tested");
  }

  return url;
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";
  const requestUrl = typeof body?.url === "string" ? body.url.trim() : "";

  if (!apiKey) {
    return NextResponse.json({ message: "API key is required" }, { status: 400 });
  }

  let targetUrl: URL;
  try {
    targetUrl = resolveApiUrl(requestUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request URL";
    return NextResponse.json({ message }, { status: 400 });
  }

  try {
    const upstream = await fetch(targetUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      cache: "no-store",
    });

    const text = await upstream.text();
    let data: unknown = text;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {}
    } else {
      data = null;
    }

    return NextResponse.json({
      ok: upstream.ok,
      status: upstream.status,
      statusText: upstream.statusText,
      url: targetUrl.toString(),
      data,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to run API request";
    return NextResponse.json({ message }, { status: 502 });
  }
}
