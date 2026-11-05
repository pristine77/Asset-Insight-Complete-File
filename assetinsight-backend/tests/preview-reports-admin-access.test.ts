/**
 * Preview Reports for admins (owner, 2026-11-04): "Can the 'reassign' Function
 * be given to an Admin too? It is currently in the Super admin."
 *
 * Answers: admins see every preview, both tabs (Report previews and Draft
 * previews), and may Reassign; Resubmit preview, Delete and Notify stay
 * superadmin only. adminProtect admits admins and superadmins only.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routes = readFileSync(new URL("../src/routes/admin.routes.ts", import.meta.url), "utf8").replace(/\s+/g, " ");
const guard = readFileSync(new URL("../src/middleware/admin.middleware.ts", import.meta.url), "utf8");

describe("preview report routes", () => {
  it("admins may list, open and reassign", () => {
    expect(routes).toContain('router.get("/preview-reports/drafts", adminProtect, getAdminDraftPreviews);');
    expect(routes).toContain('router.get("/preview-reports", adminProtect, getAdminPreviewReports);');
    expect(routes).toContain('router.get( "/preview-reports/transfer-users", adminProtect, getAdminPreviewTransferUsers );');
    expect(routes).toContain('router.post( "/preview-reports/:id/transfer", adminProtect, transferAdminPreviewReport );');
    expect(routes).toContain('router.get("/preview-reports/:id", adminProtect, getAdminPreviewReport);');
  });

  it("resubmit, delete and notify stay superadmin only", () => {
    expect(routes).toContain('router.post("/preview-reports/:id/resubmit", adminProtect, requireSuperadmin, resubmitAdminPreviewReport);');
    expect(routes).toContain('router.delete( "/preview-reports/:id", adminProtect, requireSuperadmin, deleteAdminPreviewReport );');
    expect(routes).toContain('router.delete( "/preview-reports/drafts/:id", adminProtect, requireSuperadmin, deleteAdminDraftPreview );');
    expect(routes).toContain('router.post( "/preview-reports/:id/reminder", adminProtect, requireSuperadmin, sendAdminPreviewReminder );');
    expect(routes).toContain('router.get("/preview-reports/:id/reminder", adminProtect, requireSuperadmin, getAdminPreviewReminder);');
  });

  it("adminProtect admits only admins and superadmins", () => {
    expect(guard).toContain('if (user.role !== "admin" && user.role !== "superadmin") {');
  });
});
