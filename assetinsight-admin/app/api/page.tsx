import AdminNavbarV2 from "@/app/components/common/AdminNavbarV2";
import AdminApiKeys from "@/app/components/admin/AdminApiKeys";
import { requireSuperadminPage } from "@/lib/requireSuperadminPage";

export default async function Page() {
  await requireSuperadminPage();

  return (
    <AdminNavbarV2>
      <AdminApiKeys />
    </AdminNavbarV2>
  );
}
