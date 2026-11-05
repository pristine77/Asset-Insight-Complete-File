import assert from "node:assert/strict";
import test from "node:test";
import { readInitialPreviewRetryRequest } from "../lib/previewResubmitRequest.ts";
const revision = "a".repeat(64);
function request(body = { baseRevision: revision }, headers = {}) {
  return new Request("https://admin.example.test/api/admin/preview-reports/0123456789abcdef01234567/retry-preview", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: "https://admin.example.test", ...headers }, body: JSON.stringify(body),
  });
}
test("initial retry forwards only an exact revision", async () => {
  assert.deepEqual(await readInitialPreviewRetryRequest(request()), { baseRevision: revision });
});
test("initial retry refuses forged source, owner and approval fields", async () => {
  for (const extra of [{ actorId: "forged" }, { source: {} }, { approved: true }]) {
    await assert.rejects(readInitialPreviewRetryRequest(request({ baseRevision: revision, ...extra })), { status: 400 });
  }
});
test("initial retry requires a valid revision", async () => {
  for (const value of [null, [], {}, { baseRevision: "" }, { baseRevision: "x".repeat(64) }, { baseRevision: revision + "a" }]) {
    await assert.rejects(readInitialPreviewRetryRequest(request(value)), { status: 400 });
  }
});
test("initial retry keeps same-origin and bounded JSON requirements", async () => {
  await assert.rejects(readInitialPreviewRetryRequest(request(undefined, { Origin: "https://other.example.test" })), { status: 403 });
  await assert.rejects(readInitialPreviewRetryRequest(request(undefined, { "content-type": "text/plain" })), { status: 415 });
  await assert.rejects(readInitialPreviewRetryRequest(request({ baseRevision: revision, extra: "x".repeat(2048) })), { status: 413 });
});
