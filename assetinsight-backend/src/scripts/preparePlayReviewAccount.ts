import "dotenv/config";
import mongoose from "mongoose";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { preparePlayReviewAccount, type ReviewAccountSetup } from "../service/reviewAccountProvisioningService.js";

export function parsePlayReviewArguments(args: string[]): ReviewAccountSetup {
  const values = new Map<string, string>();
  let apply = false;
  for (const arg of args) {
    if (arg === "--apply" && !apply) { apply = true; continue; }
    const match = /^--(user-id|email|actor-id|reason)=(.+)$/.exec(arg);
    if (!match || values.has(match[1])) throw new Error("Use unique --user-id, --email, --actor-id, --reason and optional --apply arguments.");
    values.set(match[1], match[2]);
  }
  return { userId: values.get("user-id") || "", email: values.get("email") || "",
    actorId: values.get("actor-id") || "", reason: values.get("reason") || "", apply };
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  (async () => {
    const input = parsePlayReviewArguments(process.argv.slice(2));
    if (!process.env.MONGODB_URL) throw new Error("MONGODB_URL is required.");
    await mongoose.connect(process.env.MONGODB_URL, { maxPoolSize: 2, autoIndex: false, autoCreate: false });
    console.log(JSON.stringify(await preparePlayReviewAccount(input)));
  })().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Reviewer setup failed.");
    process.exitCode = 1;
  }).finally(async () => { if (mongoose.connection.readyState) await mongoose.disconnect(); });
}
