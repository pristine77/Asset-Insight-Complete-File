import { SERVER_URL } from "@/lib/api";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export async function requireOperationalAdminPage(): Promise<void> {
  const token = (await cookies()).get("cv_admin")?.value;
  if (!token) redirect("/login");
  const response = await fetch(`${SERVER_URL}/api/admin/me`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!response.ok) redirect("/login");
  const payload = await response.json().catch(() => ({}));
  if (!["admin", "superadmin"].includes(payload.user?.role)) redirect("/reports");
}
