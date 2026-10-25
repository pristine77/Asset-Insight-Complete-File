import mongoose from "mongoose";
import connectDB from "../config/database.js";
import AssetReport from "../models/asset.model.js";
import AuctioneerWorkItem from "../models/auctioneerWorkItem.model.js";
import LotListing from "../models/lotListing.model.js";

async function ensureAuctioneer2Indexes() {
  await connectDB();
  await Promise.all([
    AuctioneerWorkItem.createIndexes(),
    AssetReport.createIndexes(),
    LotListing.createIndexes(),
  ]);
  console.log("Auctioneer 2.0 indexes are ready.");
  await mongoose.disconnect();
}

ensureAuctioneer2Indexes().catch(async (error) => {
  console.error(
    "Auctioneer 2.0 index setup failed:",
    error instanceof Error ? error.message : "Unknown index error"
  );
  await mongoose.disconnect().catch(() => undefined);
  process.exitCode = 1;
});
