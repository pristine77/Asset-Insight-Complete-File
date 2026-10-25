import mongoose from "mongoose";
import dotenv from "dotenv";
import AssetReport from "../models/asset.model.js";
import { normalizeAssetContractKey } from "../service/assetReportMergeService.js";

dotenv.config();

async function backfillAssetContractKeys() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) throw new Error("MONGO_URI or MONGODB_URI is required");

  await mongoose.connect(mongoUri);
  let scanned = 0;
  let updated = 0;
  let operations: any[] = [];

  // Cursor + unordered bulk writes keep the migration bounded and safe to run
  // repeatedly on production-sized collections.
  const cursor = AssetReport.find({}).select("contract_no contract_key preview_data.contract_no").lean().cursor();
  for await (const report of cursor) {
    scanned += 1;
    const contractKey = normalizeAssetContractKey(
      (report as any).preview_data?.contract_no || (report as any).contract_no
    );
    const current = String((report as any).contract_key || "");
    if (contractKey === current) continue;

    operations.push({
      updateOne: {
        filter: { _id: report._id },
        update: contractKey
          ? { $set: { contract_key: contractKey } }
          : { $unset: { contract_key: "" } },
      },
    });
    if (operations.length >= 500) {
      const result = await AssetReport.bulkWrite(operations, { ordered: false });
      updated += result.modifiedCount;
      operations = [];
    }
  }
  if (operations.length > 0) {
    const result = await AssetReport.bulkWrite(operations, { ordered: false });
    updated += result.modifiedCount;
  }

  console.log(`Asset contract-key backfill complete. Scanned ${scanned}, updated ${updated}.`);
  await mongoose.disconnect();
}

backfillAssetContractKeys().catch(async (error) => {
  console.error("Asset contract-key backfill failed:", error);
  await mongoose.disconnect().catch(() => undefined);
  process.exitCode = 1;
});
