import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const query = request.nextUrl.searchParams.toString();
  const suffix = query ? `?${query}` : "";
  return proxyJsonWithAdminAuth(request, `/api/admin/stats/performance/users/${id}${suffix}`, { method: "GET" });
}
