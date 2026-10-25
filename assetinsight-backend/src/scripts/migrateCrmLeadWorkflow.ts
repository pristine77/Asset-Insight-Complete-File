import "dotenv/config";
import connectDB from "../config/database.js";
import CrmLead from "../models/crmLead.model.js";
import { normalizeCrmLeadDocument } from "../service/crmWorkflowService.js";

async function main() {
  try {
    await connectDB();

    const cursor = CrmLead.find().cursor();
    let scanned = 0;
    let updated = 0;

    for await (const lead of cursor) {
      scanned += 1;
      const changed = normalizeCrmLeadDocument(lead);
      if (!changed) continue;

      await lead.save();
      updated += 1;

      if (updated % 100 === 0) {
        console.log(`[CRM Workflow Migration] Updated ${updated} leads so far...`);
      }
    }

    console.log(`[CRM Workflow Migration] Completed. Scanned=${scanned}, Updated=${updated}`);
    process.exit(0);
  } catch (error: any) {
    console.error("[CRM Workflow Migration] Failed:", error?.message || error);
    process.exit(1);
  }
}

main();
