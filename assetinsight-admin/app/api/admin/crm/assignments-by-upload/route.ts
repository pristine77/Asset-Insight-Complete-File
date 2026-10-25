import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export async function GET(request: NextRequest) {
  return proxyJsonWithAdminAuth(request, `/api/crm/admin/assignments-by-upload`, {
    method: "GET",
  });
}
