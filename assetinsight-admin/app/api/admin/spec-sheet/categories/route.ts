import { type NextRequest } from "next/server";
import { proxyJsonWithAdminAuth } from "@/lib/adminProxy";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const qs = url.search ? url.search : "";
  return proxyJsonWithAdminAuth(request, `/api/admin/spec-sheet/categories${qs}`);
}

export async function POST(request: NextRequest) {
  const body = await request.text();
  return proxyJsonWithAdminAuth(request, "/api/admin/spec-sheet/categories", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}
