import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export async function GET(request: NextRequest) {
  return proxyJsonWithAdminAuth(request, "/api/admin/spec-web-search", {
    method: "GET",
  });
}

export async function PATCH(request: NextRequest) {
  const body = await request.text();
  return proxyJsonWithAdminAuth(request, "/api/admin/spec-web-search", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body,
  });
}
