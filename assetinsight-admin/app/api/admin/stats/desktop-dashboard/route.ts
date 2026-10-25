import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export async function GET(request: NextRequest) {
  const query = request.nextUrl.searchParams.toString();
  const suffix = query ? `?${query}` : "";
  return proxyJsonWithAdminAuth(request, `/api/admin/stats/desktop-dashboard${suffix}`, { method: "GET" });
}
