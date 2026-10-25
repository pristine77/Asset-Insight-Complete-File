import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export async function GET(request: NextRequest) {
  const qs = request.nextUrl.search || "";
  return proxyJsonWithAdminAuth(request, `/api/crm/admin/revenue-radar${qs}`, {
    method: "GET",
  });
}
