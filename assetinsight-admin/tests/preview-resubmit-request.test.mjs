import assert from "node:assert/strict";
import test from "node:test";
import { PreviewResubmitRequestError, readPreviewResubmitRequest } from "../lib/previewResubmitRequest.ts";

const url = "https://admin.example.test/api/admin/preview-reports/0123456789abcdef01234567/resubmit";
function request(body = { baseRevision: "revision-7" }, headers = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://admin.example.test", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
async function rejectsStatus(input, status) {
  await assert.rejects(readPreviewResubmitRequest(input), (error) => error instanceof PreviewResubmitRequestError && error.status === status);
}

test("forwards only the exact loaded revision, never caller report data or actor", async () => {
  assert.deepEqual(await readPreviewResubmitRequest(request({ baseRevision: "r1/opaque:value=", actor: "forged", data: { lots: [] }, approved: true })), { baseRevision: "r1/opaque:value=" });
});
test("accepts same-origin browser and trusted reverse-proxy origin", async () => {
  assert.deepEqual(await readPreviewResubmitRequest(request(undefined, { "sec-fetch-site": "same-origin" })), { baseRevision: "revision-7" });
  const proxied = new Request("http://localhost:3001/api/resubmit", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://admin.example.test", "x-forwarded-host": "admin.example.test", "x-forwarded-proto": "https" }, body: JSON.stringify({ baseRevision: "r1" }),
  });
  assert.deepEqual(await readPreviewResubmitRequest(proxied), { baseRevision: "r1" });
});
test("rejects cross-site and same-site sibling origins, including forged fetch-site mismatch", async () => {
  for (const headers of [{ Origin: "https://other.example.test" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { Origin: "null" }, { "sec-fetch-site": "same-origin", Origin: "https://other.example.test" }]) await rejectsStatus(request(undefined, headers), 403);
});
test("missing browser origin evidence is rejected, same-origin fetch metadata remains supported", async () => {
  for (const fetchSite of [undefined, "none"]) {
    const input = request(); input.headers.delete("origin");
    if (fetchSite) input.headers.set("sec-fetch-site", fetchSite);
    await rejectsStatus(input, 403);
  }
  const input = request(); input.headers.delete("origin"); input.headers.set("sec-fetch-site", "same-origin");
  assert.deepEqual(await readPreviewResubmitRequest(input), { baseRevision: "revision-7" });
});
test("requires JSON and a nonempty bounded string revision", async () => {
  await rejectsStatus(request(undefined, { "content-type": "text/plain" }), 415);
  for (const body of [null, [], {}, { baseRevision: 7 }, { baseRevision: " " }, { baseRevision: "r".repeat(513) }, "{"] ) await rejectsStatus(request(body), 400);
});
test("rejects oversized declared and actual bodies including chunked requests", async () => {
  await rejectsStatus(request(undefined, { "content-length": "2049" }), 413);
  await rejectsStatus(request({ baseRevision: "r1", extra: "x".repeat(2048) }), 413);
  const input = new Request(url, {
    method: "POST", duplex: "half", headers: { "Content-Type": "application/json", Origin: "https://admin.example.test" },
    body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024)); controller.enqueue(new Uint8Array(1025)); controller.close(); } }),
  });
  await rejectsStatus(input, 413);
});
test("invalid encoded JSON cannot bypass parsing", async () => {
  const input = new Request(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://admin.example.test" }, body: new Uint8Array([0xff, 0xff]) });
  await rejectsStatus(input, 400);
});
