"use client";

import { useState } from "react";

const PUBLIC_API_BASE_URL =
  process.env.NEXT_PUBLIC_SERVER_URL || "https://api.assetinsightvaluator.com";

const API_TEST_PRESETS = [
  { label: "Users", url: "/api/v1/users?limit=5" },
  { label: "Assets", url: "/api/v1/assets?limit=5" },
  { label: "Lot listings", url: "/api/v1/lot-listings?limit=5" },
  { label: "Lots", url: "/api/v1/lots?limit=5" },
  { label: "CRM leads", url: "/api/v1/crm/leads?limit=5" },
] as const;

type ApiTestResult = {
  ok: boolean;
  status: number;
  statusText?: string;
  url: string;
  data: unknown;
};

export default function ApiTester() {
  const [apiKey, setApiKey] = useState("");
  const [requestUrl, setRequestUrl] = useState("/api/v1/assets?limit=5");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ApiTestResult | null>(null);

  async function runRequest() {
    const key = apiKey.trim();
    const url = requestUrl.trim();
    setError("");
    setResult(null);

    if (!key) {
      setError("Enter an API key.");
      return;
    }
    if (!url) {
      setError("Enter a request URL.");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/public-api-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: key, url }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.message || "Failed to run API request");
      setResult(json as ApiTestResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to run API request");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section id="try-api" className="mt-10 rounded-3xl border border-blue-200 bg-white p-5 shadow-sm md:p-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.18em] text-blue-700">
            Live tester
          </p>
          <h2 className="mt-2 text-2xl font-bold">Try the API</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            Test a read-only GET request with an API key. No admin login is required.
          </p>
        </div>
        <div className="break-all rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700">
          Base: {PUBLIC_API_BASE_URL}
        </div>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <label className="block">
          <span className="text-sm font-semibold text-slate-700">API key</span>
          <input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="cvak_..."
            autoComplete="off"
            className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 text-sm shadow-sm outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-100"
          />
        </label>
        <label className="block">
          <span className="text-sm font-semibold text-slate-700">Request URL</span>
          <input
            value={requestUrl}
            onChange={(event) => setRequestUrl(event.target.value)}
            placeholder="/api/v1/assets?limit=5"
            className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2.5 font-mono text-sm shadow-sm outline-none transition focus:border-blue-500 focus:ring-4 focus:ring-blue-100"
          />
          <span className="mt-1 block text-xs text-slate-500">
            Use /api/v1/... or the full backend URL. GET requests only.
          </span>
        </label>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {API_TEST_PRESETS.map((preset) => (
          <button
            key={preset.url}
            type="button"
            onClick={() => setRequestUrl(preset.url)}
            className={`rounded-xl border px-3 py-2 text-sm font-semibold transition ${
              requestUrl === preset.url
                ? "border-blue-600 bg-blue-600 text-white"
                : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            {preset.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => void runRequest()}
          disabled={loading}
          className="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "Running..." : "Run Request"}
        </button>
      </div>

      {error ? (
        <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700">
          {error}
        </div>
      ) : null}

      {result ? (
        <div className="mt-5 space-y-3">
          <div
            className={`rounded-2xl border p-3 text-sm font-medium ${
              result.ok
                ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                : "border-red-200 bg-red-50 text-red-800"
            }`}
          >
            Status {result.status}
            {result.statusText ? ` ${result.statusText}` : ""} -{" "}
            <span className="break-all font-mono">{result.url}</span>
          </div>
          <pre className="max-h-[520px] overflow-auto rounded-2xl border border-slate-800 bg-slate-950 p-4 text-sm leading-6 text-slate-100">
            <code>{JSON.stringify(result.data, null, 2)}</code>
          </pre>
        </div>
      ) : null}
    </section>
  );
}
