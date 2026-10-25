import { Suspense } from "react";
import AdminNavbarV2 from "@/app/components/common/AdminNavbarV2";
import EmployeeStatsDashboard from "@/app/components/stats/EmployeeStatsDashboard";
import { requireSuperadminPage } from "@/lib/requireSuperadminPage";

export default async function StatsPage() {
  await requireSuperadminPage();

  return (
    <AdminNavbarV2>
      <Suspense fallback={null}>
        <EmployeeStatsDashboard />
      </Suspense>
    </AdminNavbarV2>
  );
}
