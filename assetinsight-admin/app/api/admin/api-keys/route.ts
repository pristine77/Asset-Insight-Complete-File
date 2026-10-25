import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export async function GET(request: NextRequest) {
  return proxyJsonWithAdminAuth(request, "/api/admin/api-keys", {
    method: "GET",
  });
}

export async function POST(request: NextRequest) {
  const body = await request.text();
  return proxyJsonWithAdminAuth(request, "/api/admin/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}
