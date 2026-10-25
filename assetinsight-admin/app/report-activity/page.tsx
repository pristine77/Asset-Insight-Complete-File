import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import AdminNavbarV2 from "@/app/components/common/AdminNavbarV2";
import ReportActivityPage from "@/app/components/report-activity/ReportActivityPage";
import { SERVER_URL } from "@/lib/api";
export const metadata = { title: "Report Activity | Asset Insight Admin" };
export default async function Page({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const token = (await cookies()).get("cv_admin")?.value;
  if (!token) redirect("/login");
  const response = await fetch(`${SERVER_URL}/api/admin/me`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
  if (!response.ok) redirect("/login");
  const payload = await response.json().catch(() => ({}));
  if (!["admin", "superadmin"].includes(payload.user?.role)) redirect("/reports");
  return <AdminNavbarV2><ReportActivityPage initialTab={(await searchParams).tab === "captures" ? "captures" : "activity"} /></AdminNavbarV2>;
}
