import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth.middleware.js";
import { getRequestIp, normalizeIp } from "./deviceAccessService.js";

const HEARTBEAT_MS = 25_000;
const MAX_CONNECTIONS_PER_REPORT = 100;
const MAX_CONNECTIONS_PER_USER_PER_REPORT = 8;
const MAX_CONNECTIONS_PER_USER_TOTAL = 20;
const MAX_CONNECTIONS_PER_IP = 64;
const MAX_CONNECTIONS_TOTAL = 1_000;
const MAX_STREAM_LIFETIME_MS = 4 * 60 * 1_000;

type ProposalValuationConnection = {
  userId: string;
  deviceId?: string;
  ip: string;
  response: Response;
  heartbeat: NodeJS.Timeout;
  expires: NodeJS.Timeout;
  closed: boolean;
};

export type ProposalValuationRevisionEvent = {
  reportId: string;
  revision: number;
  updatedAt: Date | string;
  updatedBy?: string | null;
  mutationId?: string | null;
};

export type ProposalValuationEventStreamHandle = {
  isClosed: () => boolean;
  resync: (revision: number, reason: string) => void;
  close: (reason: string, revision?: number) => void;
};

const rooms = new Map<string, Set<ProposalValuationConnection>>();
let connectionCount = 0;

function writeEvent(
  response: Response,
  event: "ready" | "pv-revision" | "resync",
  data: Record<string, unknown>,
  id?: number
) {
  if (id !== undefined) response.write(`id: ${id}\n`);
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function numericRevision(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const revision = Number(value);
  return Number.isInteger(revision) && revision >= 0 ? revision : null;
}

export function openProposalValuationEventStream(input: {
  req: AuthRequest;
  res: Response;
  reportId: string;
  userId: string;
  currentRevision: number;
}): ProposalValuationEventStreamHandle | null {
  const room = rooms.get(input.reportId) || new Set<ProposalValuationConnection>();
  const userConnections = Array.from(room).filter(
    (connection) => connection.userId === input.userId && !connection.closed
  ).length;
  let globalUserConnections = 0;
  const requestIp = getRequestIp(input.req);
  let ipConnections = 0;
  for (const candidateRoom of rooms.values()) {
    for (const connection of candidateRoom) {
      if (connection.userId === input.userId && !connection.closed) {
        globalUserConnections += 1;
      }
      if (connection.ip === requestIp && !connection.closed) {
        ipConnections += 1;
      }
    }
  }
  if (
    connectionCount >= MAX_CONNECTIONS_TOTAL ||
    room.size >= MAX_CONNECTIONS_PER_REPORT ||
    userConnections >= MAX_CONNECTIONS_PER_USER_PER_REPORT ||
    globalUserConnections >= MAX_CONNECTIONS_PER_USER_TOTAL ||
    ipConnections >= MAX_CONNECTIONS_PER_IP
  ) {
    input.res.status(429).json({
      code: "PV_EVENT_CONNECTION_LIMIT",
      message: "Too many live Proposal Valuation connections",
    });
    return null;
  }

  input.res.status(200);
  input.res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  input.res.setHeader("Cache-Control", "no-cache, no-store, no-transform");
  input.res.setHeader("Connection", "keep-alive");
  input.res.setHeader("X-Accel-Buffering", "no");
  input.res.flushHeaders?.();

  const heartbeat = setInterval(() => {
    if (!input.res.writableEnded) input.res.write(": heartbeat\n\n");
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
  const tokenLifetimeMs = Number.isFinite(input.req.authTokenExpiresAt)
    ? Math.max(0, Number(input.req.authTokenExpiresAt) - Date.now())
    : MAX_STREAM_LIFETIME_MS;
  const streamLifetimeMs = Math.min(MAX_STREAM_LIFETIME_MS, tokenLifetimeMs);
  const expires = setTimeout(() => {
    if (input.res.writableEnded) return;
    try {
      writeEvent(input.res, "resync", {
        reportId: input.reportId,
        revision: input.currentRevision,
        reason: "reauth-required",
      });
    } finally {
      input.res.end();
    }
  }, streamLifetimeMs);
  expires.unref?.();
  const connection: ProposalValuationConnection = {
    userId: input.userId,
    deviceId: input.req.deviceId,
    ip: requestIp,
    response: input.res,
    heartbeat,
    expires,
    closed: false,
  };
  room.add(connection);
  rooms.set(input.reportId, room);
  connectionCount += 1;

  const lastRevision = numericRevision(
    input.req.headers["last-event-id"] ?? input.req.query.since
  );
  writeEvent(
    input.res,
    "ready",
    {
      reportId: input.reportId,
      revision: input.currentRevision,
      connectedAt: new Date().toISOString(),
    },
    input.currentRevision
  );
  if (lastRevision !== null && lastRevision !== input.currentRevision) {
    writeEvent(
      input.res,
      "resync",
      {
        reportId: input.reportId,
        revision: input.currentRevision,
        reason: "revision-mismatch",
      },
      input.currentRevision
    );
  }

  const cleanup = () => {
    if (connection.closed) return;
    connection.closed = true;
    clearInterval(connection.heartbeat);
    clearTimeout(connection.expires);
    room.delete(connection);
    connectionCount = Math.max(0, connectionCount - 1);
    if (room.size === 0) rooms.delete(input.reportId);
  };
  input.req.once("close", cleanup);
  input.res.once("close", cleanup);
  input.res.once("finish", cleanup);
  input.res.once("error", cleanup);

  return {
    isClosed: () => connection.closed || input.res.writableEnded,
    resync: (revision, reason) => {
      if (connection.closed || input.res.writableEnded) return;
      writeEvent(
        input.res,
        "resync",
        { reportId: input.reportId, revision, reason },
        revision
      );
    },
    close: (reason, revision) => {
      if (connection.closed || input.res.writableEnded) {
        cleanup();
        return;
      }
      try {
        writeEvent(
          input.res,
          "resync",
          {
            reportId: input.reportId,
            ...(revision === undefined ? {} : { revision }),
            reason,
          },
          revision
        );
      } finally {
        input.res.end();
        cleanup();
      }
    },
  };
}

export function broadcastProposalValuationRevision(
  event: ProposalValuationRevisionEvent
) {
  const room = rooms.get(event.reportId);
  if (!room) return;
  const payload = {
    reportId: event.reportId,
    revision: event.revision,
    updatedAt:
      event.updatedAt instanceof Date
        ? event.updatedAt.toISOString()
        : event.updatedAt,
    ...(event.updatedBy ? { updatedBy: event.updatedBy } : {}),
    ...(event.mutationId ? { mutationId: event.mutationId } : {}),
  };
  for (const connection of room) {
    if (connection.closed || connection.response.writableEnded) continue;
    try {
      writeEvent(connection.response, "pv-revision", payload, event.revision);
    } catch {
      connection.response.end();
    }
  }
}

export function disconnectProposalValuationUsers(
  reportId: string,
  allowedUserIds: ReadonlySet<string>
) {
  const room = rooms.get(reportId);
  if (!room) return;
  for (const connection of Array.from(room)) {
    if (allowedUserIds.has(connection.userId)) continue;
    try {
      if (!connection.response.writableEnded) {
        writeEvent(
          connection.response,
          "resync",
          { reportId, reason: "access-changed" }
        );
        connection.response.end();
      }
    } catch {
      try {
        connection.response.end();
      } catch {
        // A dead stream is already effectively disconnected. Revision commits
        // must never fail because a best-effort transport write failed.
      }
    }
  }
}

/** Immediately revoke every live PV stream owned by one account. */
export function disconnectProposalValuationUser(
  userId: string,
  reason = "account-access-changed"
) {
  for (const [reportId, room] of rooms.entries()) {
    for (const connection of Array.from(room)) {
      if (connection.userId !== userId) continue;
      try {
        if (!connection.response.writableEnded) {
          writeEvent(connection.response, "resync", { reportId, reason });
          connection.response.end();
        }
      } catch {
        try {
          connection.response.end();
        } catch {
          // The connection is already unusable, which is the desired state.
        }
      }
    }
  }
}

/** Revoke live streams bound to one approved device registration. */
export function disconnectProposalValuationDevice(
  deviceId: string,
  reason = "device-access-changed"
) {
  for (const [reportId, room] of rooms.entries()) {
    for (const connection of Array.from(room)) {
      if (!deviceId || connection.deviceId !== deviceId) continue;
      try {
        if (!connection.response.writableEnded) {
          writeEvent(connection.response, "resync", { reportId, reason });
          connection.response.end();
        }
      } catch {
        try {
          connection.response.end();
        } catch {
          // Already disconnected.
        }
      }
    }
  }
}

/** Revoke one account's streams from a newly blocked normalized IP. */
export function disconnectProposalValuationUserIp(
  userId: string,
  ip: string,
  reason = "ip-access-changed"
) {
  const normalizedIp = normalizeIp(ip);
  for (const [reportId, room] of rooms.entries()) {
    for (const connection of Array.from(room)) {
      if (
        connection.userId !== userId ||
        connection.ip !== normalizedIp
      ) {
        continue;
      }
      try {
        if (!connection.response.writableEnded) {
          writeEvent(connection.response, "resync", { reportId, reason });
          connection.response.end();
        }
      } catch {
        try {
          connection.response.end();
        } catch {
          // Already disconnected.
        }
      }
    }
  }
}

export function resetProposalValuationEventHubForTests() {
  for (const room of rooms.values()) {
    for (const connection of room) {
      clearInterval(connection.heartbeat);
      clearTimeout(connection.expires);
      if (!connection.response.writableEnded) connection.response.end();
    }
  }
  rooms.clear();
  connectionCount = 0;
}
