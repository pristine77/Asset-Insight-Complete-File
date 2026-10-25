import { describe, expect, it } from "vitest";
import {
  assignReleaseManager,
  approvalAutomaticallyReleases,
  markReportAutoReleased,
  assertReportFilesReadyForWorkflow,
  getReportDownloadAccess,
  getReportDownloadAccessForGeneration,
  reportDownloadable,
} from "../src/service/reportReleaseService.js";
import {
  hasRequiredReportFiles,
  resolveReportGenerationStateForProfile,
} from "../src/utils/reportFileState.js";

describe("release assignment policy", () => {
  it("limits approval-triggered release to Real Estate and Salvage", () => {
    for (const type of ["RealEstate", "Salvage"]) expect(approvalAutomaticallyReleases(type)).toBe(true);
    for (const type of ["Asset", "LotListing", "", undefined, "Unknown"]) expect(approvalAutomaticallyReleases(type)).toBe(false);
  });

  it("clears stale release assignment while retaining approval ownership", () => {
    const report: Record<string, unknown> = {
      status: "approved", approval_assigned_to: "507f1f77bcf86cd799439012",
      release_status: "pending_release", release_assigned_to: "507f1f77bcf86cd799439011",
      release_assigned_at: new Date(), release_assignment_email_sent_at: new Date(),
    };
    markReportAutoReleased(report, { releasedBy: "507f1f77bcf86cd799439012" });
    expect(report).toMatchObject({ release_status: "released", release_assigned_to: null,
      release_assigned_at: null, release_assignment_email_sent_at: null, release_assigned_source: "auto_released",
      approval_assigned_to: "507f1f77bcf86cd799439012" });
    expect(String(report.released_by)).toBe("507f1f77bcf86cd799439012");
    expect(report.released_at).toBeInstanceOf(Date);
  });

  it("keeps a forced-manual report pending when no release manager is configured", async () => {
    const report: Record<string, unknown> = {};

    await assignReleaseManager(report, {
      userId: "no-configured-user",
      forceManual: true,
    });

    expect(report).toMatchObject({
      release_status: "pending_release",
      release_assigned_to: null,
      release_assigned_source: "manual_release_required",
      released_by: null,
      released_at: null,
    });
  });

  it("preserves automatic release for ordinary reports without a release manager", async () => {
    const report: Record<string, unknown> = {};

    await assignReleaseManager(report, { userId: "no-configured-user" });

    expect(report).toMatchObject({
      release_status: "released",
      release_assigned_to: null,
      release_assigned_source: "auto_released",
    });
    expect(report.released_at).toBeInstanceOf(Date);
  });
});

describe("report download policy", () => {
  it("blocks a pending legacy PdfReport even when release status is absent", () => {
    const access = getReportDownloadAccess({ approvalStatus: "pending" });

    expect(access).toMatchObject({
      allowed: false,
      code: "AWAITING_APPROVAL",
      approval_status: "pending",
      release_status: "released",
    });
    expect(reportDownloadable({ approvalStatus: "pending" })).toBe(false);
  });

  it("mentions the assigned approver for an assigned pending report", () => {
    const access = getReportDownloadAccess({
      status: "pending_approval",
      approval_assigned_to: "507f1f77bcf86cd799439011",
    });

    expect(access.code).toBe("AWAITING_APPROVAL");
    expect(access.message).toContain("assigned approver");
  });

  it("distinguishes declined and awaiting-release reports", () => {
    expect(getReportDownloadAccess({ status: "declined" }).code).toBe("DECLINED");
    expect(
      getReportDownloadAccess({
        status: "approved",
        release_status: "pending_release",
      })
    ).toMatchObject({
      allowed: false,
      code: "AWAITING_RELEASE",
      approval_status: "approved",
      release_status: "pending_release",
    });
  });

  it("allows approved released and pre-workflow legacy records", () => {
    expect(
      getReportDownloadAccess({
        approvalStatus: "approved",
        release_status: "released",
      }).code
    ).toBe("READY");
    expect(getReportDownloadAccess({ approvalStatus: "approved" }).allowed).toBe(true);
    expect(getReportDownloadAccess({}).allowed).toBe(true);
  });
});

describe("required generated report artifacts", () => {
  const complete = {
    docx: "https://files.example/report.docx",
    excel: "https://files.example/report.xlsx",
    images: "https://files.example/images.zip",
  };

  it("does not treat optional CR files as a complete Asset report", () => {
    expect(
      hasRequiredReportFiles("asset", {
        spec_pdf: "https://files.example/cr.pdf",
        cr_docx: "https://files.example/cr.docx",
      })
    ).toBe(false);
  });

  it("requires DOCX, spreadsheet, and images for Asset and Real Estate reports", () => {
    expect(hasRequiredReportFiles("asset", complete)).toBe(true);
    expect(hasRequiredReportFiles("realEstate", complete)).toBe(true);

    for (const missing of ["docx", "excel", "images"] as const) {
      const files: Record<string, string> = { ...complete };
      delete files[missing];
      expect(hasRequiredReportFiles("asset", files)).toBe(false);
      expect(hasRequiredReportFiles("realEstate", files)).toBe(false);
    }
  });

  it("requires a spreadsheet and images for Lot Listing reports", () => {
    expect(
      hasRequiredReportFiles("lotListing", {
        xlsx: "https://files.example/listing.xlsx",
        images_zip: "https://files.example/listing-images.zip",
      })
    ).toBe(true);
    expect(
      hasRequiredReportFiles("lotListing", {
        spec_pdf: "https://files.example/cr.pdf",
        excel: "https://files.example/listing.xlsx",
      })
    ).toBe(false);
  });

  it("reports a CR-only released Asset as incomplete instead of ready", () => {
    const report = {
      status: "approved",
      release_status: "released",
      job_status: "done",
    };
    const state = resolveReportGenerationStateForProfile(
      "asset",
      report,
      {
        spec_pdf: "https://files.example/cr.pdf",
        cr_docx: "https://files.example/cr.docx",
      }
    );

    expect(state.files_ready).toBe(false);
    expect(state.generation_state).toBe("error");
    expect(state.workflow_stage).toBe("error");
    expect(getReportDownloadAccessForGeneration(report, state)).toMatchObject({
      allowed: false,
      code: "FILES_UNAVAILABLE",
    });
  });

  it("does not trust stale file URLs after the latest generation failed", () => {
    const report = {
      status: "approved",
      release_status: "released",
      job_status: "error",
      job_error: "Generation failed",
      preview_files: complete,
    };
    const state = resolveReportGenerationStateForProfile(
      "asset",
      report,
      report.preview_files
    );

    expect(state.generation_state).toBe("error");
    expect(getReportDownloadAccessForGeneration(report, state).code).toBe(
      "FILES_UNAVAILABLE"
    );
    expect(() => assertReportFilesReadyForWorkflow("asset", report)).toThrow(
      "cannot be approved or released"
    );
  });

  it.each(["queued", "processing"] as const)(
    "keeps a %s Lot Listing active while publication blocks its old files",
    (jobStatus) => {
      const report = {
        status: "approved",
        release_status: "released",
        job_status: jobStatus,
        artifact_repair_required: true,
        preview_submitted_at: new Date(),
        generation_progress: {
          stage: "generating_files",
          message: "Uploading generated files",
          progressPercent: 72,
        },
        preview_files: complete,
      };
      const state = resolveReportGenerationStateForProfile(
        "lotListing", report, report.preview_files
      );

      expect(state).toMatchObject({
        files_ready: false,
        generation_state: jobStatus,
        job_status: jobStatus,
        workflow_stage: "generating_files",
        workflow_message: "Uploading generated files",
        workflow_progress_percent: 72,
      });
      expect(state.job_error).toBeUndefined();
      expect(getReportDownloadAccessForGeneration(report, state)).toMatchObject({
        allowed: false,
        code: "FILES_GENERATING",
      });
      expect(() => assertReportFilesReadyForWorkflow("lotListing", report))
        .toThrow(expect.objectContaining({ code: "FILES_GENERATING" }));
    }
  );

  it("keeps an automatic publication retry queued with its actual retry message", () => {
    const report = {
      status: "processing",
      job_status: "queued",
      artifact_repair_required: true,
      preview_submitted_at: new Date(),
      job_error: "Retrying after error: R2 copy unavailable",
      generation_progress: {
        stage: "queued",
        progressPercent: 1,
        message: "Retrying after error: R2 copy unavailable",
      },
    };
    expect(resolveReportGenerationStateForProfile("lotListing", report)).toMatchObject({
      generation_state: "queued",
      files_ready: false,
      job_status: "queued",
      workflow_stage: "generating_files",
      workflow_message: report.job_error,
    });
  });

  it.each(["done", "error", undefined])("blocks inactive Lot Listing downloads while a partial-publication marker remains (%s)", (jobStatus) => {
    const report = {
      status: "approved",
      release_status: "released",
      job_status: jobStatus,
      artifact_repair_required: true,
      preview_files: {
        excel: "https://files.example/listing.xlsx",
        images: "https://files.example/listing-images.zip",
      },
    };
    const state = resolveReportGenerationStateForProfile(
      "lotListing",
      report,
      report.preview_files
    );

    expect(state).toMatchObject({
      files_ready: false,
      generation_state: "error",
      workflow_stage: "error",
    });
    expect(getReportDownloadAccessForGeneration(report, state).allowed).toBe(
      false
    );
  });
});
