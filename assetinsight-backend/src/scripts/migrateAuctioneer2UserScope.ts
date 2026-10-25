import mongoose from "mongoose";
import connectDB from "../config/database.js";
import { migrateAuctioneer2UserScope } from "../service/auctioneer2UserScopeMigrationService.js";

async function run() {
  await connectDB();
  const result = await migrateAuctioneer2UserScope();
  console.log(
    `Auctioneer 2.0 user-scope migration complete. Scanned ${result.scanned}, updated ${result.updated}.`
  );
}

run()
  .catch((error) => {
    console.error(
      "Auctioneer 2.0 user-scope migration failed:",
      error instanceof Error ? error.message : "Unknown migration error"
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
