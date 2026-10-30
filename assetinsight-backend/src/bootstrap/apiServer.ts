import fs from "fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "http";
import path from "path";
import mongoose from "mongoose";
import app from "../app.js";
import { readApiServerConfig } from "../config/apiServer.config.js";
import connectDB from "../config/database.js";
import { startCrmTaskReminderJob } from "../jobs/crmTaskReminderJob.js";
import { startCrmFollowUpJob } from "../jobs/crmFollowUpJob.js";
import { startSupportAttachmentMaintenance } from "../service/supportAttachmentMaintenanceService.js";
import { startReportJobTempMaintenance } from "../utils/reportJobTempMaintenance.js";
import { startAnnouncementDeliveryWorker } from "../service/announcementService.js";
import { startPreviewReviewReminderJob } from "../jobs/previewReviewReminderJob.js";
import { startReportRestartRecovery } from "../service/reportRestartRecoveryService.js";
import { assertValidR2StorageConfiguration } from "../utils/r2Storage/r2Upload.js";
import { recoverReportActivity } from "../service/reportActivityService.js";
import { recoverReportTransferNotifications } from "../service/reportTransferNotificationService.js";
import { shutdownProposalValuationEventStreams } from "../service/proposalValuationRealtimeService.js";

const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 25_000;

async function ensureRuntimeDirectories(): Promise<void> {
  await Promise.all([
    fs.mkdir(path.resolve(process.cwd(), "uploads"), { recursive: true }),
    fs.mkdir(path.resolve(process.cwd(), "uploads/drafts"), {
      recursive: true,
    }),
    fs.mkdir(path.resolve(process.cwd(), "uploads/report-drafts"), {
      recursive: true,
    }),
  ]);
}

function isPrimaryProcessInstance(): boolean {
  return !process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === "0";
}

function startScheduledWork(): void {
  // PM2 currently runs one API process. The instance guard also prevents
  // duplicate schedules if that topology changes before the jobs are externalized.
  if (
    process.env.CRM_TASK_REMINDER_ENABLED !== "false" &&
    isPrimaryProcessInstance()
  ) {
    startCrmTaskReminderJob();
    startCrmFollowUpJob();
  }

  if (isPrimaryProcessInstance()) {
    startReportRestartRecovery();
    startReportJobTempMaintenance();
    startSupportAttachmentMaintenance();
    startAnnouncementDeliveryWorker();
    startPreviewReviewReminderJob();
  }
}

function configureConnectionTimeouts(
  server: Server,
  requestTimeoutMs: number
): void {
  // Large fallback uploads retain their existing bounded processing window;
  // idle keep-alive and incomplete-header connections close much sooner.
  server.requestTimeout = requestTimeoutMs;
  server.timeout = requestTimeoutMs;
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
}

export function registerGracefulShutdown(
  server: Server,
  runtime: {
    once: (signal: NodeJS.Signals, listener: () => void) => unknown;
    exit: (code: number) => unknown;
  } = process
): void {
  let shuttingDown = false;

  // close() reaps sockets that are already idle, but an active keep-alive
  // response can become idle afterward. Reap only finished responses while
  // draining; other in-flight requests keep their socket and database access.
  const observeResponseFinish = (_request: IncomingMessage, response: ServerResponse) => {
    response.once("finish", () => {
      if (shuttingDown) server.closeIdleConnections();
    });
  };
  server.prependListener("request", observeResponseFinish);
  server.once("close", () => server.removeListener("request", observeResponseFinish));

  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Server] ${signal} received; draining connections`);

    const forceExit = setTimeout(() => {
      console.error("[Server] Graceful shutdown timed out; closing connections");
      server.closeAllConnections();
      runtime.exit(1);
    }, GRACEFUL_SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    server.close((closeError) => {
      void mongoose
        .disconnect()
        .catch((disconnectError) => {
          console.error("[Server] MongoDB disconnect failed:", disconnectError);
        })
        .finally(() => {
          clearTimeout(forceExit);
          runtime.exit(closeError ? 1 : 0);
        });
    });
    // Stop accepting first, then end only registered SSE hints. Ordinary
    // requests retain their response and database connection until they finish.
    shutdownProposalValuationEventStreams();
    server.closeIdleConnections();
  };

  runtime.once("SIGINT", () => shutdown("SIGINT"));
  runtime.once("SIGTERM", () => shutdown("SIGTERM"));
}

/**
 * Starts the API process in dependency order: database, required directories,
 * listener, scheduled work, then shutdown hooks.
 */
export async function startApiServer(): Promise<Server> {
  const config = readApiServerConfig();
  // Refuse a partial storage cutover before accepting traffic. Current and
  // legacy namespaces must remain distinct for URL-based deletion safety.
  assertValidR2StorageConfiguration();

  await connectDB();
  await ensureRuntimeDirectories();

  // Nginx absorbs public traffic, but the larger accept queue prevents short
  // bursts from being rejected while the event loop completes other work.
  const server = app.listen(
    {
      port: Number(config.port),
      host: config.host,
      backlog: config.listenBacklog,
    },
    () => {
      console.log(`Server running at http://${config.host}:${config.port}`);
      if (typeof process.send === "function") {
        process.send("ready");
      }
    }
  );

  startScheduledWork();
  let activityRecoveryRunning = false;
  const recoverActivity = async () => {
    if (activityRecoveryRunning) return;
    activityRecoveryRunning = true;
    try { await recoverReportActivity(); } catch { console.warn("Report activity recovery will retry."); }
    finally { activityRecoveryRunning = false; }
  };
  // Notification transport has its own running guard and deadlines. A slow
  // email/push provider must never hold Report Activity recovery hostage.
  const recover = () => {
    void recoverActivity();
    void recoverReportTransferNotifications().catch(() => console.warn("Report transfer notifications will retry."));
  };
  const activityTimer = setInterval(recover, 30000);
  activityTimer.unref();
  server.once("close", () => clearInterval(activityTimer));
  recover();
  configureConnectionTimeouts(server, config.requestTimeoutMs);
  registerGracefulShutdown(server);

  return server;
}
