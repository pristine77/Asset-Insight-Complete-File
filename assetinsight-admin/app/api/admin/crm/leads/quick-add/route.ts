import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export async function POST(request: NextRequest) {
  return proxyJsonWithAdminAuth(request, "/api/crm/admin/leads/quick-add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: await request.text(),
  });
}
