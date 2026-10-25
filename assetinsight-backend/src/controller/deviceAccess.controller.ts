import { Request, Response } from "express";
import {
  DeviceApiError,
  deviceErrorBody,
  exchangeApprovedDevice,
  getDeviceRequestStatus,
  registerDeviceRequest,
  rerequestDeviceAccess,
} from "../service/deviceAccessService.js";

/**
 * Public HTTP boundary for the pre-authentication device approval handshake.
 *
 * These endpoints cannot rely on a user session yet. The service therefore owns
 * request validation, device identity checks, token exchange and replay protection;
 * this controller only maps its typed errors onto the stable device API contract.
 */

function sendDeviceError(res: Response, error: unknown) {
  // Only known DeviceApiError payloads are suitable for clients; all other errors
  // are logged server-side and reduced to a non-sensitive fallback response.
  if (error instanceof DeviceApiError) {
    return res.status(error.status).json(deviceErrorBody(error));
  }
  console.error("Device access request failed:", error);
  return res.status(500).json({
    code: "DEVICE_ACCESS_ERROR",
    message: "Unable to process this device access request.",
  });
}

export async function registerDevice(req: Request, res: Response) {
  try {
    return res.status(201).json(await registerDeviceRequest(req));
  } catch (error) {
    return sendDeviceError(res, error);
  }
}

export async function deviceRequestStatus(req: Request, res: Response) {
  try {
    // Approval can change between polls, so browsers and proxies must not reuse an
    // earlier pending/approved response.
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(await getDeviceRequestStatus(req));
  } catch (error) {
    return sendDeviceError(res, error);
  }
}

export async function exchangeDeviceApproval(req: Request, res: Response) {
  try {
    // The service performs the security-sensitive one-time exchange; keeping that
    // logic outside Express makes its atomicity and replay rules independently testable.
    return res.status(200).json(await exchangeApprovedDevice(req));
  } catch (error) {
    return sendDeviceError(res, error);
  }
}

export async function rerequestDevice(req: Request, res: Response) {
  try {
    return res.status(200).json(await rerequestDeviceAccess(req));
  } catch (error) {
    return sendDeviceError(res, error);
  }
}
