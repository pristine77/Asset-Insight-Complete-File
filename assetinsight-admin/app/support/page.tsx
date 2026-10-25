import AdminNavbarV2 from "@/app/components/common/AdminNavbarV2";
import { SupportInbox } from "@/app/components/support/SupportInbox";
import { SERVER_URL } from "@/lib/api";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export default async function SupportPage({
  searchParams,
}: {
  searchParams: Promise<{ request?: string | string[] }>;
}) {
  const params = await searchParams;
  const token = (await cookies()).get("cv_admin")?.value;
  if (!token) redirect("/login");

  const response = await fetch(`${SERVER_URL}/api/admin/me`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!response.ok) redirect("/login");
  const payload: { user?: { role?: string } } = await response.json().catch(() => ({}));
  if (payload.user?.role !== "admin" && payload.user?.role !== "superadmin") redirect("/reports");

  const rawRequest = Array.isArray(params.request) ? params.request[0] : params.request;
  const request = rawRequest && /^[a-f\d]{24}$/i.test(rawRequest) ? rawRequest : null;

  return (
    <AdminNavbarV2>
      <SupportInbox initialRequest={request} />
    </AdminNavbarV2>
  );
}
