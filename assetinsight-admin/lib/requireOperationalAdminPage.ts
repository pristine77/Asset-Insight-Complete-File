import { SERVER_URL } from "@/lib/api";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export type OperationalAdminRole = "admin" | "superadmin";

/**
 * Lets an admin or a superadmin in, and answers which one (a page that offers
 * superadmin-only buttons, such as Preview Reports, hides them from an admin).
 */
export async function requireOperationalAdminPage(): Promise<OperationalAdminRole> {
  const token = (await cookies()).get("cv_admin")?.value;
  if (!token) redirect("/login");
  const response = await fetch(`${SERVER_URL}/api/admin/me`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!response.ok) redirect("/login");
  const payload = await response.json().catch(() => ({}));
  const role = payload.user?.role;
  if (role !== "admin" && role !== "superadmin") redirect("/reports");
  return role;
}
