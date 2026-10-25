import DashboardShellV2 from "@/app/components/dashboard/DashboardShellV2";
import AdminNavbarV2 from "@/app/components/common/AdminNavbarV2";
import { requireSuperadminPage } from "@/lib/requireSuperadminPage";

export default async function Page() {
  await requireSuperadminPage();

  return (
    <AdminNavbarV2>
      <DashboardShellV2 />
    </AdminNavbarV2>
  );
}
