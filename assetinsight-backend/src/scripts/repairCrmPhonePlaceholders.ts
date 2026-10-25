import mongoose from "mongoose";
import dotenv from "dotenv";
import CrmLead from "../models/crmLead.model.js";
import {
  normalizeCrmPhoneFields,
  phoneFieldsEqual,
} from "../utils/crmPhone.js";

dotenv.config();

async function repairCrmPhonePlaceholders() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) throw new Error("MONGO_URI or MONGODB_URI is required");

  await mongoose.connect(mongoUri);
  let scanned = 0;
  let updated = 0;
  let operations: any[] = [];

  // Cursor-based, idempotent updates keep the repair safe for production data.
  const cursor = CrmLead.find({})
    .select("phoneRaw phoneFormatted contactPhones contactMobilePhones companyPhones")
    .lean()
    .cursor();

  for await (const lead of cursor) {
    scanned += 1;
    const normalized = normalizeCrmPhoneFields(lead as any);
    if (phoneFieldsEqual(lead as any, normalized)) continue;
    operations.push({
      updateOne: {
        filter: { _id: lead._id },
        update: { $set: normalized },
      },
    });

    if (operations.length >= 500) {
      const result = await CrmLead.bulkWrite(operations, { ordered: false });
      updated += result.modifiedCount;
      operations = [];
    }
  }

  if (operations.length) {
    const result = await CrmLead.bulkWrite(operations, { ordered: false });
    updated += result.modifiedCount;
  }

  console.log(`CRM phone repair complete. Scanned ${scanned}, updated ${updated}.`);
  await mongoose.disconnect();
}

repairCrmPhonePlaceholders().catch(async (error) => {
  console.error("CRM phone repair failed:", error);
  await mongoose.disconnect().catch(() => undefined);
  process.exitCode = 1;
});
