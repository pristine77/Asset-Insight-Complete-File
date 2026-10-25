import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export async function GET(request: NextRequest) {
  return proxyJsonWithAdminAuth(request, "/api/admin/device-security-settings", {
    method: "GET",
  });
}

export async function PATCH(request: NextRequest) {
  return proxyJsonWithAdminAuth(request, "/api/admin/device-security-settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: await request.text(),
  });
}
