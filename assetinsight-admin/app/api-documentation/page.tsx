import Link from "next/link";
import ApiTester from "./ApiTester";

const SERVER_URL =
  process.env.NEXT_PUBLIC_SERVER_URL || "https://api.assetinsightvaluator.com";

const endpoints = [
  {
    method: "GET",
    path: "/api/v1/users",
    description: "List active, verified users that can be assigned by an integration.",
    input: "page, limit, q, updatedAfter",
  },
  {
    method: "GET",
    path: "/api/v1/assets",
    description: "List approved and released Asset report summaries.",
    input: "page, limit, q, from, to, updatedAfter, contractNo",
  },
  {
    method: "GET",
    path: "/api/v1/assets/:id",
    description: "Get one approved Asset report with its lots, media, and generated files.",
    input: "Asset report Mongo ID; optional includeImageBase64=true, imagePage, imageLimit",
  },
  {
    method: "GET",
    path: "/api/v1/assets/:id/images",
    description: "Get ordered Asset images with both the saved R2 URL and Base64 bytes.",
    input: "Asset report Mongo ID; page, limit (maximum 5)",
  },
  {
    method: "GET",
    path: "/api/v1/assets/:id/lots",
    description: "List every lot saved in one approved Asset report.",
    input: "Asset report Mongo ID",
  },
  {
    method: "GET",
    path: "/api/v1/assets/:id/lots/:lotId",
    description: "Get one Asset lot by its lot_id or visible lot_number.",
    input: "Asset report ID and lot identifier; optional includeImageBase64=true, imagePage, imageLimit",
  },
  {
    method: "GET",
    path: "/api/v1/assets/:id/lots/:lotId/images",
    description: "Get one Asset lot's ordered images with R2 URLs and Base64 bytes.",
    input: "Asset report ID and lot identifier; page, limit (maximum 5)",
  },
  {
    method: "GET",
    path: "/api/v1/lot-listings",
    description: "List approved and released Lot Listing summaries.",
    input: "page, limit, q, from, to, updatedAfter, contractNo",
  },
  {
    method: "GET",
    path: "/api/v1/lot-listings/:id",
    description: "Get one Lot Listing with full lot data, media, and generated files.",
    input: "Lot Listing Mongo ID; optional includeImageBase64=true, imagePage, imageLimit",
  },
  {
    method: "GET",
    path: "/api/v1/lot-listings/:id/images",
    description: "Get ordered Lot Listing images with both the saved R2 URL and Base64 bytes.",
    input: "Lot Listing Mongo ID; page, limit (maximum 5)",
  },
  {
    method: "GET",
    path: "/api/v1/lot-listings/:id/lots",
    description: "List every lot saved in one approved Lot Listing.",
    input: "Lot Listing Mongo ID",
  },
  {
    method: "GET",
    path: "/api/v1/lot-listings/:id/lots/:lotId",
    description: "Get one Lot Listing lot by its lot_id or visible lot_number.",
    input: "Lot Listing ID and lot identifier; optional includeImageBase64=true, imagePage, imageLimit",
  },
  {
    method: "GET",
    path: "/api/v1/lot-listings/:id/lots/:lotId/images",
    description: "Get one Lot Listing lot's ordered images with R2 URLs and Base64 bytes.",
    input: "Lot Listing ID and lot identifier; page, limit (maximum 5)",
  },
  {
    method: "GET",
    path: "/api/v1/lots",
    description: "Return a combined, paginated lot feed from approved reports.",
    input: "source=asset|lot-listing, page, limit, q, contractNo, date filters",
  },
  {
    method: "GET",
    path: "/api/v1/crm/leads",
    description: "List CRM leads, including assignment and latest workflow information.",
    input: "page, limit, q, status, updatedAfter",
  },
  {
    method: "GET",
    path: "/api/v1/crm/leads/:id",
    description: "Get one CRM lead with its complete update history.",
    input: "CRM lead Mongo ID",
  },
  {
    method: "POST",
    path: "/api/v1/crm/leads/:id/reply",
    description: "Add a CRM comment and optionally advance the lead status.",
    input: "JSON: comment (required), status, lostReason",
  },
] as const;

const auctioneerDeliveryEndpoints = [
  {
    method: "PATCH",
    path: "/api/external/lots/:lotId",
    description: "Updates the mapped Auctioneer lot with approved CR data and estimated value.",
  },
  {
    method: "POST",
    path: "/api/external/lots/:lotId/complete-cr",
    description: "Completes the condition report and sends its estimated value to the Lien Tracker Board.",
  },
] as const;

const auctioneerRequestFields = [
  ["estimatedValue", "string", "Numeric value without currency symbols or commas, for example 15000."],
  ["conditionReport", "string", "Approved condition report text assembled from the saved lot."],
  ["destination", "string", "LottingBoard or OpToDoBoard. Used by complete-cr."],
  ["opTaskDescription", "string", "Required only when the selected destination is OpToDoBoard."],
  ["completedBy", "string", "Name or email of the Asset Insight user completing the CR."],
  ["submissionGuid", "string", "Auctioneer submission identifier when one is available."],
] as const;

const requestSamples = [
  {
    title: "List assets",
    description: "Use this for dashboards, sync jobs, or catalog pages.",
    request: `GET ${SERVER_URL}/api/v1/assets
Query: page=1&limit=25&q=excavator
Query: from=2026-01-01&to=2026-12-31
Authorization: Bearer cvak_your_key_here`,
  },
  {
    title: "Get asset details",
    description: "Returns full report metadata, files, image URLs, preview data, and lots.",
    request: `GET ${SERVER_URL}/api/v1/assets/665f2a8c9f0d4d3b9e7b1234
x-api-key: cvak_your_key_here`,
  },
  {
    title: "Get image bytes for Auctioneer 2.0",
    description: "Returns a bounded page of ordered images. Each item keeps its R2 URL and adds raw Base64 for upload to Auctioneer's S3 bucket.",
    request: `GET ${SERVER_URL}/api/v1/assets/665f2a8c9f0d4d3b9e7b1234/images?page=1&limit=5
Authorization: Bearer cvak_your_key_here`,
  },
  {
    title: "List lots",
    description: "Flatten approved asset lots or approved lot-listing lots into one paginated feed.",
    request: `GET ${SERVER_URL}/api/v1/lots
Query: source=lot-listing&contractNo=CV-2026-104
Query: page=1&limit=50
Authorization: Bearer cvak_your_key_here`,
  },
  {
    title: "Reply to a CRM lead",
    description: "Adds an auditable comment and can update the lead workflow status.",
    request: `POST ${SERVER_URL}/api/v1/crm/leads/665f2a8c9f0d4d3b9e7b9999/reply
Content-Type: application/json
Authorization: Bearer cvak_your_key_here

{
  "comment": "Customer requested an inspection next week.",
  "status": "inspection_required"
}`,
  },
] as const;

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="max-w-full whitespace-pre-wrap break-words rounded-2xl border border-slate-800 bg-slate-950 p-4 text-sm leading-6 text-slate-100">
      <code>{children}</code>
    </pre>
  );
}

export default function ApiDocumentationPage() {
  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <section className="mx-auto max-w-5xl px-5 py-10 md:py-14">
        <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-blue-700">
              Asset Insight API
            </p>
            <h1 className="mt-3 text-3xl font-bold tracking-normal md:text-5xl">
              API Documentation
            </h1>
            <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
              Use API keys to access approved reports, lots, assignable users, and CRM lead
              workflows from trusted server-side integrations.
            </p>
          </div>
          <Link
            href="/login"
            className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-100"
          >
            Admin login
          </Link>
        </div>

        <div className="grid gap-5 md:grid-cols-3">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Base URL</div>
            <div className="mt-2 break-all font-mono text-sm">{SERVER_URL}</div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Auth</div>
            <div className="mt-2 font-mono text-sm">Authorization: Bearer cvak_...</div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Access</div>
            <div className="mt-2 text-sm">Reports, lots, users, and controlled CRM updates</div>
          </div>
        </div>

        <ApiTester />

        <section className="mt-10 space-y-4">
          <h2 className="text-2xl font-bold">Authentication</h2>
          <p className="text-slate-600">
            Send the API key from a backend service. Do not expose API keys in browser,
            mobile, or public client code. Every endpoint below requires the same API-key
            authentication.
          </p>
          <CodeBlock>{`curl "${SERVER_URL}/api/v1/assets?limit=10" \\
  -H "Authorization: Bearer cvak_your_key_here"`}</CodeBlock>
          <p className="text-sm text-slate-600">
            You can also send the key as <code className="rounded bg-slate-200 px-1">x-api-key</code>.
          </p>
        </section>

        <section className="mt-10 space-y-4">
          <h2 className="text-2xl font-bold">Request Format</h2>
          <div className="space-y-4">
            {requestSamples.map((sample) => (
              <div key={sample.title} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <h3 className="font-semibold">{sample.title}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">{sample.description}</p>
                <div className="mt-4">
                  <CodeBlock>{sample.request}</CodeBlock>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-10 space-y-4">
          <h2 className="text-2xl font-bold">Complete API Reference</h2>
          <p className="text-slate-600">
            This table documents every endpoint currently available under <code>/api/v1</code>.
          </p>
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
            <table className="min-w-[860px] w-full text-left text-sm">
              <thead className="bg-slate-100 text-xs uppercase tracking-[0.14em] text-slate-500">
                <tr>
                  <th className="px-4 py-3">Method</th>
                  <th className="px-4 py-3">Path</th>
                  <th className="px-4 py-3">What it does</th>
                  <th className="px-4 py-3">Inputs</th>
                </tr>
              </thead>
              <tbody>
                {endpoints.map((endpoint) => (
                  <tr key={`${endpoint.method}-${endpoint.path}`} className="border-t border-slate-200 align-top">
                    <td className={`px-4 py-3 font-mono font-semibold ${endpoint.method === "POST" ? "text-emerald-700" : "text-blue-700"}`}>
                      {endpoint.method}
                    </td>
                    <td className="px-4 py-3 font-mono">{endpoint.path}</td>
                    <td className="px-4 py-3 text-slate-700">{endpoint.description}</td>
                    <td className="px-4 py-3 text-slate-600">{endpoint.input}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mt-10 space-y-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.14em] text-red-700">
              Auctioneer 2.0 delivery
            </p>
            <h2 className="mt-2 text-2xl font-bold">Lot Update and CR Completion</h2>
            <p className="mt-2 max-w-3xl text-slate-600">
              These are outbound requests sent by Asset Insight to Auctioneer 2.0 after an
              approved report is delivered. They are not public <code>cvak_</code> endpoints.
              Both requests now include the saved lot valuation as <code>estimatedValue</code>.
            </p>
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
            <table className="min-w-[760px] w-full text-left text-sm">
              <thead className="bg-slate-100 text-xs uppercase tracking-[0.14em] text-slate-500">
                <tr>
                  <th className="px-4 py-3">Method</th>
                  <th className="px-4 py-3">Auctioneer path</th>
                  <th className="px-4 py-3">Purpose</th>
                </tr>
              </thead>
              <tbody>
                {auctioneerDeliveryEndpoints.map((endpoint) => (
                  <tr key={endpoint.path} className="border-t border-slate-200">
                    <td className="px-4 py-3 font-mono font-semibold text-red-700">{endpoint.method}</td>
                    <td className="px-4 py-3 font-mono">{endpoint.path}</td>
                    <td className="px-4 py-3 text-slate-700">{endpoint.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
            <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
              <table className="min-w-[620px] w-full text-left text-sm">
                <thead className="bg-slate-100 text-xs uppercase tracking-[0.14em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Field</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {auctioneerRequestFields.map(([field, type, description]) => (
                    <tr key={field} className="border-t border-slate-200 align-top">
                      <td className="px-4 py-3 font-mono font-semibold">{field}</td>
                      <td className="px-4 py-3 font-mono text-slate-600">{type}</td>
                      <td className="px-4 py-3 text-slate-700">{description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <CodeBlock>{`PATCH /api/external/lots/:lotId
{
  "estimatedValue": "15000",
  "conditionReport": "Starts and runs. Minor body wear."
}

POST /api/external/lots/:lotId/complete-cr
{
  "estimatedValue": "15000",
  "conditionReport": "Starts and runs. Minor body wear.",
  "destination": "LottingBoard",
  "completedBy": "user@example.com"
}`}</CodeBlock>
          </div>
        </section>

        <section className="mt-10 grid gap-6 md:grid-cols-2">
          <div className="space-y-4">
            <h2 className="text-2xl font-bold">Query Parameters</h2>
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <ul className="space-y-3 text-sm text-slate-700">
                <li><code>page</code>: defaults to 1.</li>
                <li><code>limit</code>: defaults to 25, maximum 100.</li>
                <li><code>q</code>: text search for report, lot, contract, and location fields.</li>
                <li><code>from</code> and <code>to</code>: filter by created date.</li>
                <li><code>updatedAfter</code>: filter by update date.</li>
                <li><code>contractNo</code>: filter by contract number.</li>
                <li><code>source</code>: only on <code>/api/v1/lots</code>, accepts <code>asset</code> or <code>lot-listing</code>.</li>
                <li><code>status</code>: only on <code>/api/v1/crm/leads</code>, filters the CRM workflow state.</li>
                <li><code>includeImageBase64</code>: on Asset/Lot Listing detail endpoints, set to <code>true</code> to include a bounded image page.</li>
                <li><code>imagePage</code> and <code>imageLimit</code>: page the optional Base64 data embedded in a detail response.</li>
                <li><code>page</code> and <code>limit</code>: on dedicated <code>/images</code> endpoints, default to page 1 with 2 images; image limit is capped at 5.</li>
              </ul>
            </div>
          </div>

          <div className="space-y-4">
            <h2 className="text-2xl font-bold">Errors</h2>
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <ul className="space-y-3 text-sm text-slate-700">
                <li><code>401 missing_api_key</code>: no key was sent.</li>
                <li><code>401 invalid_api_key</code>: key is malformed or unknown.</li>
                <li><code>403 revoked_api_key</code>: key has been revoked.</li>
                <li><code>429 rate_limited</code>: key exceeded the request limit.</li>
                <li><code>404 not_found</code>: approved record or lot was not found.</li>
                <li><code>422 image_encoding_failed</code>: an image could not be loaded safely from approved storage.</li>
              </ul>
            </div>
          </div>
        </section>

        <section className="mt-10 space-y-4">
          <h2 className="text-2xl font-bold">Response Shape</h2>
          <p className="text-slate-600">
            List endpoints return <code className="rounded bg-slate-200 px-1">data</code> plus pagination.
            Detail endpoints return one object in <code className="rounded bg-slate-200 px-1">data</code>.
          </p>
          <CodeBlock>{`{
  "data": [],
  "pagination": {
    "page": 1,
    "limit": 25,
    "total": 0,
    "totalPages": 0
  }
}`}</CodeBlock>
        </section>

        <section className="mt-10 space-y-4">
          <h2 className="text-2xl font-bold">Auctioneer Image Payloads</h2>
          <p className="max-w-3xl text-slate-600">
            Image endpoints are intended for trusted Auctioneer 2.0 server integrations.
            The <code>base64</code> field contains raw Base64 without a data-URL prefix. Use
            <code>content_type</code> when rebuilding the binary file, and continue requesting
            pages until <code>hasNextPage</code> is false. Images are returned lot-by-lot in
            saved photo order, and deleted preview images are excluded.
          </p>
          <CodeBlock>{`{
  "data": [
    {
      "url": "https://images.sellsnap.store/reports/photo-001.jpg",
      "base64": "/9j/4AAQSkZJRgABAQ...",
      "content_type": "image/jpeg",
      "filename": "lot-001-photo-001.jpg",
      "size_bytes": 1842331,
      "sha256": "64-character-sha256-checksum",
      "encoding": "base64",
      "order": 0,
      "lot_index": 0,
      "photo_index": 0
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 5,
    "total": 18,
    "totalPages": 4,
    "hasNextPage": true
  }
}`}</CodeBlock>
        </section>

        <section className="mt-10 space-y-4">
          <h2 className="text-2xl font-bold">Sample Data</h2>
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-3">
              <h3 className="text-lg font-semibold">Asset list response</h3>
              <CodeBlock>{`{
  "data": [
    {
      "_id": "665f2a8c9f0d4d3b9e7b1234",
      "type": "asset",
      "title": "Maple Ridge Equipment",
      "status": "approved",
      "grouping_mode": "mixed",
      "contract_no": "CV-2026-104",
      "currency": "CAD",
      "lot_count": 2,
      "image_count": 18,
      "total_value": 184000,
      "files": {
        "docx": "https://storage.example/reports/asset.docx",
        "excel": "https://storage.example/reports/asset.xlsx",
        "images": "https://storage.example/reports/images.zip"
      },
      "createdAt": "2026-05-12T15:24:10.000Z",
      "creator": {
        "email": "client@example.com",
        "companyName": "Maple Ridge Auctions"
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 25,
    "total": 1,
    "totalPages": 1
  }
}`}</CodeBlock>
            </div>

            <div className="space-y-3">
              <h3 className="text-lg font-semibold">Lot detail response</h3>
              <CodeBlock>{`{
  "data": {
    "lot_id": "LOT-002",
    "lot_number": 2,
    "title": "2019 CAT 299D3 Compact Track Loader",
    "description": "Cab, heat, auxiliary hydraulics, bucket included.",
    "condition": "Good used condition",
    "estimated_value": "CA$78,000",
    "quantity": 1,
    "serial_number": "CAT0299DJX900123",
    "image_indexes": [3, 4, 5],
    "image_urls": [
      "https://storage.example/images/lot-002-front.jpg"
    ]
  },
  "report": {
    "_id": "665f2a8c9f0d4d3b9e7b1234",
    "type": "asset",
    "title": "Maple Ridge Equipment",
    "contract_no": "CV-2026-104"
  }
}`}</CodeBlock>
            </div>
          </div>
        </section>

        <section className="mt-10 space-y-4">
          <h2 className="text-2xl font-bold">Lot Listing Example</h2>
          <CodeBlock>{`GET ${SERVER_URL}/api/v1/lot-listings?contractNo=CV-2026-104
Authorization: Bearer cvak_your_key_here

{
  "data": [
    {
      "_id": "665f2bb59f0d4d3b9e7b5678",
      "type": "lot-listing",
      "title": "CV-2026-104",
      "status": "approved",
      "contract_no": "CV-2026-104",
      "location": "Saskatoon, SK",
      "sales_date": "2026-06-15T00:00:00.000Z",
      "currency": "CAD",
      "lot_count": 34,
      "total_value": 412500,
      "files": {
        "excel": "https://storage.example/listings/CV-2026-104.xlsx",
        "images": "https://storage.example/listings/CV-2026-104-images.zip"
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 25,
    "total": 1,
    "totalPages": 1
  }
}`}</CodeBlock>
        </section>

        <section className="mt-10 space-y-4">
          <h2 className="text-2xl font-bold">Error Format</h2>
          <CodeBlock>{`{
  "error": {
    "code": "invalid_api_key",
    "message": "Invalid API key"
  }
}`}</CodeBlock>
        </section>

        <section className="mt-10 space-y-4">
          <h2 className="text-2xl font-bold">JavaScript Example</h2>
          <CodeBlock>{`const res = await fetch("${SERVER_URL}/api/v1/lot-listings?limit=25", {
  headers: {
    Authorization: "Bearer cvak_your_key_here"
  }
});

if (!res.ok) {
  throw new Error(await res.text());
}

const payload = await res.json();`}</CodeBlock>
        </section>
      </section>
    </main>
  );
}
