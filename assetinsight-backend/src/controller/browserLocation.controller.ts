import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth.middleware.js";
import {
  BrowserLocationCapacityError,
  BrowserLocationProviderError,
  BrowserLocationRequestAbortedError,
  consumeBrowserLocationRequestQuota,
  resolveBrowserLocation,
} from "../service/browserLocationService.js";

function parseCoordinate(
  value: unknown,
  minimum: number,
  maximum: number
): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

export async function reverseGeocodeBrowserLocation(
  req: AuthRequest,
  res: Response
) {
  const latitude = parseCoordinate(req.body?.latitude, -90, 90);
  const longitude = parseCoordinate(req.body?.longitude, -180, 180);
  if (latitude === null || longitude === null) {
    return res.status(400).json({
      message: "Valid latitude and longitude are required.",
    });
  }

  const identity = req.userId
    ? `user:${req.userId}`
    : `ip:${req.ip || req.socket.remoteAddress || "unknown"}`;
  const quota = consumeBrowserLocationRequestQuota(identity);
  res.setHeader("X-RateLimit-Limit", String(quota.limit));
  res.setHeader("X-RateLimit-Remaining", String(quota.remaining));
  if (!quota.allowed) {
    res.setHeader("Retry-After", String(quota.retryAfterSeconds));
    return res.status(429).json({
      code: "BROWSER_LOCATION_RATE_LIMITED",
      message: "Too many location requests. Wait before trying again.",
      retryAfterSeconds: quota.retryAfterSeconds,
    });
  }

  const clientAbort = new AbortController();
  const abortClientLookup = () => clientAbort.abort();
  req.once("aborted", abortClientLookup);
  const abortClosedResponse = () => {
    if (!res.writableEnded) abortClientLookup();
  };
  res.once("close", abortClosedResponse);
  if (req.aborted || res.destroyed) abortClientLookup();

  try {
    const location = await resolveBrowserLocation({
      latitude,
      longitude,
      acceptLanguage: req.get("accept-language") || undefined,
      signal: clientAbort.signal,
    });
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      message: "Browser location resolved",
      data: location,
    });
  } catch (error) {
    if (error instanceof BrowserLocationRequestAbortedError) return;
    if (error instanceof BrowserLocationCapacityError) {
      res.setHeader("Retry-After", String(error.retryAfterSeconds));
      return res.status(429).json({
        code: "BROWSER_LOCATION_BUSY",
        message: "Location lookup is busy. Wait a few seconds and try again.",
        retryAfterSeconds: error.retryAfterSeconds,
      });
    }
    if (error instanceof BrowserLocationProviderError) {
      return res.status(503).json({
        message: "A place name could not be resolved right now. Enter it manually or try again.",
      });
    }
    console.error("Browser location resolution failed", error);
    return res.status(500).json({ message: "Failed to resolve browser location." });
  } finally {
    req.removeListener("aborted", abortClientLookup);
    res.removeListener("close", abortClosedResponse);
  }
}
