import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export async function GET(request: NextRequest) {
  const qs = new URL(request.url).search;
  return proxyJsonWithAdminAuth(request, `/api/crm/admin/users${qs}`, { method: "GET" });
}
