import assert from "node:assert/strict";
import test from "node:test";
import { PreviewResubmitRequestError, readPreviewTransferRequest } from "../lib/previewResubmitRequest.ts";

const origin = "https://admin.example.test";
const targetUserId = "0123456789abcdef01234567";
function request(body = { targetUserId }, headers = {}) {
  return new Request(`${origin}/api/admin/preview-reports/${targetUserId}/transfer`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...headers },
    body: JSON.stringify(body),
  });
}
const rejects = (input, status) => assert.rejects(readPreviewTransferRequest(input), (error) => error instanceof PreviewResubmitRequestError && error.status === status);

test("reassignment forwards only the selected account, never forged actor/owner/report fields", async () => {
  assert.deepEqual(await readPreviewTransferRequest(request({ targetUserId, actorId: "forged", owner: "forged", approved: true })), { targetUserId });
});
test("reassignment requires a valid selected account ID", async () => {
  for (const value of [null, 123, "", "../other", "f".repeat(23), "g".repeat(24)]) await rejects(request({ targetUserId: value }), 400);
  await rejects(request([]), 400);
});
test("reassignment rejects foreign and sibling origins before forwarding", async () => {
  await rejects(request(undefined, { Origin: "https://other.example.test" }), 403);
  await rejects(request(undefined, { "sec-fetch-site": "same-site" }), 403);
});
test("reassignment rejects non-JSON and oversized input", async () => {
  await rejects(request(undefined, { "Content-Type": "text/plain" }), 415);
  await rejects(request({ targetUserId, extra: "x".repeat(2048) }), 413);
});
