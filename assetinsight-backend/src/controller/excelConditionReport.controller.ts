import type { Response } from "express";
import type { AuthRequest } from "../middleware/auth.middleware.js";
import {
  ExcelConditionReportError,
  getExcelConditionReports,
  regenerateExcelOnly,
  saveExcelConditionReports,
} from "../service/excelConditionReportService.js";

/**
 * Admin-only transport layer for editing and regenerating the Excel condition
 * report attached to a report group. Persistence, validation and artifact
 * generation live in the service; this file preserves the existing HTTP shapes.
 */

function isAdmin(req: AuthRequest): boolean {
  // This is defense in depth at the controller boundary; route middleware remains
  // responsible for authenticating the request and attaching the trusted user.
  const role = String((req as any)?.user?.role || "");
  return role === "admin" || role === "superadmin";
}

function handleError(res: Response, error: any, fallback: string) {
  // Preserve service error codes for actionable client failures while giving
  // unexpected exceptions one consistent, backwards-compatible error envelope.
  const statusCode =
    error instanceof ExcelConditionReportError
      ? error.statusCode
      : Number(error?.statusCode || 500);
  return res.status(statusCode).json({
    code: error?.code || "EXCEL_CONDITION_REPORT_ERROR",
    message: error?.message || fallback,
  });
}

export const getAdminExcelConditionReports = async (
  req: AuthRequest,
  res: Response
) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ message: "Admin privileges required" });
  }
  try {
    const data = await getExcelConditionReports(req.params.id);
    return res.status(200).json({ data });
  } catch (error) {
    console.error("getAdminExcelConditionReports error:", error);
    return handleError(res, error, "Failed to load Excel Condition Reports");
  }
};

export const patchAdminExcelConditionReports = async (
  req: AuthRequest,
  res: Response
) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ message: "Admin privileges required" });
  }
  try {
    const data = await saveExcelConditionReports(req.params.id, req.body);
    return res.status(200).json({
      message: "Excel Condition Report changes saved",
      data,
    });
  } catch (error) {
    console.error("patchAdminExcelConditionReports error:", error);
    return handleError(res, error, "Failed to save Excel Condition Reports");
  }
};

export const regenerateAdminExcel = async (req: AuthRequest, res: Response) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ message: "Admin privileges required" });
  }
  try {
    // Regeneration is intentionally Excel-only: other report artifacts must not be
    // changed as a side effect of an administrator correcting this workbook.
    const data = await regenerateExcelOnly(req.params.id);
    return res.status(200).json({
      message: "Excel regenerated successfully",
      data,
    });
  } catch (error) {
    console.error("regenerateAdminExcel error:", error);
    return handleError(res, error, "Failed to regenerate Excel");
  }
};
