import { describe, expect, it } from "vitest";
import { assertReportUploadAccepted, canSaveSeparateReportDraft, isPreviousReportReceipt, reportTransferErrorMessage, safeReportOperationError } from "./reportTransferErrors";

const error = (status: number, code: string, message: unknown, data = {}) => ({ message: `Request failed with status code ${status}`, response: { status, data: { code, message, data } } });

describe("report transfer receipts and safe error guidance", () => {
  it.each([{}, { reportId: "placeholder" }, { reportId: "r", jobId: "j", status: "preparing" }, { reportId: "r", jobId: "j", phase: "upload" }, { reportId: "r", accepted: true, readyToComplete: true }, { reportId: "r", accepted: false, status: "processing", jobId: "j" }, { reportId: "r", accepted: true, reportAvailable: false }, { reportId: " ", accepted: true }])("rejects incomplete or unavailable receipt %j", (receipt) => {
    expect(() => assertReportUploadAccepted(receipt)).toThrow(/did not confirm report acceptance/);
  });
  it.each([{ reportId: "r", jobId: "j", status: "processing" }, { data: { reportId: "r", jobId: "j", phase: "done" } }, { reportId: "r", accepted: true }])("accepts documented final receipt %j", (receipt) => {
    expect(() => assertReportUploadAccepted(receipt)).not.toThrow();
  });
  it.each([{ accepted: false }, { reportAvailable: false }, { code: "UPLOAD_SESSION_REPORT_UNAVAILABLE" }])("honors an outer denial even when the nested receipt appears accepted %j", (denial) => {
    expect(() => assertReportUploadAccepted({ ...denial, data: { reportId: "r", jobId: "j", status: "processing", accepted: true } })).toThrow(/did not confirm report acceptance/);
  });
  it("rejects an unavailable nested receipt despite accepted proof", () => {
    expect(() => assertReportUploadAccepted({ data: { reportId: "r", accepted: true, code: "UPLOAD_SESSION_REPORT_UNAVAILABLE" } })).toThrow(/did not confirm report acceptance/);
  });
  it.each(["<html>provider trace</html>", "https://storage.invalid/file?secret=token", { unsafe: "message" }, "Authorization: Bearer abc", "Error\n at work (/secret/app.ts:12:3)", "Request failed with status code 409"])("does not render unsafe/raw server messages %j", (message) => {
    const actual = reportTransferErrorMessage(error(409, "", message), "save");
    expect(actual).toContain("conflicts with saved work");
    expect(actual).not.toMatch(/<html>|https:|Bearer|status code|\/secret/);
  });
  it("retains safe validation errors without claiming a save succeeded", () => {
    expect(reportTransferErrorMessage(error(400, "", "Lot 9 needs a photo."), "submit")).toContain("Lot 9 needs a photo.");
    expect(reportTransferErrorMessage(new Error("Network Error"), "save")).toContain("latest draft save could not be confirmed");
    expect(reportTransferErrorMessage(error(409, "DRAFT_REVISION_CONFLICT", "old text"), "save")).toContain("version already saved");
    expect(safeReportOperationError(new Error("Network Error"), "Retry loading the saved draft.")).toBe("Retry loading the saved draft.");
  });
  it.each(["409", "HTTP 409", "status 409", "Status code: 409", "HTTP 409 Conflict", "404 Not Found", "HTTP/1.1 503 Service Unavailable", "Error 409"])("replaces bare status message %s with actionable guidance", (message) => {
    expect(reportTransferErrorMessage(error(409, "", message), "save")).toContain("conflicts with saved work");
    expect(reportTransferErrorMessage(new Error(message), "submit")).toContain("upload could not be confirmed");
    expect(safeReportOperationError(error(409, "", message), "Retry loading your saved draft.")).toBe("Retry loading your saved draft.");
    expect(safeReportOperationError(new Error(message), "Retry loading your saved draft.")).toBe("Retry loading your saved draft.");
  });
  it("preserves actionable errors containing lot numbers or counts that resemble status codes", () => {
    for (const message of ["Lot number 409 is already assigned within this event.", "409 photos could not be verified. Keep this form open and save again."]) {
      expect(reportTransferErrorMessage(error(409, "", message), "submit")).toContain(message);
      expect(safeReportOperationError(new Error(message), "Fallback")).toBe(message);
    }
  });
  it("requires all authoritative flags for explicit separate recovery", () => {
    const data = { accepted: true, reportAvailable: false, canCreateSeparate: true };
    expect(canSaveSeparateReportDraft(error(409, "UPLOAD_SESSION_REPORT_UNAVAILABLE", "", data))).toBe(true);
    for (const patch of [{ accepted: false }, { canCreateSeparate: false }, { reportAvailable: true }, { accepted: "true" }]) {
      expect(canSaveSeparateReportDraft(error(409, "UPLOAD_SESSION_REPORT_UNAVAILABLE", "", { ...data, ...patch }))).toBe(false);
    }
    expect(canSaveSeparateReportDraft(error(409, "SUBMISSION_MANIFEST_CHANGED", "", data))).toBe(false);
  });
  it("distinguishes prior accepted work from an ordinary resumed file transfer", () => {
    expect(isPreviousReportReceipt({ reportId: "r", reusedAcceptance: true })).toBe(true);
    expect(isPreviousReportReceipt({ reportId: "r", reusedAcceptance: false, processed: true })).toBe(false);
  });
});
