import AdminNavbarV2 from "@/app/components/common/AdminNavbarV2";
import PreviewReportsPage from "@/app/components/preview-reports/PreviewReportsPage";
import { requireSuperadminPage } from "@/lib/requireSuperadminPage";

export default async function Page({ searchParams }: { searchParams: Promise<{ reportId?: string }> }) {
  await requireSuperadminPage();
  const query = await searchParams;
  const reportId = /^[a-f\d]{24}$/i.test(query.reportId || "") ? query.reportId! : null;

  return (
    <AdminNavbarV2>
      <PreviewReportsPage initialReportId={reportId} />
    </AdminNavbarV2>
  );
}
