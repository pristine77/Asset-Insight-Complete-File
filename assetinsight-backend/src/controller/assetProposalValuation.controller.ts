import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth.middleware.js";
import { queueAssetScheduleSheetRegeneration } from "../service/assetScheduleSheetRegenerationService.js";
import {
  getAdminProposalValuationExcelData,
  getProposalValuationExcelData,
  getProposalValuationRegenerationContext,
  getProposalValuationWorkspace,
  listProposalValuationEvaluatorOptions,
  listProposalValuations,
  patchProposalValuation,
  proposalValuationErrorBody,
  ProposalValuationError,
  releaseProposalValuationRegenerationClaim,
  replaceProposalValuationEvaluators,
} from "../service/proposalValuationService.js";
import {
  createProposalValuationExcelExport,
  PROPOSAL_VALUATION_XLSX_CONTENT_TYPE,
} from "../service/proposalValuationExcelService.js";
import {
  openProposalValuationEventStream,
} from "../service/proposalValuationRealtimeService.js";

function sendProposalValuationError(res: Response, error: unknown, operation: string) {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  if (error instanceof ProposalValuationError) {
    return res.status(error.statusCode).json(proposalValuationErrorBody(error));
  }
  console.error(`${operation} error`, error);
  return res.status(500).json({
    code: "PROPOSAL_VALUATION_ERROR",
    message: "Failed to process Proposal Valuation",
  });
}

function requestUser(req: AuthRequest) {
  return req.user || { _id: req.userId };
}

function sendProposalValuationExcel(
  res: Response,
  output: { buffer: Buffer; filename: string }
) {
  const filename = output.filename.replace(/[\r\n"]/g, "");
  res.setHeader("Content-Type", PROPOSAL_VALUATION_XLSX_CONTENT_TYPE);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`
  );
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  return res.status(200).send(output.buffer);
}

export const getAssetProposalValuations = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const payload = await listProposalValuations(requestUser(req));
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(payload);
  } catch (error) {
    return sendProposalValuationError(res, error, "getAssetProposalValuations");
  }
};

export const getAssetProposalValuation = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const workspace = await getProposalValuationWorkspace(
      req.params.id,
      requestUser(req)
    );
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(workspace);
  } catch (error) {
    return sendProposalValuationError(res, error, "getAssetProposalValuation");
  }
};

export const exportAssetProposalValuationExcel = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const data = await getProposalValuationExcelData(
      req.params.id,
      requestUser(req)
    );
    return sendProposalValuationExcel(
      res,
      await createProposalValuationExcelExport(data)
    );
  } catch (error) {
    return sendProposalValuationError(
      res,
      error,
      "exportAssetProposalValuationExcel"
    );
  }
};

export const exportAdminProposalValuationExcel = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const data = await getAdminProposalValuationExcelData(req.params.id);
    return sendProposalValuationExcel(
      res,
      await createProposalValuationExcelExport(data)
    );
  } catch (error) {
    return sendProposalValuationError(
      res,
      error,
      "exportAdminProposalValuationExcel"
    );
  }
};

export const getAssetProposalValuationEvaluatorOptions = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const payload = await listProposalValuationEvaluatorOptions({
      reportId: req.params.id,
      requesterId: String(req.userId || req.user?._id || ""),
      requester: requestUser(req),
      q: req.query.q,
    });
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(payload);
  } catch (error) {
    return sendProposalValuationError(
      res,
      error,
      "getAssetProposalValuationEvaluatorOptions"
    );
  }
};

export const getAdminProposalValuationEvaluatorOptions = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const payload = await listProposalValuationEvaluatorOptions({
      reportId: req.params.id,
      requesterId: String(req.userId || req.user?._id || ""),
      q: req.query.q,
      admin: true,
    });
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(payload);
  } catch (error) {
    return sendProposalValuationError(
      res,
      error,
      "getAdminProposalValuationEvaluatorOptions"
    );
  }
};

export const replaceAssetProposalValuationEvaluators = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const workspace = await replaceProposalValuationEvaluators({
      reportId: req.params.id,
      owner: requestUser(req),
      evaluatorUserIds: req.body?.evaluatorUserIds,
      baseRevision: req.body?.baseRevision,
      clientMutationId: req.body?.clientMutationId,
    });
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(workspace);
  } catch (error) {
    return sendProposalValuationError(
      res,
      error,
      "replaceAssetProposalValuationEvaluators"
    );
  }
};

export const saveAssetProposalValuation = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const workspace = await patchProposalValuation({
      reportId: req.params.id,
      user: requestUser(req),
      baseRevision: req.body?.baseRevision,
      clientMutationId: req.body?.clientMutationId,
      changes: req.body?.changes,
    });
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(workspace);
  } catch (error) {
    return sendProposalValuationError(res, error, "saveAssetProposalValuation");
  }
};

export const regenerateAssetProposalValuation = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const context = await getProposalValuationRegenerationContext({
      reportId: req.params.id,
      user: requestUser(req),
      baseRevision: req.body?.baseRevision,
      clientMutationId: req.body?.clientMutationId,
    });
    if (context.idempotent) {
      // Re-enter the queue coordinator on exact retries. Besides confirming an
      // active job, this lets its no-ReportJob reconciliation repair a process
      // death between report-flag CAS and durable ReportJob creation.
      const regeneration = await queueAssetScheduleSheetRegeneration(
        context.reportId,
        context.revision
      );
      if (!regeneration.queued) {
        throw new ProposalValuationError(
          503,
          "PV_REGENERATION_QUEUE_UNAVAILABLE",
          regeneration.warning ||
            "File regeneration could not be queued. Try again from the latest revision."
        );
      }
      return res.status(202).json({
        ...regeneration,
        revision: context.revision,
        idempotent: true,
      });
    }
    let regeneration;
    try {
      regeneration = await queueAssetScheduleSheetRegeneration(
        context.reportId,
        context.revision
      );
    } catch (error) {
      await releaseProposalValuationRegenerationClaim({
        reportId: context.reportId,
        userId: String(req.userId || req.user?._id || ""),
        mutationId: context.mutationId,
      }).catch(() => undefined);
      throw error;
    }
    if (!regeneration.queued) {
      await releaseProposalValuationRegenerationClaim({
        reportId: context.reportId,
        userId: String(req.userId || req.user?._id || ""),
        mutationId: context.mutationId,
      }).catch(() => undefined);
      throw new ProposalValuationError(
        503,
        "PV_REGENERATION_QUEUE_UNAVAILABLE",
        regeneration.warning ||
          "File regeneration could not be queued. Try again from the latest revision."
      );
    }
    return res.status(202).json({
      ...regeneration,
      revision: context.revision,
      idempotent: false,
    });
  } catch (error) {
    return sendProposalValuationError(
      res,
      error,
      "regenerateAssetProposalValuation"
    );
  }
};

export const streamAssetProposalValuationEvents = async (
  req: AuthRequest,
  res: Response
) => {
  try {
    const user = requestUser(req);
    const workspace = await getProposalValuationWorkspace(
      req.params.id,
      user
    );
    await registerAndRevalidateProposalValuationEventStream({
      req,
      res,
      workspace,
      user,
    });
  } catch (error) {
    return sendProposalValuationError(
      res,
      error,
      "streamAssetProposalValuationEvents"
    );
  }
};

export async function registerAndRevalidateProposalValuationEventStream(input: {
  req: AuthRequest;
  res: Response;
  workspace: { reportId: unknown; revision: unknown };
  user: any;
  loadWorkspace?: typeof getProposalValuationWorkspace;
}) {
  const initialRevision = Number(input.workspace.revision || 0);
  const stream = openProposalValuationEventStream({
    req: input.req,
    res: input.res,
    reportId: String(input.workspace.reportId),
    userId: String(input.req.userId || input.req.user?._id || ""),
    currentRevision: initialRevision,
  });
  if (!stream) return;

  // The first read authorizes the connection. Revalidate after registration
  // so a commit or assignment removal in the read/register gap cannot leave
  // this stream authorized against stale state or miss its revision hint.
  try {
    const revalidated = await (input.loadWorkspace ||
      getProposalValuationWorkspace)(input.req.params.id, input.user);
    const revalidatedRevision = Number(revalidated.revision || 0);
    if (!stream.isClosed() && revalidatedRevision !== initialRevision) {
      stream.resync(revalidatedRevision, "post-registration-revalidation");
    }
  } catch (error) {
    const accessLost =
      error instanceof ProposalValuationError &&
      [403, 404].includes(error.statusCode);
    stream.close(
      accessLost
        ? "access-changed"
        : "post-registration-revalidation-failed"
    );
  }
}
