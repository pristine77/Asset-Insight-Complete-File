import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Auctioneer2ClientError,
  auctioneer2Request,
  closeContractPartForUser,
  getContractCapturePermission,
  reopenContractForUser,
  completeConditionReport,
  getLot,
  patchLot,
  listContracts,
  listIncomingContracts,
  listIncomingTasks,
  submitLot,
  uploadLotPhotos,
  setLotVideo,
  verifyAuctioneer2Connection,
} from "../src/service/auctioneer2Client.js";

describe("Auctioneer 2.0 client", () => {
  const originalBaseUrl = process.env.AUCTIONEER2_API_BASE_URL;
  const originalGuideBaseUrl = process.env.AUCTIONEER2_BASE_URL;
  const originalApiKey = process.env.AUCTIONEER2_API_KEY;
  const originalEnabled = process.env.AUCTIONEER2_ENABLED;
  const originalFeatureEnabled = process.env.AUCTIONEER2_FEATURE_ENABLED;
  const originalTimeout = process.env.AUCTIONEER2_API_TIMEOUT_MS;
  const originalGuideTimeout = process.env.AUCTIONEER2_TIMEOUT_MS;

  beforeEach(() => {
    process.env.AUCTIONEER2_API_BASE_URL = "https://auctioneer.example/api/external/";
    process.env.AUCTIONEER2_API_KEY = "test-secret";
    process.env.AUCTIONEER2_ENABLED = "true";
    process.env.AUCTIONEER2_FEATURE_ENABLED = "true";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (originalBaseUrl === undefined) delete process.env.AUCTIONEER2_API_BASE_URL;
    else process.env.AUCTIONEER2_API_BASE_URL = originalBaseUrl;
    if (originalGuideBaseUrl === undefined) delete process.env.AUCTIONEER2_BASE_URL;
    else process.env.AUCTIONEER2_BASE_URL = originalGuideBaseUrl;
    if (originalApiKey === undefined) delete process.env.AUCTIONEER2_API_KEY;
    else process.env.AUCTIONEER2_API_KEY = originalApiKey;
    if (originalEnabled === undefined) delete process.env.AUCTIONEER2_ENABLED;
    else process.env.AUCTIONEER2_ENABLED = originalEnabled;
    if (originalFeatureEnabled === undefined) {
      delete process.env.AUCTIONEER2_FEATURE_ENABLED;
    } else {
      process.env.AUCTIONEER2_FEATURE_ENABLED = originalFeatureEnabled;
    }
    if (originalTimeout === undefined) delete process.env.AUCTIONEER2_API_TIMEOUT_MS;
    else process.env.AUCTIONEER2_API_TIMEOUT_MS = originalTimeout;
    if (originalGuideTimeout === undefined) delete process.env.AUCTIONEER2_TIMEOUT_MS;
    else process.env.AUCTIONEER2_TIMEOUT_MS = originalGuideTimeout;
  });

  it("uses the configured base URL and X-API-Key header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await auctioneer2Request("/health");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://auctioneer.example/api/external/health");
    expect((init.headers as Headers).get("X-API-Key")).toBe("test-secret");
  });

  it("requests completed contracts explicitly without changing legacy active-only reads", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ success: true, items: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await listIncomingContracts("owner", true);
    expect(String(fetchMock.mock.calls[0][0])).toContain("userId=owner&includeCompleted=true");
  });

  it("reads actor-scoped permission without exposing extra provider fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, contractId: "contract/1", userId: "owner",
      accessRevision: 0, reopen: { allowed: true, reason: null, reopenUntil: "2026-10-27T15:00:00.000Z" }, privateToken: "private" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await getContractCapturePermission("contract/1", "owner")).toEqual({ accessRevision: 0,
      reopen: { allowed: true, reason: null, reopenUntil: "2026-10-27T15:00:00.000Z" } });
    expect(fetchMock.mock.calls[0][0]).toBe("https://auctioneer.example/api/external/contracts/contract%2F1/capture-permission?userId=owner");
  });

  it("keeps Re-Open hidden on a permission response from an older provider", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ captureAllowed: true }), { status: 200 })));
    expect(await getContractCapturePermission("contract", "owner")).toEqual({ reopen: { allowed: false, reason: null, reopenUntil: null } });
  });

  it.each([
    { reopen: { allowed: "true" } }, { reopen: { allowed: true, reopenUntil: "not-a-date" } },
    { contractId: "another", reopen: { allowed: true } }, { userId: "another", reopen: { allowed: true } },
  ])("rejects unverified permission %j", async body => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })));
    await expect(getContractCapturePermission("contract", "owner")).rejects.toMatchObject({ code: "auctioneer2_invalid_response" });
  });

  it.each([{ reopened: true, accessRevision: 0 }, { alreadyOpen: true, accessRevision: "revision-2" }])("validates Re-Open receipt and preserves its revision: %j", async body => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await reopenContractForUser("contract/1", { userId: "owner", reopenedBy: "Appraiser" })).toEqual({ contractId: "contract/1",
      reopened: body.reopened === true, alreadyOpen: body.alreadyOpen === true, accessRevision: body.accessRevision });
    expect(fetchMock.mock.calls[0][0]).toBe("https://auctioneer.example/api/external/contracts/contract%2F1/reopen");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ userId: "owner", reopenedBy: "Appraiser" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([{ reopened: true }, { reopened: true, alreadyOpen: true, accessRevision: 3 },
    { success: false, reopened: true, accessRevision: 3 }, { reopened: true, accessRevision: -1 },
    { reopened: true, accessRevision: " " }, { contractId: "foreign", reopened: true, accessRevision: 3 },
    { userId: "foreign", alreadyOpen: true, accessRevision: 3 }])("refuses ambiguous Re-Open receipt %j", async body => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })));
    await expect(reopenContractForUser("contract", { userId: "owner", reopenedBy: "Appraiser" })).rejects.toBeInstanceOf(Auctioneer2ClientError);
  });

  it.each(["LOTS_CLOSING_STARTED", "EVENT_CLOSED", "PROPOSAL_REVIEWED", "REVOKED", "NO_GRANT", "AMBIGUOUS_REOPEN_USER"])("explains %s without provider diagnostics", async code => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code, message: "test-secret http://127.0.0.1/internal stack trace" }), { status: 409 })));
    const error = await reopenContractForUser("contract", { userId: "owner", reopenedBy: "Appraiser" }).catch(e => e);
    expect(error).toMatchObject({ statusCode: 409, code });
    expect(error.message).not.toMatch(/test-secret|127\.0|status 409|stack trace/);
  });

  it("retains an uncertain POST outcome without automatically replaying it", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("connection lost")); vi.stubGlobal("fetch", fetchMock);
    await expect(reopenContractForUser("contract", { userId: "owner", reopenedBy: "Appraiser" })).rejects.toMatchObject({ ambiguousWrite: true, code: "auctioneer2_unreachable" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("sends a video-only request and validates the exact returned video identity", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ success: true, video: { url: "https://www.youtube.com/embed/AbCdEfGhI_1", sortOrder: 1 } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ success: true, video: { url: "https://youtu.be/OtherClip_1" } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await setLotVideo("row/guid", "https://youtu.be/AbCdEfGhI_1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://auctioneer.example/api/external/lots/row%2Fguid/photos");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("X-API-Key")).toBe("test-secret");
    expect(JSON.parse(init.body)).toEqual({ video_url: "https://www.youtube.com/watch?v=AbCdEfGhI_1" });
    await expect(setLotVideo("row/guid", "https://youtu.be/AbCdEfGhI_1")).rejects.toMatchObject({ code: "auctioneer2_invalid_video_response" });
    await expect(setLotVideo("row/guid", "https://assetinsight.test/clip.mp4")).rejects.toMatchObject({ code: "auctioneer2_invalid_video" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([patchLot, completeConditionReport])("sends lotNumber with the configured authentication and maps event conflicts", async (send) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ success: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "LOT_NUMBER_CONFLICT", message: "private upstream test-secret" }), { status: 409 }));
    vi.stubGlobal("fetch", fetchMock);
    await send("row/guid", { lotNumber: "12" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://auctioneer.example/api/external/lots/row%2Fguid${send === patchLot ? "" : "/complete-cr"}`);
    expect(init.method).toBe(send === patchLot ? "PATCH" : "POST");
    expect(new Headers(init.headers).get("X-API-Key")).toBe("test-secret");
    expect(JSON.parse(init.body)).toEqual({ lotNumber: "12" });
    const error = await send("row/guid", { lotNumber: "12" }).catch(error => error);
    expect(error).toMatchObject({ statusCode: 409, upstreamStatus: 409, code: "LOT_NUMBER_CONFLICT", ambiguousWrite: false });
    expect(error.message).toContain("same auction event");
    expect(error.message).not.toContain("test-secret");
  });

  it.each(["not json", JSON.stringify({ code: "OTHER_CONFLICT" })])("keeps unrecognized HTTP 409 responses generic: %s", async body => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 409 })));
    await expect(completeConditionReport("row-guid", { lotNumber: "12" })).rejects.toMatchObject({
      code: "auctioneer2_upstream_error", statusCode: 502, ambiguousWrite: false,
    });
  });

  it.each([
    { message: "Lot number 1 is already assigned within this event." },
    { error: "Lot number 1 is already assigned within this event." },
    { error: { code: "LOT_NUMBER_CONFLICT", message: "Lot number 1 is already assigned within this event." } },
    { data: { error: { code: "LOT_NUMBER_CONFLICT", message: "Lot number 1 is already assigned within this event." } } },
    "Lot number 1 is already assigned within this event.",
  ])("preserves the actionable event conflict in supported envelopes: %j", async body => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 409 })));
    const error = await completeConditionReport("row-guid", { lotNumber: "1" }).catch(value => value);
    expect(error).toMatchObject({ statusCode: 409, code: "LOT_NUMBER_CONFLICT", upstreamStatus: 409, ambiguousWrite: false });
    expect(error.message).toContain("LOT_NUMBER_CONFLICT");
    expect(error.message).toContain("Lot number 1 is already assigned within this event.");
  });

  it("recognizes a plain-text conflict without reflecting arbitrary response text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Lot number 1000A is already assigned within this event.", { status: 409 })));
    const error = await submitLot({ contractId: "c-1", lotNumber: "1000A" }).catch(value => value);
    expect(error).toMatchObject({ code: "LOT_NUMBER_CONFLICT", statusCode: 409, ambiguousWrite: false });
    expect(error.message).toContain("Lot number 1000A is already assigned within this event.");
  });

  it.each([
    { code: "LOT_NUMBER_CONFLICT" },
    { error: { code: "LOT_NUMBER_CONFLICT" } },
    { error: "LOT_NUMBER_CONFLICT" },
  ])("includes a safe conflict code in durable human-visible error text: %j", async body => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 409 })));
    const error = await completeConditionReport("row-guid", { lotNumber: "12" }).catch(value => value);
    expect(error.message).toContain("LOT_NUMBER_CONFLICT");
    expect(error.message).toContain("same auction event");
  });

  it.each([
    { status: 400, body: { error: 'Event "Private client auction" is closed.' }, code: "EVENT_CLOSED", expected: "The auction event is closed." },
    { status: 400, body: { error: { code: "EVENT_CLOSED", message: "private upstream test-secret" } }, code: "EVENT_CLOSED", expected: "The auction event is closed." },
    { status: 409, body: { code: "CONTRACT_ALREADY_COMPLETED", message: "private upstream test-secret" }, code: "CONTRACT_ALREADY_COMPLETED", expected: "The auction contract has already been completed." },
  ])("provides safe guidance for a documented lifecycle rejection: $code", async ({ status, body, code, expected }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status })));
    const error = await submitLot({ contractId: "c-1", contractLotRef: "ref-1" }).catch(value => value);
    expect(error).toMatchObject({ statusCode: status, upstreamStatus: status, code, ambiguousWrite: false });
    expect(error.message).toContain(code);
    expect(error.message).toContain(expected);
    expect(error.message).not.toMatch(/test-secret|Private client/);
  });

  it.each([
    { code: "LOT_NUMBER_CONFLICT", message: "private upstream test-secret" },
    { code: "LOT_NUMBER_CONFLICT", message: "Lot number test-secret is already assigned within this event." },
    { code: "LOT_NUMBER_CONFLICT", message: "Lot number 1 is already assigned within this event. X-API-Key: test-secret" },
    { code: "LOT_NUMBER_CONFLICT", message: '<html>Lot number 1 is already assigned within this event. test-secret</html>' },
    { code: "LOT_NUMBER_CONFLICT", message: "Lot number https://private.example/token is already assigned within this event." },
  ])("never reflects private diagnostics disguised as conflict details: %j", async body => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 409 })));
    const error = await completeConditionReport("row-guid", { lotNumber: "1" }).catch(value => value);
    expect(error).toMatchObject({ code: "LOT_NUMBER_CONFLICT", statusCode: 409 });
    expect(error.message).toContain("same auction event");
    expect(error.message).not.toMatch(/test-secret|<html>|https:|private\.example|X-API-Key/);
  });

  it.each([
    "<html>Lot number 1 is already assigned within this event. test-secret</html>",
    JSON.stringify({ error: "SQL validation failed for test-secret", details: { code: "LOT_NUMBER_CONFLICT" } }),
    JSON.stringify({ message: "Lot number 1 is already assigned within this event. test-secret" }),
    JSON.stringify({ code: "OTHER_CONFLICT", message: "test-secret" }),
  ])("keeps unrecognized diagnostic/HTML bodies private", async body => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 409 })));
    const error = await submitLot({ contractId: "c-1" }).catch(value => value);
    expect(error).toMatchObject({ statusCode: 502, code: "auctioneer2_upstream_error", upstreamStatus: 409, ambiguousWrite: false });
    expect(error.message).not.toMatch(/test-secret|SQL|<html>/);
  });

  it.each([401, 403, 429, 500])("does not let validation-like bodies override HTTP %s security/retry mapping", async status => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "LOT_NUMBER_CONFLICT", message: "Lot number 1 is already assigned within this event." }), { status })));
    const error = await submitLot({ contractId: "c-1" }).catch(value => value);
    expect(error.code).toBe(status === 429 ? "auctioneer2_rate_limited" : status === 401 || status === 403 ? "auctioneer2_auth_failed" : "auctioneer2_upstream_error");
    expect(error.ambiguousWrite).toBe(false);
    expect(error.message).not.toContain("LOT_NUMBER_CONFLICT");
  });

  it("redacts a numeric API key even when it matches the permitted lot-label shape", async () => {
    process.env.AUCTIONEER2_API_KEY = "1234567890";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: "LOT_NUMBER_CONFLICT",
      message: "Lot number 1234567890 is already assigned within this event.",
    }), { status: 409 })));
    const error = await completeConditionReport("row-guid", { lotNumber: "1" }).catch(value => value);
    expect(error).toMatchObject({ code: "LOT_NUMBER_CONFLICT", statusCode: 409 });
    expect(error.message).toContain("same auction event");
    expect(error.message).not.toContain("1234567890");
  });

  it.each([
    { code: "LOT_NUMBER_CONFLICT", diagnostics: "private ".repeat(2_000) },
    { data: { data: { data: { error: { code: "LOT_NUMBER_CONFLICT" } } } } },
  ])("fails closed on oversized or deeply nested diagnostics", async body => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 409 })));
    const error = await submitLot({ contractId: "c-1" }).catch(value => value);
    expect(error).toMatchObject({ code: "auctioneer2_upstream_error", statusCode: 502, upstreamStatus: 409, ambiguousWrite: false });
    expect(error.message).not.toMatch(/private|LOT_NUMBER_CONFLICT/);
  });

  it("rejects an insecure or incorrectly scoped base URL before sending the key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    process.env.AUCTIONEER2_API_BASE_URL =
      "http://auctioneer.example/api/external";
    await expect(auctioneer2Request("/health")).rejects.toMatchObject({
      code: "auctioneer2_invalid_configuration",
      statusCode: 503,
    });

    process.env.AUCTIONEER2_API_BASE_URL =
      "https://auctioneer.example/not-the-external-api";
    await expect(auctioneer2Request("/health")).rejects.toMatchObject({
      code: "auctioneer2_invalid_configuration",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the documented /auth/verify endpoint for connection checks", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyAuctioneer2Connection()).resolves.toMatchObject({
      configured: true,
      reachable: true,
      verificationEndpoint: "/auth/verify",
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://auctioneer.example/api/external/auth/verify",
    ]);
  });

  it("falls back to /health only when /auth/verify is unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("not found", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyAuctioneer2Connection()).resolves.toMatchObject({
      configured: true,
      reachable: true,
      verificationEndpoint: "/health",
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://auctioneer.example/api/external/auth/verify",
      "https://auctioneer.example/api/external/health",
    ]);
  });

  it("falls back when an unavailable /auth/verify route returns an HTML success page", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("<!doctype html><title>Auctioneer</title>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(verifyAuctioneer2Connection()).resolves.toMatchObject({
      configured: true,
      reachable: true,
      verificationEndpoint: "/health",
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://auctioneer.example/api/external/auth/verify",
      "https://auctioneer.example/api/external/health",
    ]);
  });

  it("accepts JSON responses prefixed with a UTF-8 BOM", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(`\uFEFF${JSON.stringify({ success: true, items: [{ id: "c-1" }] })}`, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    await expect(listContracts()).resolves.toEqual([{ id: "c-1" }]);
  });

  it("normalizes nested contract list envelopes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: { contracts: [{ id: "c-1" }] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    await expect(listContracts()).resolves.toEqual([{ id: "c-1" }]);
  });

  it("normalizes a direct data array envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, data: [{ id: "c-1" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    await expect(listContracts()).resolves.toEqual([{ id: "c-1" }]);
  });

  it("requires and safely encodes the assigned user and optional contract filters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true, items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listIncomingTasks(" user+one@example.test ", "contract / 100")
    ).resolves.toEqual([]);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://auctioneer.example/api/external/tasks/incoming?userId=user%2Bone%40example.test&contractId=contract+%2F+100"
    );
    expect(
      (fetchMock.mock.calls[0][1].headers as Headers).get("X-API-Key")
    ).toBe("test-secret");

    await expect(listIncomingTasks("")).rejects.toMatchObject({
      code: "auctioneer2_user_required",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("loads user-scoped proposal contracts from the canonical items envelope", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          items: [
            {
              id: "contract-1",
              contractNumber: "825291",
              status: "ProposalInAssetInsight",
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listIncomingContracts(" 69209256be08b81c6d33e76f ")
    ).resolves.toEqual([
      {
        id: "contract-1",
        contractNumber: "825291",
        status: "ProposalInAssetInsight",
      },
    ]);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://auctioneer.example/api/external/contracts?status=ProposalInAssetInsight&userId=69209256be08b81c6d33e76f"
    );
    expect(
      (fetchMock.mock.calls[0][1].headers as Headers).get("X-API-Key")
    ).toBe("test-secret");

    await expect(listIncomingContracts("")).rejects.toMatchObject({
      code: "auctioneer2_user_required",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a guide-shaped task envelope when success is false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: false, items: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    await expect(listIncomingTasks("user-1")).rejects.toMatchObject({
      code: "auctioneer2_invalid_response",
    });
  });

  it("marks an unknown-lot submit network failure as an ambiguous write", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection reset")));

    const error = await submitLot({ contractId: "c-1" }).catch((value) => value);
    expect(error).toBeInstanceOf(Auctioneer2ClientError);
    expect(error).toMatchObject({
      code: "auctioneer2_unreachable",
      ambiguousWrite: true,
    });
  });

  it("normalizes request timeouts without exposing credentials", async () => {
    vi.useFakeTimers();
    delete process.env.AUCTIONEER2_API_TIMEOUT_MS;
    process.env.AUCTIONEER2_TIMEOUT_MS = "1000";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        });
      })
    );

    const pending = auctioneer2Request("/contracts").catch((value) => value);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await pending;
    expect(error).toMatchObject({
      code: "auctioneer2_timeout",
      statusCode: 504,
    });
    expect(error.message).not.toContain("test-secret");
  });

  it("accepts the integration guide base URL variable as an alias", async () => {
    delete process.env.AUCTIONEER2_API_BASE_URL;
    process.env.AUCTIONEER2_BASE_URL =
      "https://guide-auctioneer.example/api/external";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await auctioneer2Request("/auth/verify");

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://guide-auctioneer.example/api/external/auth/verify"
    );
  });

  it.each([
    [401, "auctioneer2_auth_failed", 502],
    [429, "auctioneer2_rate_limited", 503],
    [500, "auctioneer2_upstream_error", 502],
  ])(
    "normalizes upstream HTTP %s without exposing the API key",
    async (status, code, publicStatus) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              message: "upstream diagnostic containing test-secret",
            }),
            { status }
          )
        )
      );

      const error = await auctioneer2Request("/contracts").catch(
        (value) => value
      );
      expect(error).toBeInstanceOf(Auctioneer2ClientError);
      expect(error).toMatchObject({
        code,
        statusCode: publicStatus,
        upstreamStatus: status,
        ambiguousWrite: false,
      });
      expect(JSON.stringify(error)).not.toContain("test-secret");
      expect(error.message).not.toContain("test-secret");
    }
  );

  it("rejects malformed successful list and health responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true, unexpected: "shape" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );

    await expect(listContracts()).rejects.toMatchObject({
      code: "auctioneer2_invalid_response",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    await expect(verifyAuctioneer2Connection()).rejects.toMatchObject({
      code: "auctioneer2_invalid_response",
    });
  });

  it("enforces the documented Base64 photo count and decoded-size limits", async () => {
    await expect(uploadLotPhotos("lot-1", [])).rejects.toMatchObject({
      code: "auctioneer2_invalid_photo_batch",
    });
    await expect(
      uploadLotPhotos(
        "lot-1",
        Array.from({ length: 6 }, (_, index) => ({
          buffer: Buffer.from(`image-${index}`),
          filename: `image-${index}.jpg`,
          contentType: "image/jpeg",
        }))
      )
    ).rejects.toMatchObject({ code: "auctioneer2_invalid_photo_batch" });
    await expect(
      uploadLotPhotos("lot-1", [
        {
          buffer: Buffer.alloc(20 * 1024 * 1024 + 1),
          filename: "too-large.jpg",
          contentType: "image/jpeg",
        },
      ])
    ).rejects.toMatchObject({ code: "auctioneer2_photo_too_large" });
    await expect(
      uploadLotPhotos("lot-1", [
        {
          buffer: Buffer.alloc(18 * 1024 * 1024),
          filename: "first.jpg",
          contentType: "image/jpeg",
        },
        {
          buffer: Buffer.alloc(18 * 1024 * 1024),
          filename: "second.jpg",
          contentType: "image/jpeg",
        },
      ])
    ).rejects.toMatchObject({ code: "auctioneer2_photo_batch_too_large" });
  });

  it("uploads handoff-compatible Base64 JSON photos and accepts HTTP 201", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          delivery: "base64",
          photos: [
            {
              photoUrl: "/storage/lots/lot-1/front.jpg",
              thumbnailUrl: "/storage/lots/lot-1/thumb-front.jpg",
              sortOrder: 7,
            },
          ],
        }),
        {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      uploadLotPhotos("lot-1", [
        {
          buffer: Buffer.from("image-bytes"),
          filename: "front.jpg",
          contentType: "image/jpeg",
          order: 7,
        },
      ])
    ).resolves.toMatchObject({ success: true, delivery: "base64" });

    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Headers;
    const body = JSON.parse(String(init.body));
    expect(headers.get("X-API-Key")).toBe("test-secret");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(body.photos).toEqual([
      {
        data: `data:image/jpeg;base64,${Buffer.from("image-bytes").toString("base64")}`,
        content_type: "image/jpeg",
        filename: "front.jpg",
        sha256: createHash("sha256")
          .update(Buffer.from("image-bytes"))
          .digest("hex"),
        order: 7,
      },
    ]);
  });

  it("rejects photo uploads that do not return the documented 201 contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            success: true,
            delivery: "base64",
            photos: [{ photoUrl: "/storage/photo.jpg", sortOrder: 0 }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    await expect(
      uploadLotPhotos("lot-1", [
        {
          buffer: Buffer.from("image-bytes"),
          filename: "front.jpg",
          contentType: "image/jpeg",
        },
      ])
    ).rejects.toMatchObject({
      code: "auctioneer2_invalid_response",
      upstreamStatus: 200,
    });
  });

  it("validates photo result count, URL or duplicate marker, and sort order", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ success: true, delivery: "base64", photos: [] }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            delivery: "base64",
            photos: [{ skipped: true, duplicate: true, sortOrder: 3 }],
          }),
          { status: 201, headers: { "Content-Type": "application/json" } }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const photo = {
      buffer: Buffer.from("same-image"),
      filename: "same.jpg",
      contentType: "image/jpeg",
      order: 3,
    };
    await expect(uploadLotPhotos("lot-1", [photo])).rejects.toMatchObject({
      code: "auctioneer2_invalid_response",
    });
    await expect(uploadLotPhotos("lot-1", [photo])).resolves.toMatchObject({
      success: true,
      delivery: "base64",
    });
  });

  describe("closing one user's part of a contract", () => {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    it("names the user exactly as Auctioneer's task-completed endpoint expects", async () => {
      const fetchMock = vi.fn().mockResolvedValue(json({
        success: true, contractId: "contract/1", userId: "6620a0f0c0ffee0000000001",
        userStatus: "completed", taskCompleted: false, alreadyCompleted: false, status: "Active",
        message: "Your work is finished; other assigned users are still working",
      }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(closeContractPartForUser(" contract/1 ", {
        completedBy: "Alex Morgan", completedByUserId: "6620a0f0c0ffee0000000001",
      })).resolves.toEqual({
        contractId: "contract/1", userId: "6620a0f0c0ffee0000000001",
        userStatus: "completed", taskCompleted: false, alreadyCompleted: false,
      });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("https://auctioneer.example/api/external/contracts/contract%2F1/task-completed");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ completedBy: "Alex Morgan", completedByUserId: "6620a0f0c0ffee0000000001" });
    });

    it("reports a contract that every assigned user has now closed, and one already closed", async () => {
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(json({ success: true, contractId: "c-1", userId: "u-1", userStatus: "completed", taskCompleted: true, alreadyCompleted: false }))
        .mockResolvedValueOnce(json({ success: true, contractId: "c-1", alreadyCompleted: true, completedBy: "someone else", message: "Task was already completed" })));
      await expect(closeContractPartForUser("c-1", { completedBy: "A", completedByUserId: "u-1" }))
        .resolves.toMatchObject({ taskCompleted: true, alreadyCompleted: false, userStatus: "completed" });
      await expect(closeContractPartForUser("c-1", { completedBy: "A", completedByUserId: "u-1" }))
        .resolves.toEqual({ contractId: "c-1", userId: null, userStatus: null, taskCompleted: true, alreadyCompleted: true });
    });

    it.each([
      [{ success: false }],
      [{ success: true, userId: "u-1", userStatus: "completed" }],
      [{ success: true, userId: "u-1", taskCompleted: "yes" }],
      [{ success: true, contractId: "c-1", taskCompleted: false }],
      [{ success: true, contractId: "c-1", userId: "u-1", userStatus: "active", taskCompleted: false }],
      [{ success: true, contractId: "c-1", userId: "u-1", userStatus: "future_status", taskCompleted: false }],
      [{ success: true, contractId: "c-1", userStatus: "completed", taskCompleted: false }],
      [{ success: true, contractId: "c-2", userId: "u-1", userStatus: "completed", taskCompleted: false }],
      [{ success: true, userId: "u-1", userStatus: "completed", taskCompleted: true }],
      [{ success: true, contractId: "c-1", alreadyCompleted: true, taskCompleted: false }],
      [{ success: true, contractId: "c-2", alreadyCompleted: true }],
    ])("refuses an unconfirmed close: %j", async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(body)));
      await expect(closeContractPartForUser("c-1", { completedBy: "A", completedByUserId: "u-1" }))
        .rejects.toMatchObject({ code: "auctioneer2_invalid_response", statusCode: 502 });
    });

    it("refuses a close Auctioneer recorded for a different user", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ success: true, contractId: "c-1", userId: "u-2", userStatus: "completed", taskCompleted: false })));
      await expect(closeContractPartForUser("c-1", { completedBy: "A", completedByUserId: "u-1" }))
        .rejects.toMatchObject({ code: "auctioneer2_contract_close_user_mismatch" });
    });

    it("accepts a confirmed revoked assignment without claiming the whole contract completed", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ success: true, contractId: "c-1", userId: "u-1", userStatus: "revoked", taskCompleted: false })));
      await expect(closeContractPartForUser("c-1", { completedBy: "A", completedByUserId: "u-1" }))
        .resolves.toMatchObject({ userId: "u-1", userStatus: "revoked", taskCompleted: false });
    });

    it("does not let alreadyCompleted bypass a conflicting user identity", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ success: true, contractId: "c-1", userId: "u-2", alreadyCompleted: true })));
      await expect(closeContractPartForUser("c-1", { completedBy: "A", completedByUserId: "u-1" }))
        .rejects.toMatchObject({ code: "auctioneer2_contract_close_user_mismatch" });
    });

    it("turns Auctioneer's ambiguous-user refusal into a safe, coded message", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
        error: "This contract has more than one Asset Insight user still working. Send completedByUserId to finish your own work.",
        code: "AMBIGUOUS_COMPLETION_USER",
        activeUserIds: ["private-user-a", "private-user-b"],
      }, 409)));
      const error = await closeContractPartForUser("c-1", { completedBy: "A", completedByUserId: "u-1" }).catch(value => value);
      expect(error).toMatchObject({ code: "AMBIGUOUS_COMPLETION_USER", statusCode: 409, upstreamStatus: 409 });
      expect(error.message).toContain("AMBIGUOUS_COMPLETION_USER");
      expect(error.message).not.toMatch(/private-user|completedByUserId/);
    });

    it("never asks Auctioneer without a user to name", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(closeContractPartForUser("c-1", { completedBy: "A", completedByUserId: "  " }))
        .rejects.toMatchObject({ code: "auctioneer2_user_required" });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("reading a lot that may be awaiting re-inspection", () => {
    it.each([
      ["beside the lot block", { success: true, awaitingAssetInsightReinspection: true, lot: { id: "lot-1", status: "OpToDo" } }, true],
      ["inside the lot block", { success: true, lot: { id: "lot-1", status: "OpToDo", awaitingAssetInsightReinspection: true } }, true],
      ["inside, over a stale value beside it", { success: true, awaitingAssetInsightReinspection: true, lot: { id: "lot-1", awaitingAssetInsightReinspection: false } }, false],
    ])("keeps awaitingAssetInsightReinspection %s", async (_case, body, expected) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })));
      expect((await getLot("lot-1")).awaitingAssetInsightReinspection).toBe(expected);
    });

    it("leaves the flag absent for an Auctioneer that does not send it", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true, lot: { id: "lot-1" } }), { status: 200 })));
      expect(await getLot("lot-1")).not.toHaveProperty("awaitingAssetInsightReinspection");
    });
  });
});
