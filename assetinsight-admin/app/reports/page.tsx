import AdminReports from "@/app/components/reports/AdminReports";
import AdminNavbarV2 from "@/app/components/common/AdminNavbarV2";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SERVER_URL } from "@/lib/api";

export default async function Page() {
  const token = (await cookies()).get("cv_admin")?.value;
  if (!token) redirect("/login");

  // Verify token is valid
  const res = await fetch(`${SERVER_URL}/api/admin/me`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) redirect("/login");

  // All authenticated users can access reports (filtering done at API level)
  return (
    <AdminNavbarV2>
      <AdminReports />
    </AdminNavbarV2>
  );
}
