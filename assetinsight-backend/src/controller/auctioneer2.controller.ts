import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware.js";
import {
  Auctioneer2ClientError,
  getAuctioneer2ConfigStatus,
  verifyAuctioneer2Connection,
} from "../service/auctioneer2Client.js";
import {
  Auctioneer2ServiceError,
  claimAuctioneerIncoming,
  closeAuctioneerContractPart,
  continueAuctioneerWorkItem,
  continueQueuedAuctioneerUpload,
  getAuctioneerDeliverySummary,
  getAuctioneerIncomingSummary,
  getAuctioneerWorkItemSetup,
  listAuctioneerDeliveries,
  listAuctioneerIncoming,
  markAuctioneerProposalItemsNotFound,
  queueAuctioneerDelivery,
  reconcileAuctioneerDelivery,
  releaseAuctioneerClaim,
} from "../service/auctioneer2IntegrationService.js";
import { TransferError } from "../service/reportTransferService.js";
import { getAuctioneerCapturePermission, reopenAuctioneerContractPart } from "../service/auctioneerContractReopenService.js";

/**
 * HTTP adapter for the Auctioneer 2.0 integration workflow.
 *
 * Business rules, claim ownership and delivery state transitions remain in the
 * integration service. This layer supplies the authenticated actor, preserves a
 * uniform response envelope, and translates typed domain/upstream failures into
 * the public status/code contract used by clients and operational tooling.
 */

function sendIntegrationError(res: Response, error: unknown) {
  // Domain errors are safe to expose; unexpected exceptions intentionally collapse
  // to a generic error so internal implementation details never cross the boundary.
  if (error instanceof Auctioneer2ServiceError || error instanceof TransferError) {
    return res.status(error.statusCode).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
  if (error instanceof Auctioneer2ClientError) {
    return res.status(error.statusCode).json({
      success: false,
      message: error.message,
      code: error.code,
      ...(error.upstreamStatus ? { upstreamStatus: error.upstreamStatus } : {}),
    });
  }
  return res.status(500).json({
    success: false,
    message: "Auctioneer 2.0 request failed.",
    code: "auctioneer2_internal_error",
  });
}

function requireUserId(req: AuthRequest): string {
  if (!req.userId) {
    throw new Auctioneer2ServiceError("Not authorized.", 401, "not_authorized");
  }
  return req.userId;
}

export async function getAuctioneerStatus(_req: AuthRequest, res: Response) {
  try {
    const status = await verifyAuctioneer2Connection();
    return res.json({
      success: true,
      data: {
        enabled: status.enabled,
        configured: status.configured,
        baseUrl: status.baseUrl,
        reachable: status.reachable,
        verificationEndpoint: status.verificationEndpoint,
      },
    });
  } catch (error) {
    if (error instanceof Auctioneer2ClientError) {
      // Reachability is status data, not a failed status endpoint. Returning 200
      // lets dashboards distinguish an unavailable upstream from a broken API call.
      const status = getAuctioneer2ConfigStatus();
      return res.json({
        success: true,
        data: {
          enabled: status.enabled,
          configured: status.configured,
          baseUrl: status.baseUrl,
          reachable: false,
          verificationEndpoint: null,
          message: error.message,
        },
      });
    }
    return sendIntegrationError(res, error);
  }
}

export async function getAuctioneerIncoming(req: AuthRequest, res: Response) {
  try {
    // Refresh is explicit because an upstream fetch can be slower and less reliable
    // than serving the integration service's current view.
    const force = String(req.query.refresh || "").toLowerCase() === "true";
    return res.json({
      success: true,
      data: await listAuctioneerIncoming(force, requireUserId(req)),
    });
  } catch (error) {
    return sendIntegrationError(res, error);
  }
}

export async function getAuctioneerIncomingSummaryController(
  req: AuthRequest,
  res: Response
) {
  try {
    return res.json(await getAuctioneerIncomingSummary(requireUserId(req)));
  } catch (error) {
    return sendIntegrationError(res, error);
  }
}

export async function claimAuctioneerWork(req: AuthRequest, res: Response) {
  try {
    const data = await claimAuctioneerIncoming(
      req.params.cycleKey,
      requireUserId(req),
      req.body?.reportType
    );
    return res.status(201).json({ success: true, data });
  } catch (error) {
    return sendIntegrationError(res, error);
  }
}

export async function getAuctioneerSetup(req: AuthRequest, res: Response) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const data = await getAuctioneerWorkItemSetup(
      req.params.id,
      requireUserId(req)
    );
    return res.json({ success: true, data });
  } catch (error) {
    return sendIntegrationError(res, error);
  }
}

export async function continueAuctioneerWork(req: AuthRequest, res: Response) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const result = await continueAuctioneerWorkItem(req.params.id, requireUserId(req), req.body);
    return res.status(result.created ? 201 : 200).json({ success: true, data: result.setup });
  } catch (error) {
    return sendIntegrationError(res, error);
  }
}

export async function continueQueuedAuctioneerWork(req: AuthRequest, res: Response) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const result = await continueQueuedAuctioneerUpload(req.params.id, req);
    return res.status(result.created ? 201 : 200).json({ success: true, data: { reservation: result.reservation, setup: result.setup } });
  } catch (error) { return sendIntegrationError(res, error); }
}

/**
 * Returns listed Proposal items the signed-in user could not find (owner
 * 2026-10-28). The user comes from the session; the body names the items.
 */
export async function markAuctioneerProposalItemsNotFoundController(req: AuthRequest, res: Response) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const data = await markAuctioneerProposalItemsNotFound(req.params.id, requireUserId(req), req.body);
    return res.json({ success: true, data });
  } catch (error) {
    return sendIntegrationError(res, error);
  }
}

export async function deleteAuctioneerClaim(req: AuthRequest, res: Response) {
  try {
    const data = await releaseAuctioneerClaim(req.params.id, requireUserId(req));
    return res.json({ success: true, data });
  } catch (error) {
    return sendIntegrationError(res, error);
  }
}

export async function getAuctioneerDeliveries(req: AuthRequest, res: Response) {
  try {
    return res.json({
      success: true,
      data: await listAuctioneerDeliveries(requireUserId(req)),
    });
  } catch (error) {
    return sendIntegrationError(res, error);
  }
}

export async function getAuctioneerDelivery(req: AuthRequest, res: Response) {
  try {
    return res.json({
      success: true,
      data: await getAuctioneerDeliverySummary(req.params.id, requireUserId(req)),
    });
  } catch (error) {
    return sendIntegrationError(res, error);
  }
}

export async function sendAuctioneerDelivery(req: AuthRequest, res: Response) {
  try {
    const data = await queueAuctioneerDelivery(
      req.params.id,
      requireUserId(req),
      req.body || {}
    );
    // Delivery continues asynchronously; 202 acknowledges queue acceptance rather
    // than implying that the remote auctioneer has received the payload already.
    return res.status(202).json({ success: true, data });
  } catch (error) {
    return sendIntegrationError(res, error);
  }
}

/**
 * The signed-in user closes their own part of a contract without another
 * delivery. The user comes from the session only — never from the body or the
 * query — so nobody can close a part on another person's behalf.
 */
export async function closeAuctioneerContractPartController(
  req: AuthRequest,
  res: Response
) {
  res.setHeader("Cache-Control", "no-store");
  try {
    const data = await closeAuctioneerContractPart(
      req.params.contractId,
      requireUserId(req),
      req.body?.accessRevision
    );
    return res.json({ success: true, data });
  } catch (error) {
    return sendIntegrationError(res, error);
  }
}

export async function getAuctioneerCapturePermissionController(req: AuthRequest, res: Response) {
  res.setHeader("Cache-Control", "no-store, private");
  try {
    if (Object.keys(req.query).length) throw new Auctioneer2ServiceError("The signed-in user is selected automatically. Refresh Incoming.", 400, "invalid_reopen_request");
    return res.json({ success: true, data: await getAuctioneerCapturePermission(req.params.contractId, requireUserId(req)) });
  } catch (error) { return sendIntegrationError(res, error); }
}

export async function reopenAuctioneerContractPartController(req: AuthRequest, res: Response) {
  res.setHeader("Cache-Control", "no-store, private");
  try {
    if (Object.keys(req.query).length || (req.body != null &&
        (typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length))) throw new Auctioneer2ServiceError(
      "Re-Open uses the signed-in user's assignment. Send an empty request and refresh Incoming.", 400, "invalid_reopen_request");
    return res.json({ success: true, data: await reopenAuctioneerContractPart(req.params.contractId, requireUserId(req)) });
  } catch (error) { return sendIntegrationError(res, error); }
}

export async function reconcileAuctioneerDeliveryController(
  req: AuthRequest,
  res: Response
) {
  try {
    const data = await reconcileAuctioneerDelivery(
      req.params.id,
      requireUserId(req),
      req.body || {}
    );
    return res.json({ success: true, data });
  } catch (error) {
    return sendIntegrationError(res, error);
  }
}
