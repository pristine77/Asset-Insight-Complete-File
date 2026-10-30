import { EventEmitter } from "node:events";
import http from "node:http";
import express from "express";
import mongoose from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";

// Import only the listener lifecycle; this test never starts the application,
// schedulers, storage adapters or a database connection.
vi.mock("../src/app.js", () => ({ default: {} }));
vi.mock("../src/config/database.js", () => ({ default: vi.fn() }));
vi.mock("../src/jobs/crmTaskReminderJob.js", () => ({ startCrmTaskReminderJob: vi.fn() }));
vi.mock("../src/jobs/crmFollowUpJob.js", () => ({ startCrmFollowUpJob: vi.fn() }));
vi.mock("../src/service/supportAttachmentMaintenanceService.js", () => ({ startSupportAttachmentMaintenance: vi.fn() }));
vi.mock("../src/utils/reportJobTempMaintenance.js", () => ({ startReportJobTempMaintenance: vi.fn() }));
vi.mock("../src/service/announcementService.js", () => ({ startAnnouncementDeliveryWorker: vi.fn() }));
vi.mock("../src/jobs/previewReviewReminderJob.js", () => ({ startPreviewReviewReminderJob: vi.fn() }));
vi.mock("../src/service/reportRestartRecoveryService.js", () => ({ startReportRestartRecovery: vi.fn() }));
vi.mock("../src/utils/r2Storage/r2Upload.js", () => ({ assertValidR2StorageConfiguration: vi.fn() }));
vi.mock("../src/service/reportActivityService.js", () => ({ recoverReportActivity: vi.fn() }));
vi.mock("../src/service/reportTransferNotificationService.js", () => ({ recoverReportTransferNotifications: vi.fn() }));
vi.mock("../src/service/deviceAccessService.js", () => ({ getRequestIp: () => "127.0.0.1", normalizeIp: (ip: string) => ip }));

import { registerGracefulShutdown } from "../src/bootstrap/apiServer.js";
import { openProposalValuationEventStream, resetProposalValuationEventHubForTests } from "../src/service/proposalValuationRealtimeService.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  resetProposalValuationEventHubForTests();
  vi.restoreAllMocks();
});

describe("API graceful shutdown", () => {
  it.each([
    { name: "Connection: close with SSE", withStream: true, keepAlive: false },
    { name: "keep-alive with SSE", withStream: true, keepAlive: true },
    { name: "keep-alive without SSE", withStream: false, keepAlive: true },
  ])("drains $name, waits for the PATCH, then disconnects MongoDB and exits zero", async ({ withStream, keepAlive }) => {
    const app = express();
    const patchEntered = deferred();
    const finishPatch = deferred();
    const exited = deferred<number>();
    const events: string[] = [];
    let committed = false;
    app.get("/events", (req, res) => {
      openProposalValuationEventStream({ req: req as any, res, reportId: "synthetic-report", userId: "synthetic-user", currentRevision: 2 });
    });
    app.patch("/value", async (_req, res) => {
      patchEntered.resolve();
      await finishPatch.promise;
      committed = true;
      events.push("mutation-complete");
      res.json({ saved: true });
    });
    const server = http.createServer(app);
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected loopback listener");
    const port = address.port;
    const runtime = new EventEmitter() as EventEmitter & { exit: (code: number) => void };
    runtime.exit = vi.fn((code: number) => { events.push(`exit-${code}`); exited.resolve(code); });
    const disconnect = vi.spyOn(mongoose, "disconnect").mockImplementation(async () => { events.push("database-disconnect"); });
    const forceClose = vi.spyOn(server, "closeAllConnections");
    registerGracefulShutdown(server, runtime);
    const streamReady = deferred();
    const streamEnded = deferred();
    let streamResponse: http.IncomingMessage | undefined;
    const agent = keepAlive ? new http.Agent({ keepAlive: true, maxSockets: 2 }) : false;
    const streamRequest = withStream ? http.get({ host: "127.0.0.1", port, path: "/events", agent }, (response) => {
      streamResponse = response;
      response.once("data", () => streamReady.resolve());
      response.on("data", () => {});
      response.once("end", () => streamEnded.resolve());
    }) : undefined;
    const patchResponse = deferred<{ status: number; body: string }>();
    const patchRequest = http.request({ host: "127.0.0.1", port, path: "/value", method: "PATCH", agent }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => patchResponse.resolve({ status: response.statusCode || 0, body }));
    });
    patchRequest.end();
    try {
      if (withStream) await streamReady.promise;
      await patchEntered.promise;

      runtime.emit("SIGTERM");
      runtime.emit("SIGINT");
      if (withStream) await streamEnded.promise;

      expect(server.listening).toBe(false);
      expect(committed).toBe(false);
      expect(disconnect).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();

      finishPatch.resolve();
      const response = await patchResponse.promise;
      expect(response).toEqual({ status: 200, body: '{"saved":true}' });
      expect(await exited.promise).toBe(0);
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(runtime.exit).toHaveBeenCalledTimes(1);
      expect(forceClose).not.toHaveBeenCalled();
      expect(events).toEqual(["mutation-complete", "database-disconnect", "exit-0"]);
    } finally {
      finishPatch.resolve();
      streamResponse?.destroy();
      streamRequest?.destroy();
      patchRequest.destroy();
      if (agent) agent.destroy();
      resetProposalValuationEventHubForTests();
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 5_000);
});
