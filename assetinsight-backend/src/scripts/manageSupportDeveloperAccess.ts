import "dotenv/config";
import mongoose from "mongoose";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import connectDB from "../config/database.js";
import User from "../models/user.model.js";

type AccessAction = "grant" | "revoke";

interface CliArguments {
  action: AccessAction;
  email?: string;
  userId?: string;
  dryRun: boolean;
}

const SUPPORTED_OPTIONS = new Set(["action", "email", "user-id", "dry-run"]);

function requiredAction(value: string | undefined): AccessAction {
  if (value === "grant" || value === "revoke") return value;
  throw new Error("Set --action=grant|revoke or SUPPORT_DEVELOPER_ACCESS_ACTION");
}

function booleanValue(
  value: string | undefined,
  name: string,
  defaultValue: boolean
): boolean {
  if (value === undefined || value === "") return defaultValue;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true, false, 1, or 0`);
}

export function parseSupportDeveloperAccessArguments(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): CliArguments {
  const values = new Map<string, string>();
  for (const argument of argv) {
    if (argument === "--dry-run") {
      values.set("dry-run", "true");
      continue;
    }
    const match = argument.match(/^--([^=]+)=(.*)$/);
    if (!match || !SUPPORTED_OPTIONS.has(match[1])) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    values.set(match[1], match[2]);
  }

  const email = (
    values.get("email") || env.SUPPORT_DEVELOPER_EMAIL || ""
  ).trim();
  const userId = (
    values.get("user-id") || env.SUPPORT_DEVELOPER_USER_ID || ""
  ).trim();
  if (Boolean(email) === Boolean(userId)) {
    throw new Error(
      "Select exactly one account with --email/--user-id or SUPPORT_DEVELOPER_EMAIL/SUPPORT_DEVELOPER_USER_ID"
    );
  }
  if (userId && !mongoose.isValidObjectId(userId)) {
    throw new Error("The supplied support developer user id is not a valid MongoDB ObjectId");
  }

  return {
    action: requiredAction(
      values.get("action") || env.SUPPORT_DEVELOPER_ACCESS_ACTION
    ),
    email: email || undefined,
    userId: userId || undefined,
    dryRun: booleanValue(
      values.get("dry-run") || env.SUPPORT_DEVELOPER_DRY_RUN,
      "dry-run",
      true
    ),
  };
}

type SupportAccessAccountState = {
  role?: string;
  isBlocked?: boolean;
  canManageSupport?: boolean;
};

export function assertSupportGrantEligible(
  account: SupportAccessAccountState
): void {
  if (account.role !== "admin" && account.role !== "superadmin") {
    throw new Error("Support developer access can only be granted to an admin account");
  }
  if (account.isBlocked === true) {
    throw new Error("Support developer access cannot be granted to an inactive account");
  }
}

export function confirmConcurrentSupportAccessState(
  current: SupportAccessAccountState | null,
  enabled: boolean
): void {
  if (!current) {
    throw new Error("Account was deleted before the support access update completed");
  }
  if (enabled) assertSupportGrantEligible(current);
  if (current.canManageSupport !== enabled) {
    throw new Error("Account changed concurrently; no support access update was confirmed");
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function main(): Promise<void> {
  const input = parseSupportDeveloperAccessArguments();
  await connectDB();

  const selector = input.userId
    ? { _id: new mongoose.Types.ObjectId(input.userId) }
    : { email: new RegExp(`^${escapeRegex(input.email!)}$`, "i") };
  // A two-row limit is deliberate: email matching is case-insensitive so a
  // legacy database containing case variants cannot grant the wrong identity.
  const matches = await User.find(selector)
    .select("_id email username role isBlocked canManageSupport")
    .limit(2)
    .lean();
  if (matches.length === 0) throw new Error("Support developer account was not found");
  if (matches.length !== 1) {
    throw new Error("Account selector is not unique; use the exact MongoDB user id");
  }

  const account: any = matches[0];
  const enabled = input.action === "grant";
  if (enabled) assertSupportGrantEligible(account);

  const label = `${account.email} (${String(account._id)})`;
  if (account.canManageSupport === enabled) {
    console.log(
      `No change: support developer access is already ${enabled ? "enabled" : "disabled"} for ${label}`
    );
    return;
  }
  if (input.dryRun) {
    console.log(
      `Dry run: would ${input.action} support developer access for ${label}`
    );
    return;
  }

  const updateSelector: Record<string, unknown> = {
    _id: account._id,
    canManageSupport: { $ne: enabled },
  };
  // A grant must atomically re-check the eligibility used above. Revocation is
  // intentionally allowed after an account is blocked or demoted so access can
  // always be removed during an incident.
  if (enabled) {
    updateSelector.role = { $in: ["admin", "superadmin"] };
    updateSelector.isBlocked = { $ne: true };
  }
  const result = await User.updateOne(
    updateSelector,
    { $set: { canManageSupport: enabled } }
  );
  if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
    const current: any = await User.findById(account._id)
      .select("_id email role isBlocked canManageSupport")
      .lean();
    try {
      // A concurrent grant is successful only if the account still satisfies
      // the full eligibility predicate. Revocation has no role/block precondition.
      confirmConcurrentSupportAccessState(current, enabled);
      console.log(
        `No change: support developer access is already ${enabled ? "enabled" : "disabled"} for ${label}`
      );
      return;
    } catch (error) {
      if (
        enabled
        && current
        && current.canManageSupport === enabled
        && (current.role !== "admin" && current.role !== "superadmin")
      ) {
        throw new Error("Account was demoted before support developer access could be granted");
      }
      if (enabled && current?.canManageSupport === enabled && current.isBlocked === true) {
        throw new Error("Account was blocked before support developer access could be granted");
      }
      throw error;
    }
  }
  console.log(
    `${input.action === "grant" ? "Granted" : "Revoked"} support developer access for ${label}`
  );
}

const executedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (executedPath && resolve(fileURLToPath(import.meta.url)) === executedPath) {
  main()
    .catch((error: unknown) => {
      console.error(
        "Support developer access update failed:",
        error instanceof Error ? error.message : error
      );
      process.exitCode = 1;
    })
    .finally(async () => {
      if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    });
}
