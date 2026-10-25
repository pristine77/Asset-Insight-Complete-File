import AdminDevices from "@/app/components/admin/devices/AdminDevices";
import AdminNavbarV2 from "@/app/components/common/AdminNavbarV2";
import { SERVER_URL } from "@/lib/api";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export default async function DevicesPage() {
  const token = (await cookies()).get("cv_admin")?.value;
  if (!token) redirect("/login");

  const response = await fetch(`${SERVER_URL}/api/admin/me`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!response.ok) redirect("/login");
  const payload = (await response.json().catch(() => ({}))) as {
    user?: { role?: string };
  };
  if (payload.user?.role !== "admin" && payload.user?.role !== "superadmin") {
    redirect("/reports");
  }

  return (
    <AdminNavbarV2>
      <AdminDevices />
    </AdminNavbarV2>
  );
}
