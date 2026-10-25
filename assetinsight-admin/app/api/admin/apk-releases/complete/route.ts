import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export async function POST(request: NextRequest) {
  const body = await request.text();
  return proxyJsonWithAdminAuth(request, "/api/admin/apk-releases/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}
