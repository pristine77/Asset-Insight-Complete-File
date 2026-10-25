import AdminNavbarV2 from "@/app/components/common/AdminNavbarV2";
import RevenueRadarDashboard from "@/app/components/admin/RevenueRadarDashboard";
import { requireSuperadminPage } from "@/lib/requireSuperadminPage";

export default async function Page() {
  await requireSuperadminPage();

  return (
    <AdminNavbarV2>
      <RevenueRadarDashboard />
    </AdminNavbarV2>
  );
}
