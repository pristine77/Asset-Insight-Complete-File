import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import AdminNavbarV2 from "@/app/components/common/AdminNavbarV2";
import ReportDataPage from "@/app/components/reports/ReportDataPage";
import { SERVER_URL } from "@/lib/api";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string | string[] }>;
};

export default async function Page({ params, searchParams }: PageProps) {
  const token = (await cookies()).get("cv_admin")?.value;
  if (!token) redirect("/login");

  const authResponse = await fetch(`${SERVER_URL}/api/admin/me`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!authResponse.ok) redirect("/login");

  const [{ id }, query] = await Promise.all([params, searchParams]);
  const source = Array.isArray(query.from) ? query.from[0] : query.from;
  const returnTo =
    source === "approvals"
      ? "/approvals"
      : source === "pending-approvals"
        ? "/pending-approvals"
        : "/reports";

  return (
    <AdminNavbarV2>
      <ReportDataPage reportId={id} returnTo={returnTo} pvOnly />
    </AdminNavbarV2>
  );
}
