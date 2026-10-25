import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export async function GET(request: NextRequest) {
  return proxyJsonWithAdminAuth(request, `/api/admin/stats/monthly`, { method: "GET" });
}
