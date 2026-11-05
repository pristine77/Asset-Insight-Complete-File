import AdminNavbarV2 from "@/app/components/common/AdminNavbarV2";
import PreviewReportsPage from "@/app/components/preview-reports/PreviewReportsPage";
import { requireOperationalAdminPage } from "@/lib/requireOperationalAdminPage";

/*
 * Admins as well as the superadmin (owner, 2026-11-04: "Can the 'reassign'
 * Function be given to an Admin too?"). Admins see every preview, both tabs,
 * and may Reassign; Resubmit preview, Delete and Notify stay superadmin only
 * (canManage), and the server refuses them to an admin as well.
 */
export default async function Page({ searchParams }: { searchParams: Promise<{ reportId?: string }> }) {
  const role = await requireOperationalAdminPage();
  const query = await searchParams;
  const reportId = /^[a-f\d]{24}$/i.test(query.reportId || "") ? query.reportId! : null;

  return (
    <AdminNavbarV2>
      <PreviewReportsPage initialReportId={reportId} canManage={role === "superadmin"} />
    </AdminNavbarV2>
  );
}
