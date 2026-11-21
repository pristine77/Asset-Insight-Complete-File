/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CRM: move an agent's leads in one step, and park them in a vacant pool
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Owner, 2026-11-20 (Bree: "Tanner has 15,000 leads from Winnipeg but he is
 * now the sales person in Edmonton"; owner: "never delete leads, but
 * remove/park them away from Tanner. All lead records are needed at some
 * point"; "can it be used for a new person in that position?" — yes).
 *
 * The only ways to move leads were one at a time (Assignments by upload >
 * Repair, an agent's transfer) or 500 at a time to the nearest agent. An admin
 * can now move every lead of one owner that matches a few filters — open only,
 * one upload, one region, one city — to another agent or to a VACANT POOL, in
 * one step, and later move the pool to whoever takes the territory.
 *
 * A VACANT POOL is a placeholder owner (User.crmVacantPool), because every
 * lead must have an owner (CrmLead.assignedTo is required). It is created
 * BLOCKED and NOT a CRM agent: every sign-in path refuses a blocked account,
 * and every agent picker, reminder job, push, email and Outlook sync selects
 * only unblocked CRM agents — so a pool can never sign in, is never chosen for
 * new leads, and its leads raise no alerts while they wait (the reminder job
 * also leaves their due dates alone). Its address is on the reserved .invalid
 * domain and its password is a random secret nobody knows.
 *
 * A move changes only who owns the lead, recorded on the lead the way the
 * upload repair records it (assignedBy, assignmentMethod, assignmentReason,
 * the new owner's geo). Notes, history, status, follow-ups and files stay.
 * Leads keep no history of owners, so each move is also written to
 * CrmLeadMove: who moved which leads, from whom to whom, under which filters.
 * Pending agent transfer requests for the moved leads are cancelled, since
 * their sender no longer owns them. The new owner, when a person, gets one
 * email and one push for the whole move, not one per lead. Leads being
 * deleted (crmDeletionToken) and review data are never moved.
 * ═══════════════════════════════════════════════════════════════════════════════
 */
import crypto from "crypto";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import User from "../models/user.model.js";
import CrmLead from "../models/crmLead.model.js";
import CrmLeadMove from "../models/crmLeadMove.model.js";
import CrmTaskTransferRequest from "../models/crmTaskTransfer.model.js";
import { CRM_OPEN_STATUSES } from "./crmWorkflowService.js";
import { normalCrmUserFilter } from "./reviewAccountPolicy.js";
import { sendCrmTasksAssignedEmail } from "./crmEmailService.js";
import { sendCrmNewTaskNotification } from "./crmPushService.js";

/** A refusal the admin screen shows as is. */
export class CrmLeadMoveError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
  }
}

/** The most leads one move may take; a larger territory is moved in parts (by region or upload). */
export const CRM_LEAD_MOVE_MAX = 100_000;
/** Leads changed per statement. */
const MOVE_BATCH = 1_000;
/** Leads named in the new owner's email; the email states the full count. */
const EMAIL_TASK_SAMPLE = 20;

/** An agent who can be given leads: the filter every CRM picker uses, never a pool. */
export const ACTIVE_CRM_AGENT_FILTER = {
  role: "user",
  isBlocked: { $ne: true },
  isCrmAgent: true,
  crmVacantPool: { $ne: true },
  ...normalCrmUserFilter(),
};

export const vacantPoolLabel = (name: string) => `Vacant — ${name}`;

type OwnerUser = {
  _id: mongoose.Types.ObjectId;
  username?: string | null;
  email?: string | null;
  role?: string | null;
  isBlocked?: boolean | null;
  isCrmAgent?: boolean | null;
  isReviewAccount?: boolean | null;
  crmVacantPool?: boolean | null;
  crmVacantPoolName?: string | null;
  crmGeo?: unknown;
  expoPushTokens?: string[] | null;
};

const OWNER_FIELDS = "username email role isBlocked isCrmAgent isReviewAccount crmVacantPool crmVacantPoolName crmGeo expoPushTokens";

export function ownerLabel(user: OwnerUser): string {
  if (user.crmVacantPool) return vacantPoolLabel(String(user.crmVacantPoolName || user.username || "pool"));
  return String(user.username || user.email || user._id);
}

export type CrmOwnerKind = "agent" | "pool" | "former";

function ownerKind(user: OwnerUser): CrmOwnerKind {
  if (user.crmVacantPool) return "pool";
  if (user.role === "user" && user.isCrmAgent && !user.isBlocked && !user.isReviewAccount) return "agent";
  return "former";
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function cleanText(value: unknown, max = 100): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/\s+/g, " ");
  return text && text.length <= max ? text : undefined;
}

function objectId(value: unknown, what: string): mongoose.Types.ObjectId {
  const text = typeof value === "string" ? value.trim() : "";
  if (!mongoose.Types.ObjectId.isValid(text)) throw new CrmLeadMoveError(`Choose ${what}.`);
  return new mongoose.Types.ObjectId(text);
}

// ── Vacant pools ───────────────────────────────────────────────────────────────

/** Creates a vacant pool, e.g. "Winnipeg" → "Vacant — Winnipeg". */
export async function createVacantPool(rawName: unknown, adminId: unknown) {
  const name = cleanText(rawName, 60);
  if (!name || name.length < 2) throw new CrmLeadMoveError("Give the vacant pool a name of 2 to 60 characters, such as Winnipeg.");
  const taken = await User.exists({ crmVacantPool: true, crmVacantPoolName: new RegExp(`^${escapeRegExp(name)}$`, "i") });
  if (taken) throw new CrmLeadMoveError(`There is already a vacant pool called ${name}.`, 409);
  const id = new mongoose.Types.ObjectId();
  // A secret nobody is told, hashed as a password is: the pool cannot sign in.
  const password = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10);
  await User.create({
    _id: id,
    username: vacantPoolLabel(name),
    email: `crm-vacant-pool-${id}@vacant-pool.invalid`,
    password,
    authProvider: "email",
    role: "user",
    isVerified: false,
    isBlocked: true,
    isCrmAgent: false,
    crmVacantPool: true,
    crmVacantPoolName: name,
    crmAssignedAt: new Date(),
    crmAssignedBy: mongoose.Types.ObjectId.isValid(String(adminId)) ? new mongoose.Types.ObjectId(String(adminId)) : undefined,
  });
  return { id: String(id), name, label: vacantPoolLabel(name) };
}

// ── Owners ─────────────────────────────────────────────────────────────────────

export type CrmMoveOwner = { id: string; label: string; kind: CrmOwnerKind; total: number; open: number };

/**
 * Everyone a move can start from or go to: every owner of leads (with their
 * lead counts, all and open), every active agent and every vacant pool.
 * Review accounts and their data are left out.
 */
export async function listMoveOwners(): Promise<CrmMoveOwner[]> {
  const counts: Array<{ _id: mongoose.Types.ObjectId; total: number; open: number }> = await CrmLead.aggregate([
    { $match: { isReviewData: { $ne: true } } },
    { $group: { _id: "$assignedTo", total: { $sum: 1 }, open: { $sum: { $cond: [{ $in: ["$status", CRM_OPEN_STATUSES] }, 1, 0] } } } },
  ]);
  const countById = new Map(counts.map((row) => [String(row._id), row]));
  const users = (await User.find({
    $or: [{ _id: { $in: counts.map((row) => row._id) } }, ACTIVE_CRM_AGENT_FILTER, { crmVacantPool: true }],
  }).select(OWNER_FIELDS).lean()) as unknown as OwnerUser[];
  const order: Record<CrmOwnerKind, number> = { agent: 0, pool: 1, former: 2 };
  return users
    .filter((user) => !user.isReviewAccount)
    .map((user) => {
      const row = countById.get(String(user._id));
      return { id: String(user._id), label: ownerLabel(user), kind: ownerKind(user), total: row?.total ?? 0, open: row?.open ?? 0 };
    })
    .sort((a, b) => order[a.kind] - order[b.kind] || a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
}

// ── Which leads ────────────────────────────────────────────────────────────────

export type CrmLeadMoveFilters = { openOnly: boolean; sourceBatchId?: string; region?: string; city?: string };

/** The filters as the admin sent them, checked. */
export function readMoveFilters(raw: unknown): CrmLeadMoveFilters {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    openOnly: body.openOnly === true,
    sourceBatchId: cleanText(body.sourceBatchId, 120),
    region: cleanText(body.region, 20),
    city: cleanText(body.city, 80),
  };
}

/**
 * The owner's leads that match: open only (not Won or Lost), one upload, one
 * region (as assignment matched it, e.g. "CA-MB") and one city (the lead's
 * resolved city, or its company location naming it). Never review data, never
 * a lead being deleted.
 */
export function moveLeadFilter(fromId: mongoose.Types.ObjectId, filters: CrmLeadMoveFilters): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    assignedTo: fromId,
    isReviewData: { $ne: true },
    crmDeletionToken: { $exists: false },
  };
  if (filters.openOnly) filter.status = { $in: CRM_OPEN_STATUSES };
  if (filters.sourceBatchId) filter.sourceBatchId = filters.sourceBatchId;
  if (filters.region) filter.assignmentMatchedRegion = new RegExp(`^${escapeRegExp(filters.region)}$`, "i");
  if (filters.city) {
    filter.$or = [
      { "leadGeo.city": new RegExp(`^${escapeRegExp(filters.city)}$`, "i") },
      { companyLocation: new RegExp(escapeRegExp(filters.city), "i") },
    ];
  }
  return filter;
}

async function findOwner(id: mongoose.Types.ObjectId): Promise<OwnerUser | null> {
  return (await User.findById(id).select(OWNER_FIELDS).lean()) as unknown as OwnerUser | null;
}

/** How many leads a move would take, and how they break down, before anything changes. */
export async function previewLeadMove(rawFrom: unknown, rawFilters: unknown) {
  const fromId = objectId(rawFrom, "whose leads to move");
  const from = await findOwner(fromId);
  if (!from) throw new CrmLeadMoveError("That owner no longer exists.", 404);
  const filters = readMoveFilters(rawFilters);
  const match = moveLeadFilter(fromId, filters);
  const group = (field: string, limit: number) => CrmLead.aggregate([
    { $match: match },
    { $group: { _id: field, count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
    { $limit: limit },
  ]);
  const [count, byStatus, byRegion, byCity] = await Promise.all([
    CrmLead.countDocuments(match),
    group("$status", 20),
    group("$assignmentMatchedRegion", 30),
    group("$leadGeo.city", 30),
  ]);
  const rows = (items: Array<{ _id: unknown; count: number }>) =>
    items.map((item) => ({ value: item._id === null || item._id === undefined || item._id === "" ? "" : String(item._id), count: item.count }));
  return {
    from: { id: String(from._id), label: ownerLabel(from), kind: ownerKind(from) },
    filters,
    count,
    max: CRM_LEAD_MOVE_MAX,
    byStatus: rows(byStatus),
    byRegion: rows(byRegion),
    byCity: rows(byCity),
  };
}

// ── The move ───────────────────────────────────────────────────────────────────

export type CrmLeadMoveInput = { fromUserId: unknown; toUserId: unknown; filters: unknown; notify?: unknown };

/** Moves the matching leads to an active agent or a vacant pool. */
export async function moveLeads(input: CrmLeadMoveInput, adminId: unknown) {
  const fromId = objectId(input.fromUserId, "whose leads to move");
  const toId = objectId(input.toUserId, "who receives the leads");
  if (fromId.equals(toId)) throw new CrmLeadMoveError("Choose a different owner to move the leads to.");
  if (!mongoose.Types.ObjectId.isValid(String(adminId))) throw new CrmLeadMoveError("Sign in again as an admin.", 401);
  const movedBy = new mongoose.Types.ObjectId(String(adminId));

  const [from, to] = await Promise.all([findOwner(fromId), findOwner(toId)]);
  if (!from) throw new CrmLeadMoveError("That owner no longer exists.", 404);
  if (!to) throw new CrmLeadMoveError("The owner to move the leads to no longer exists.", 404);
  const toKind = ownerKind(to);
  if (toKind === "former") throw new CrmLeadMoveError(`${ownerLabel(to)} is not an active CRM agent or a vacant pool.`);

  const filters = readMoveFilters(input.filters);
  const match = moveLeadFilter(fromId, filters);
  const expected = await CrmLead.countDocuments(match);
  if (expected === 0) throw new CrmLeadMoveError("No leads match: nothing to move.");
  if (expected > CRM_LEAD_MOVE_MAX) {
    throw new CrmLeadMoveError(`${expected.toLocaleString("en-CA")} leads match; one move takes at most ${CRM_LEAD_MOVE_MAX.toLocaleString("en-CA")}. Narrow it by region, city or upload and move it in parts.`);
  }

  const fromLabel = ownerLabel(from);
  const toLabel = ownerLabel(to);
  const set: Record<string, unknown> = {
    assignedTo: toId,
    assignedBy: movedBy,
    assignmentMethod: "admin_bulk_move",
    assignmentReason: `Moved from ${fromLabel} to ${toLabel} by admin`,
  };
  const unset: Record<string, ""> = { assignmentDistanceKm: "" };
  if (toKind === "agent" && to.crmGeo) set.assignedUserGeo = to.crmGeo;
  else unset.assignedUserGeo = "";

  const movedIds: mongoose.Types.ObjectId[] = [];
  const sample: Array<{ title?: string; clientName?: string; dueDate?: Date }> = [];
  // Each pass takes the next leads still owned by `from`; a pass that changes
  // nothing (a lead moved or deleted meanwhile) stops the loop.
  for (let pass = 0; pass <= Math.ceil(expected / MOVE_BATCH) + 1; pass += 1) {
    const batch = (await CrmLead.find(match)
      .select("_id title clientName dueDate")
      .sort({ _id: 1 })
      .limit(MOVE_BATCH)
      .lean()) as unknown as Array<{ _id: mongoose.Types.ObjectId; title?: string; clientName?: string; dueDate?: Date }>;
    if (batch.length === 0) break;
    const ids = batch.map((lead) => lead._id);
    const result = await CrmLead.updateMany(
      { _id: { $in: ids }, assignedTo: fromId, crmDeletionToken: { $exists: false } },
      { $set: set, $unset: unset },
    );
    if (result.modifiedCount === 0) break;
    movedIds.push(...ids);
    for (const lead of batch) if (sample.length < EMAIL_TASK_SAMPLE) sample.push({ title: lead.title, clientName: lead.clientName, dueDate: lead.dueDate });
  }

  // Their sender no longer owns these leads.
  for (let i = 0; i < movedIds.length; i += 5_000) {
    await CrmTaskTransferRequest.updateMany(
      { leadId: { $in: movedIds.slice(i, i + 5_000) }, status: "pending" },
      { $set: { status: "cancelled", respondedAt: new Date(), respondedBy: movedBy } },
    );
  }

  const record = await CrmLeadMove.create({
    fromUserId: fromId,
    toUserId: toId,
    fromLabel,
    toLabel,
    movedBy,
    filters,
    leadIds: movedIds,
    count: movedIds.length,
  });

  if (toKind === "agent" && input.notify !== false && movedIds.length > 0) {
    await Promise.allSettled([
      to.email ? sendCrmTasksAssignedEmail({ email: to.email, username: to.username || undefined }, sample, movedIds.length) : Promise.resolve(),
      sendCrmNewTaskNotification({
        userId: String(to._id),
        tokens: (to.expoPushTokens || []) as string[],
        leadId: movedIds.length === 1 ? String(movedIds[0]) : undefined,
        clientName: sample[0]?.clientName,
        title: sample[0]?.title,
        count: movedIds.length,
        reason: "reassignment",
      }),
    ]).then((settled) => {
      for (const result of settled) if (result.status === "rejected") console.error("moveLeads notification error", result.reason);
    });
  }

  return { moveId: String(record._id), movedCount: movedIds.length, from: fromLabel, to: toLabel };
}

/** The latest moves, newest first, for the admin screen's history. */
export async function listLeadMoves(limit = 20) {
  const moves = await CrmLeadMove.find({})
    .select("fromLabel toLabel movedBy filters count createdAt")
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(limit, 1), 100))
    .populate("movedBy", "username email")
    .lean();
  return moves.map((move: any) => ({
    id: String(move._id),
    from: move.fromLabel,
    to: move.toLabel,
    count: move.count,
    filters: move.filters,
    movedBy: move.movedBy?.username || move.movedBy?.email || "",
    createdAt: move.createdAt,
  }));
}
