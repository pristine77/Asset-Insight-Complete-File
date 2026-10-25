import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.toString();
  return proxyJsonWithAdminAuth(
    request,
    `/api/admin/reports/same-contract${query ? `?${query}` : ""}`
  );
}
