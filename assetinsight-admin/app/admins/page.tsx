import AdminManagement from "@/app/components/admin/AdminManagement";
import AdminNavbarV2 from "@/app/components/common/AdminNavbarV2";
import { requireSuperadminPage } from "@/lib/requireSuperadminPage";

export default async function Page() {
  await requireSuperadminPage();

  return (
    <AdminNavbarV2>
      <AdminManagement />
    </AdminNavbarV2>
  );
}
