import { SERVER_URL } from "@/lib/api";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export async function requireSuperadminPage(): Promise<void> {
  const token = (await cookies()).get("cv_admin")?.value;
  if (!token) redirect("/login");

  const response = await fetch(`${SERVER_URL}/api/admin/me`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!response.ok) redirect("/login");

  const payload: { user?: { role?: string } } = await response
    .json()
    .catch(() => ({}));
  if (payload.user?.role !== "superadmin") redirect("/reports");
}
