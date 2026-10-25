import dotenv from "dotenv";
import mongoose from "mongoose";
import connectDB from "../config/database.js";
import {
  Auctioneer2PhotoResyncError,
  resyncAuctioneer2Photos,
} from "../service/auctioneer2PhotoResyncService.js";

dotenv.config();

const USAGE =
  "Usage: npm run resync:auctioneer2-photos -- [--execute] <workItemId> [workItemId ...]";

function parseArguments(args: string[]): {
  execute: boolean;
  help: boolean;
  workItemIds: string[];
} {
  const unknownFlag = args.find(
    (argument) =>
      argument.startsWith("-") &&
      !["--execute", "--help", "-h"].includes(argument)
  );
  if (unknownFlag) {
    throw new Auctioneer2PhotoResyncError(
      `Unknown option: ${unknownFlag}`,
      "unknown_option"
    );
  }
  return {
    execute: args.includes("--execute"),
    help: args.includes("--help") || args.includes("-h"),
    workItemIds: args.filter((argument) => !argument.startsWith("-")),
  };
}

async function run() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    console.log(USAGE);
    return;
  }
  if (parsed.workItemIds.length === 0) {
    throw new Auctioneer2PhotoResyncError(
      `${USAGE}\nNo broad query is supported; provide every work item ID explicitly.`,
      "work_item_ids_required"
    );
  }

  await connectDB();
  const summary = await resyncAuctioneer2Photos({
    workItemIds: parsed.workItemIds,
    execute: parsed.execute,
  });

  // The summary contains identifiers and aggregate counts only. Never print
  // source URLs, image bodies, API keys, report payloads, or customer records.
  console.log(JSON.stringify(summary, null, 2));
  if (!parsed.execute) {
    console.log(
      "Dry run only. Re-run the same explicit IDs with --execute to POST photo batches."
    );
  }
}

run()
  .catch((error) => {
    const message =
      error instanceof Auctioneer2PhotoResyncError
        ? error.message
        : "Auctioneer photo resync failed during a database, storage, or provider operation.";
    console.error(`Auctioneer photo resync failed: ${message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => undefined);
  });
