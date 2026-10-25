import "dotenv/config";
import connectDB from "../config/database.js";
import LotListing from "../models/lotListing.model.js";
import {
  assertReportFilesReadyForWorkflow,
  markReportAutoReleased,
} from "../service/reportReleaseService.js";

async function main() {
  try {
    await connectDB();

    const cursor = LotListing.find({
      // New Auctioneer-linked jobs auto-finalize. Keep this legacy migration
      // scoped to older non-Auctioneer records; delivery readiness for any
      // historical linked records depends on generated files, not these fields.
      auctioneerWorkItem: null,
      $or: [
        { status: "pending_approval" },
        { status: "approved", release_status: "pending_release" },
      ],
    }).cursor();
    let scanned = 0;
    let approved = 0;
    let skipped = 0;

    for await (const listing of cursor) {
      scanned += 1;
      try {
        assertReportFilesReadyForWorkflow("lotListing", listing);
      } catch (error: any) {
        if (Number(error?.statusCode) !== 409) throw error;
        skipped += 1;
        console.warn(
          `[LotListing Approval Migration] Skipping ${listing._id}: ${error?.code || "FILES_UNAVAILABLE"}`
        );
        continue;
      }
      listing.files = listing.preview_files || listing.files;
      listing.status = "approved";
      (listing as any).approval_processed_at =
        (listing as any).approval_processed_at || new Date();
      (listing as any).approval_assigned_to = undefined;
      (listing as any).approval_assigned_at = undefined;
      (listing as any).approval_assigned_source = undefined;
      (listing as any).approval_assignment_email_sent_at = undefined;
      markReportAutoReleased(listing);
      listing.files_generating = false;
      listing.files_regenerating = false;
      listing.job_status = listing.job_status === "error" ? listing.job_status : "done";
      listing.job_error = undefined;
      listing.processing_completed_at = listing.processing_completed_at || new Date();
      (listing as any).generation_progress = {
        stage: "ready",
        progressPercent: 100,
        message: "Report ready",
        updatedAt: new Date(),
      };
      await listing.save();
      approved += 1;
    }

    console.log(
      `[LotListing Approval Migration] Completed. Scanned=${scanned}, Approved=${approved}, Skipped=${skipped}`
    );
    process.exit(0);
  } catch (error: any) {
    console.error("[LotListing Approval Migration] Failed:", error?.message || error);
    process.exit(1);
  }
}

main();
