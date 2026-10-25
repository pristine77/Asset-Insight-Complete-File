import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { CAPTURE_STAGE_LABELS, captureQuery, captureRemovalBody, captureTime, isCaptureInventoryId, parseCaptureDetail, parseCaptureList, parseCaptureUsers } from "../lib/captureInventory.ts";
import { readPreviewMutationJson } from "../lib/previewResubmitRequest.ts";

const userId = "0123456789abcdef01234567";
const captureId = "11223344-5566-4789-8abc-def012345678";
const id = createHash("sha256").update(`${userId}:${captureId}`).digest("hex");
const user = { id: userId, username: "Fixture appraiser", email: "fixture@example.test", companyName: "Example", isBlocked: false };
const clock = "2026-09-17T10:30:00Z";
const row = () => ({
  id, captureId, schemaVersion: 1, revision: 4, reportType: "asset", clientSubmissionId: "stable-submission", contractNo: "93530", localStatus: "saved", creator: { ...user },
  device: { platform: "android", appVersion: "1.0.0", registrationId: null, verified: false },
  deviceCreatedAt: clock, deviceSavedAt: clock, firstCapturedAt: clock, lastCapturedAt: clock, firstReceivedAt: clock, lastReceivedAt: clock,
  counts: { lotCount: 1, photoCount: 2, mainPhotoCount: 1, extraPhotoCount: 1, availablePhotoCount: 1, missingPhotoCount: 1 },
  server: { stage: "not_uploaded", uploadedPhotoCount: null, expectedPhotoCount: null, reportId: null, uploadSessionId: null, uploadStartedAt: null, uploadCompletedAt: null, acceptedAt: null, previewSubmittedAt: null, processingCompletedAt: null, filesReady: false, previewAvailable: false, issue: null },
});
const list = (item = row()) => ({ data: { items: [item], total: 1, page: 1, limit: 25, pages: 1 } });
const detail = () => ({ data: { ...row(), lots: [{ id: "lot-1", lotNumber: "12A", title: "Truck", mainPhotoCount: 1, extraPhotoCount: 1, availablePhotoCount: 1, missingPhotoCount: 1 }], lotsPage: 1, lotsLimit: 25, lotsTotal: 1, lotsPages: 1 } });

test("accepts backend SHA-256 capture identities while keeping Mongo user filters separate", () => {
  assert.equal(id.length, 64);
  assert.equal(isCaptureInventoryId(id), true);
  assert.equal(parseCaptureList(list()).items[0].id, id);
  assert.equal(parseCaptureDetail(detail()).id, id);
  for (const value of [userId, captureId, "f".repeat(63), "f".repeat(65), "z".repeat(64), null]) {
    assert.equal(isCaptureInventoryId(value), false);
    assert.throws(() => parseCaptureList(list({ ...row(), id: value })));
  }
  assert.throws(() => captureQuery(new URLSearchParams({ userId: id }), "list"));
  assert.equal(new URLSearchParams(captureQuery(new URLSearchParams({ userId }), "list")).get("userId"), userId);
  const route = readFileSync(new URL("../app/api/admin/capture-inventory/[id]/route.ts", import.meta.url), "utf8");
  assert.equal(route.match(/if \(!isCaptureInventoryId\(id\)\)/g)?.length, 2);
  assert.doesNotMatch(route, /\{24\}/);
});

test("projects only public capture metadata and preserves unknown upload counts", () => {
  const input = row(); input.notes = "private"; input.photos = ["file:///private/photo.jpg"]; input.creator.token = "secret"; input.device.deviceKey = "private"; input.server.downloadUrl = "https://private.invalid";
  const output = parseCaptureList(list(input)).items[0];
  assert.equal(output.server.uploadedPhotoCount, null);
  assert.equal(output.server.expectedPhotoCount, null);
  assert.equal(output.counts.missingPhotoCount, 1);
  for (const secret of ["private", "secret", "downloadUrl", "photos", "notes", "deviceKey"]) assert.equal(JSON.stringify(output).includes(secret), false);
});
test("confirmed zero is distinct from unknown and generated files do not imply release", () => {
  const input = row(); input.server.uploadedPhotoCount = 0; input.server.expectedPhotoCount = 2; input.server.stage = "completed";
  assert.equal(parseCaptureList(list(input)).items[0].server.uploadedPhotoCount, 0);
  assert.equal(CAPTURE_STAGE_LABELS.completed, "Files generated");
});
test("missing creator display fields and absent optional clocks are supported", () => {
  const input = row(); input.creator = { ...user, username: null, email: null, companyName: null }; input.deviceCreatedAt = null; input.lastCapturedAt = null;
  const output = parseCaptureList(list(input)).items[0];
  assert.equal(output.creator.username, ""); assert.equal(output.creator.id, userId); assert.equal(output.lastCapturedAt, null);
  assert.equal(captureTime(null), "Not recorded"); assert.match(captureTime(clock), /UTC$/);
});
test("invalid financial-looking or missing counts never become zero", () => {
  for (const value of [undefined, null, -1, 1.2, "2", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const input = row(); input.counts.photoCount = value; assert.throws(() => parseCaptureList(list(input)), /could not be verified/);
  }
  for (const value of [-1, "0", 0.5]) {
    const input = row(); input.server.uploadedPhotoCount = value; assert.throws(() => parseCaptureList(list(input)));
  }
});
test("rejects malformed identities, statuses and server state", () => {
  for (const changes of [{ id: "../../" }, { captureId: "" }, { revision: 0 }, { reportType: "salvage" }, { localStatus: "uploaded" }, { lastReceivedAt: "nonsense" }]) assert.throws(() => parseCaptureList(list({ ...row(), ...changes })));
  for (const changes of [{ stage: "approved" }, { filesReady: "true" }, { previewAvailable: null }]) { const input = row(); Object.assign(input.server, changes); assert.throws(() => parseCaptureList(list(input))); }
  for (const payload of [null, [], {}, { data: [] }, { data: { items: [] } }, { data: { ...list().data, page: 0 } }, { data: { ...list().data, items: Array(101).fill(row()) } }]) assert.throws(() => parseCaptureList(payload));
});
test("supports empty synchronized history without fabricating records", () => {
  assert.deepEqual(parseCaptureList({ data: { items: [], total: 0, page: 1, limit: 25, pages: 0 } }), { items: [], total: 0, page: 1, limit: 25, pages: 0 });
});
test("validates and projects paginated lot metadata", () => {
  const input = detail(); input.data.lots[0].imageUri = "file:///private";
  const output = parseCaptureDetail(input); assert.equal(output.lots[0].lotNumber, "12A"); assert.equal(output.lotsPage, 1); assert.equal("imageUri" in output.lots[0], false);
  input.data.lots[0].missingPhotoCount = undefined; assert.throws(() => parseCaptureDetail(input));
  const badPage = detail(); badPage.data.lotsPage = 0; assert.throws(() => parseCaptureDetail(badPage));
});
test("validates bounded user search results", () => {
  assert.deepEqual(parseCaptureUsers({ data: { items: [user], hasMore: true } }), { items: [user], hasMore: true });
  for (const data of [{ items: [], hasMore: "false" }, { items: Array(51).fill(user), hasMore: true }, { items: [{ ...user, id: "" }], hasMore: false }]) assert.throws(() => parseCaptureUsers({ data }));
});
test("list query allowlist encodes user input and drops unsafe extra fields", () => {
  const result = new URLSearchParams(captureQuery(new URLSearchParams({ userId, search: "  93530 & 2  ", reportType: "lotListing", localStatus: "paused", page: "2", limit: "25", role: "superadmin", includeDeleted: "true", url: "https://example.invalid" }), "list"));
  assert.equal(result.get("search"), "93530 & 2"); assert.equal(result.get("userId"), userId); assert.equal(result.get("page"), "2");
  for (const key of ["role", "includeDeleted", "url"]) assert.equal(result.has(key), false);
});
test("detail and user query policies cannot forward list-only fields", () => {
  assert.equal(captureQuery(new URLSearchParams("lotsPage=2&lotsLimit=25&userId=forged"), "detail"), "lotsPage=2&lotsLimit=25");
  assert.equal(captureQuery(new URLSearchParams("search=User&limit=50&localStatus=saved"), "users"), "search=User&limit=50");
});
test("rejects duplicate, overlong and unsupported filter values", () => {
  for (const query of ["page=1&page=2", "userId=../../x", "reportType=salvage", "localStatus=deleted", "search=" + "a".repeat(101), "page=0", "page=1.5", "page=100001", "limit=101", "limit=-1"]) assert.throws(() => captureQuery(new URLSearchParams(query), "list"), query);
  assert.throws(() => captureQuery(new URLSearchParams("limit=51"), "users"));
  assert.throws(() => captureQuery(new URLSearchParams("lotsLimit=101"), "detail"));
});
test("synchronization date bounds are valid inclusive UTC days", () => {
  assert.equal(captureQuery(new URLSearchParams("receivedFrom=2026-09-17&receivedTo=2026-09-17"), "list"), "receivedFrom=2026-09-17&receivedTo=2026-09-17");
  for (const query of ["receivedFrom=2026-02-30", "receivedTo=09/17/2026", "receivedTo=2026-09-17T12:00:00Z", "receivedFrom=2026-09-18&receivedTo=2026-09-17"]) assert.throws(() => captureQuery(new URLSearchParams(query), "list"));
});
test("discarded-history removal allows only a positive loaded revision", () => {
  assert.deepEqual(captureRemovalBody({ revision: 4 }), { revision: 4 });
  for (const input of [{}, { revision: 0 }, { revision: -1 }, { revision: "4" }, { revision: NaN }, { revision: 1.5 }, { revision: 4, actor: "forged" }, { revision: 4, deleteFiles: true }]) assert.throws(() => captureRemovalBody(input));
});
test("removal reader enforces origin, content type and one-KiB request limit", async () => {
  const url = "https://admin.example.test/api/admin/capture-inventory/" + id;
  const request = (body, headers = {}) => new Request(url, { method: "DELETE", headers: { Origin: "https://admin.example.test", "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.deepEqual(captureRemovalBody(await readPreviewMutationJson(request({ revision: 4 }), 1024)), { revision: 4 });
  for (const [headers, status] of [[{ Origin: "https://other.example.test" }, 403], [{ "Sec-Fetch-Site": "cross-site" }, 403], [{ "Content-Type": "text/plain" }, 415], [{ "Content-Length": "1025" }, 413]]) await assert.rejects(readPreviewMutationJson(request({ revision: 4 }, headers), 1024), error => error.status === status);
  await assert.rejects(readPreviewMutationJson(request({ revision: 4, text: "x".repeat(1024) }), 1024), error => error.status === 413);
});
test("page and BFF maintain role and server-only credential boundaries", () => {
  const page = readFileSync(new URL("../app/report-activity/page.tsx", import.meta.url), "utf8");
  assert.match(page, /\["admin", "superadmin"\]\.includes\(payload.user\?\.role\)/);
  for (const path of ["route.ts", "users/route.ts", "[id]/route.ts"]) {
    const source = readFileSync(new URL("../app/api/admin/capture-inventory/" + path, import.meta.url), "utf8");
    assert.match(source, /proxyJsonWithAdminAuth/); assert.match(source, /no-store/);
  }
  const ui = readFileSync(new URL("../app/components/offline-captures/OfflineCapturesPage.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(ui, /Bearer |cv_admin|NEXT_PUBLIC_SERVER_URL|dangerouslySetInnerHTML/);
  assert.match(ui, /localStatus !== "discarded"/); assert.match(ui, /JSON.stringify\(\{ revision: data.revision \}\)/);
});
