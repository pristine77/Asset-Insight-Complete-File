import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  broadcastProposalValuationRevision,
  disconnectProposalValuationDevice,
  disconnectProposalValuationUser,
  disconnectProposalValuationUserIp,
  openProposalValuationEventStream,
  resetProposalValuationEventHubForTests,
  shutdownProposalValuationEventStreams,
} from "../src/service/proposalValuationRealtimeService.js";
import { registerAndRevalidateProposalValuationEventStream } from "../src/controller/assetProposalValuation.controller.js";
import { ProposalValuationError } from "../src/service/proposalValuationService.js";

function mockStream() {
  const req = new EventEmitter() as any;
  req.headers = {};
  req.query = { since: "1" };
  req.params = { id: "report-1" };
  req.userId = "user-1";
  req.ip = "203.0.113.10";

  const res = new EventEmitter() as any;
  res.headers = new Map<string, string>();
  res.chunks = [] as string[];
  res.writableEnded = false;
  res.status = function status(code: number) {
    this.statusCode = code;
    return this;
  };
  res.setHeader = function setHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
  };
  res.flushHeaders = function flushHeaders() {};
  res.write = function write(chunk: string) {
    this.chunks.push(String(chunk));
    return true;
  };
  res.json = function json(body: unknown) {
    this.body = body;
    return this;
  };
  res.end = function end() {
    if (this.writableEnded) return;
    this.writableEnded = true;
    this.emit("close");
  };
  return { req, res };
}

afterEach(() => {
  resetProposalValuationEventHubForTests();
  vi.useRealTimers();
});

describe("Proposal Valuation live revision stream", () => {
  it("ends every registered stream and clears timers idempotently for shutdown", () => {
    vi.useFakeTimers();
    const first = mockStream();
    const second = mockStream();
    const firstHandle = openProposalValuationEventStream({ ...first, reportId: "shutdown-1", userId: "user-1", currentRevision: 1 });
    const secondHandle = openProposalValuationEventStream({ ...second, reportId: "shutdown-2", userId: "user-2", currentRevision: 2 });
    const firstEnd = vi.spyOn(first.res, "end");
    const secondEnd = vi.spyOn(second.res, "end");
    expect(vi.getTimerCount()).toBe(4);

    shutdownProposalValuationEventStreams();
    shutdownProposalValuationEventStreams();

    expect(firstEnd).toHaveBeenCalledTimes(1);
    expect(secondEnd).toHaveBeenCalledTimes(1);
    expect(firstHandle!.isClosed()).toBe(true);
    expect(secondHandle!.isClosed()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses a stream that finishes authorizing after shutdown began", () => {
    vi.useFakeTimers();
    shutdownProposalValuationEventStreams();
    const late = mockStream();

    const handle = openProposalValuationEventStream({ ...late, reportId: "shutdown-late", userId: "user-late", currentRevision: 3 });

    expect(handle).toBeNull();
    expect(late.res.statusCode).toBe(503);
    expect(late.res.headers.get("retry-after")).toBe("1");
    expect(late.res.body).toMatchObject({ code: "PV_EVENTS_RESTARTING" });
    expect(late.res.chunks).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans a broken stream without preventing other streams from ending", () => {
    vi.useFakeTimers();
    const broken = mockStream();
    const healthy = mockStream();
    const brokenHandle = openProposalValuationEventStream({ ...broken, reportId: "shutdown-broken", userId: "user-1", currentRevision: 1 });
    openProposalValuationEventStream({ ...healthy, reportId: "shutdown-healthy", userId: "user-2", currentRevision: 1 });
    broken.res.end = vi.fn(() => { throw new Error("Broken response"); });
    broken.res.destroy = vi.fn();

    expect(() => shutdownProposalValuationEventStreams()).not.toThrow();

    expect(broken.res.destroy).toHaveBeenCalledTimes(1);
    expect(brokenHandle!.isClosed()).toBe(true);
    expect(healthy.res.writableEnded).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes or resyncs mutations that land in the authorization/register gap", async () => {
    let resolveRevalidation!: (workspace: any) => void;
    const revalidation = new Promise<any>((resolve) => {
      resolveRevalidation = resolve;
    });
    const revised = mockStream();
    revised.req.params.id = "report-gap";
    revised.req.userId = "assigned-user";
    const opening = registerAndRevalidateProposalValuationEventStream({
      req: revised.req,
      res: revised.res,
      workspace: { reportId: "report-gap", revision: 2 },
      user: { _id: "assigned-user" },
      loadWorkspace: async () => revalidation,
    });

    broadcastProposalValuationRevision({
      reportId: "report-gap",
      revision: 3,
      updatedAt: "2026-08-30T12:00:00.000Z",
      updatedBy: "owner",
    });
    resolveRevalidation({ reportId: "report-gap", revision: 3 });
    await opening;
    const revisedOutput = revised.res.chunks.join("");
    expect(revisedOutput).toContain("event: pv-revision");
    expect(revisedOutput).toContain(
      '"reason":"post-registration-revalidation"'
    );
    revised.res.end();

    const removed = mockStream();
    removed.req.params.id = "report-removed";
    removed.req.userId = "removed-user";
    await registerAndRevalidateProposalValuationEventStream({
      req: removed.req,
      res: removed.res,
      workspace: { reportId: "report-removed", revision: 4 },
      user: { _id: "removed-user" },
      loadWorkspace: async () => {
        throw new ProposalValuationError(
          404,
          "PROPOSAL_VALUATION_NOT_FOUND",
          "Asset report not found"
        );
      },
    });
    expect(removed.res.writableEnded).toBe(true);
    expect(removed.res.chunks.join("")).toContain(
      '"reason":"access-changed"'
    );

    const transient = mockStream();
    transient.req.params.id = "report-transient";
    transient.req.userId = "transient-user";
    await registerAndRevalidateProposalValuationEventStream({
      req: transient.req,
      res: transient.res,
      workspace: { reportId: "report-transient", revision: 5 },
      user: { _id: "transient-user" },
      loadWorkspace: async () => {
        throw new Error("temporary database failure");
      },
    });
    expect(transient.res.writableEnded).toBe(true);
    expect(transient.res.chunks.join("")).toContain(
      '"reason":"post-registration-revalidation-failed"'
    );
    expect(transient.res.chunks.join("")).not.toContain(
      '"reason":"access-changed"'
    );
  });

  it("can resync or close a registered stream after access revalidation", () => {
    const { req, res } = mockStream();
    const stream = openProposalValuationEventStream({
      req,
      res,
      reportId: "report-revalidate",
      userId: "user-revalidate",
      currentRevision: 2,
    });

    expect(stream).not.toBeNull();
    stream!.resync(3, "post-registration-revalidation");
    expect(res.chunks.join("")).toContain('id: 3');
    expect(res.chunks.join("")).toContain(
      '"reason":"post-registration-revalidation"'
    );

    stream!.close("access-changed", 3);
    expect(stream!.isClosed()).toBe(true);
    expect(res.writableEnded).toBe(true);
    expect(res.chunks.join("")).toContain('"reason":"access-changed"');
  });

  it("sets non-buffered SSE headers, resyncs reconnects, and broadcasts hints only", () => {
    const { req, res } = mockStream();
    openProposalValuationEventStream({
      req,
      res,
      reportId: "report-1",
      userId: "user-1",
      currentRevision: 2,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(res.chunks.join("")).toContain("event: ready");
    expect(res.chunks.join("")).toContain("event: resync");
    expect(res.chunks.join("")).toContain('"reason":"revision-mismatch"');

    broadcastProposalValuationRevision({
      reportId: "report-1",
      revision: 3,
      updatedAt: "2026-08-30T12:00:00.000Z",
      updatedBy: "user-2",
      mutationId: "mutation-3",
    });
    const output = res.chunks.join("");
    expect(output).toContain("event: pv-revision");
    expect(output).toContain('"revision":3');
    expect(output).toContain('"mutationId":"mutation-3"');
    expect(output).not.toContain("assetScheduleSheet");
    expect(output).not.toContain("preview_data");

    res.end();
  });

  it("immediately revokes every stream for an account without closing other participants", () => {
    const first = mockStream();
    const second = mockStream();
    openProposalValuationEventStream({
      req: first.req,
      res: first.res,
      reportId: "report-1",
      userId: "revoked-user",
      currentRevision: 4,
    });
    openProposalValuationEventStream({
      req: second.req,
      res: second.res,
      reportId: "report-1",
      userId: "allowed-user",
      currentRevision: 4,
    });

    disconnectProposalValuationUser("revoked-user", "account-blocked");

    expect(first.res.writableEnded).toBe(true);
    expect(first.res.chunks.join("")).toContain("event: resync");
    expect(first.res.chunks.join("")).toContain('"reason":"account-blocked"');
    expect(second.res.writableEnded).toBe(false);
    second.res.end();
  });

  it("limits one account across reports and periodically closes streams for reauthorization", () => {
    const streams = Array.from({ length: 21 }, () => mockStream());
    streams.forEach((stream, index) => {
      openProposalValuationEventStream({
        req: stream.req,
        res: stream.res,
        reportId: `report-${index}`,
        userId: "one-user",
        currentRevision: 1,
      });
    });
    expect(streams.slice(0, 20).every(({ res }) => res.statusCode === 200)).toBe(
      true
    );
    expect(streams[20].res.statusCode).toBe(429);
    expect(streams[20].res.body).toMatchObject({
      code: "PV_EVENT_CONNECTION_LIMIT",
    });

    resetProposalValuationEventHubForTests();
    vi.useFakeTimers();
    const expiring = mockStream();
    openProposalValuationEventStream({
      req: expiring.req,
      res: expiring.res,
      reportId: "report-expiring",
      userId: "one-user",
      currentRevision: 4,
    });
    vi.advanceTimersByTime(4 * 60 * 1_000);
    expect(expiring.res.writableEnded).toBe(true);
    expect(expiring.res.chunks.join("")).toContain('"reason":"reauth-required"');
  });

  it("revokes streams immediately by device or user-scoped IP", () => {
    const deviceStream = mockStream();
    deviceStream.req.deviceId = "device-a";
    const ipStream = mockStream();
    ipStream.req.deviceId = "device-b";
    ipStream.req.ip = "198.51.100.25";
    openProposalValuationEventStream({
      req: deviceStream.req,
      res: deviceStream.res,
      reportId: "report-device",
      userId: "user-a",
      currentRevision: 2,
    });
    openProposalValuationEventStream({
      req: ipStream.req,
      res: ipStream.res,
      reportId: "report-ip",
      userId: "user-a",
      currentRevision: 2,
    });

    disconnectProposalValuationDevice("device-a", "device-revoked");
    expect(deviceStream.res.writableEnded).toBe(true);
    expect(deviceStream.res.chunks.join("")).toContain('"reason":"device-revoked"');
    expect(ipStream.res.writableEnded).toBe(false);

    disconnectProposalValuationUserIp(
      "user-a",
      "198.51.100.25",
      "ip-blocked"
    );
    expect(ipStream.res.writableEnded).toBe(true);
    expect(ipStream.res.chunks.join("")).toContain('"reason":"ip-blocked"');
  });

  it("bounds a stream by token expiry and caps one source IP", () => {
    vi.useFakeTimers();
    const tokenBound = mockStream();
    tokenBound.req.authTokenExpiresAt = Date.now() + 1_000;
    openProposalValuationEventStream({
      req: tokenBound.req,
      res: tokenBound.res,
      reportId: "report-token",
      userId: "token-user",
      currentRevision: 1,
    });
    vi.advanceTimersByTime(1_000);
    expect(tokenBound.res.writableEnded).toBe(true);
    expect(tokenBound.res.chunks.join("")).toContain('"reason":"reauth-required"');

    resetProposalValuationEventHubForTests();
    vi.useRealTimers();
    const streams = Array.from({ length: 65 }, (_, index) => {
      const stream = mockStream();
      stream.req.ip = "192.0.2.44";
      openProposalValuationEventStream({
        req: stream.req,
        res: stream.res,
        reportId: `ip-report-${index}`,
        userId: `ip-user-${index}`,
        currentRevision: 1,
      });
      return stream;
    });
    expect(streams.slice(0, 64).every(({ res }) => res.statusCode === 200)).toBe(
      true
    );
    expect(streams[64].res.statusCode).toBe(429);
  });
});
