/**
 * Admin endpoints for moving CRM leads in bulk and for vacant pools (owner,
 * 2026-11-20). The rules are in service/crmLeadMoveService.ts; these only read
 * the request, call it and turn its refusals into answers. Admin only
 * (adminProtect on every route).
 */
import { Response } from "express";
import { AdminAuthRequest } from "../middleware/admin.middleware.js";
import {
  CrmLeadMoveError,
  createVacantPool,
  listLeadMoves,
  listMoveOwners,
  moveLeads,
  previewLeadMove,
} from "../service/crmLeadMoveService.js";

function adminId(req: AdminAuthRequest): string {
  return String((req as any).userId || (req as any).user?._id || "");
}

async function answer(res: Response, what: string, work: () => Promise<unknown>) {
  try {
    res.set("Cache-Control", "no-store");
    return res.status(200).json(await work());
  } catch (e: any) {
    if (e instanceof CrmLeadMoveError) return res.status(e.statusCode).json({ message: e.message });
    console.error(`${what} error`, e);
    return res.status(500).json({ message: e?.message || `Failed to ${what}` });
  }
}

/** GET /admin/leads/move/owners — every owner of leads, every active agent and every vacant pool, with counts. */
export const listCrmMoveOwnersForAdmin = (req: AdminAuthRequest, res: Response) =>
  answer(res, "load lead owners", async () => ({ items: await listMoveOwners() }));

/** POST /admin/leads/move/preview — how many leads a move would take, before anything changes. */
export const previewCrmLeadMoveForAdmin = (req: AdminAuthRequest, res: Response) =>
  answer(res, "preview the move", () => previewLeadMove(req.body?.fromUserId, req.body?.filters));

/** POST /admin/leads/move — moves the matching leads to an agent or a vacant pool. */
export const moveCrmLeadsForAdmin = (req: AdminAuthRequest, res: Response) =>
  answer(res, "move the leads", () => moveLeads({
    fromUserId: req.body?.fromUserId,
    toUserId: req.body?.toUserId,
    filters: req.body?.filters,
    notify: req.body?.notify,
  }, adminId(req)));

/** GET /admin/leads/moves — the latest moves, newest first. */
export const listCrmLeadMovesForAdmin = (req: AdminAuthRequest, res: Response) =>
  answer(res, "load the moves", async () => ({ items: await listLeadMoves(Number((req.query as any)?.limit) || 20) }));

/** POST /admin/vacant-pools — creates a vacant pool ("Winnipeg" → "Vacant — Winnipeg"). */
export const createCrmVacantPoolForAdmin = (req: AdminAuthRequest, res: Response) =>
  answer(res, "create the vacant pool", () => createVacantPool(req.body?.name, adminId(req)));
